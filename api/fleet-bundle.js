/* GET /api/fleet-bundle?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Aggregated KPIs for a whitelist of fleets in a single round trip:
 *
 *   {
 *     "Bucharest BlackCab Fleet": { jobs, hours, sales, earnings, unique_vehicles, ... },
 *     "Bucharest Select Fleet":   { ... },
 *     "Bucharest (total)":        { ... },
 *   }
 *
 * Numbers come from two sources:
 *
 *   * jobs / sales / earnings / hours -> income_structure_fleet +
 *     income_structure_login_time (the daily roll-ups). Authoritative.
 *
 *   * unique_vehicles -> COUNT(DISTINCT vehicle_reg_number) on
 *     job_analogue. job_analogue has no `fleet` column, so:
 *         BlackCab Fleet  <- service IN ('BlackCab', 'BlackCab 7')
 *         Select Fleet    <- service =  'Select'
 *         Bucharest total <- pick_up_city LIKE 'Bucharest%'
 *     Tagged `unique_vehicles_proxy:true` in the response so the UI
 *     can mark these cells as approximate.
 */
import { query, ok, bad, parseDateRange, requireAuth } from './_db.js';

// Each entry:
//   match.kind = 'exact' | 'pattern'   — for income_structure_fleet/login_time
//   match.value                        — fleet name or LIKE pattern
//   vehicles.kind = 'services' | 'city' — for job_analogue lookup
//   vehicles.value                     — array of services or city LIKE pattern
const FLEETS = [
  {
    name: 'Bucharest BlackCab Fleet',
    match:    { kind: 'exact',   value: 'Bucharest BlackCab Fleet' },
    vehicles: { kind: 'services', value: ['BlackCab', 'BlackCab 7'] },
  },
  {
    name: 'Bucharest Select Fleet',
    match:    { kind: 'exact',    value: 'Bucharest Select Fleet' },
    vehicles: { kind: 'services', value: ['Select'] },
  },
  {
    name: 'Bucharest (total)',
    match:    { kind: 'pattern', value: 'Bucharest%' },
    vehicles: { kind: 'city',    value: 'Bucharest%' },
    is_total: true,
  },
];

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;

  let from, to;
  try { ({ from, to } = parseDateRange(req)); }
  catch (e) { return bad(res, 400, e.message); }

  try {
    const result = {};
    await Promise.all(FLEETS.map(async f => {
      // 1. Sales / jobs / earnings from income_structure_fleet
      const fleetSql = f.match.kind === 'exact'
        ? `SELECT COALESCE(SUM("Jobs"),0)::float    AS jobs,
                  COALESCE(SUM("Total"),0)::float   AS total,
                  COALESCE(SUM("Earnings"),0)::float AS earnings
             FROM income_structure_fleet
            WHERE "Date" BETWEEN $1::date AND $2::date
              AND "Fleet" = $3
              AND lower(trim("Fleet")) <> 'total'`
        : `SELECT COALESCE(SUM("Jobs"),0)::float    AS jobs,
                  COALESCE(SUM("Total"),0)::float   AS total,
                  COALESCE(SUM("Earnings"),0)::float AS earnings
             FROM income_structure_fleet
            WHERE "Date" BETWEEN $1::date AND $2::date
              AND "Fleet" LIKE $3
              AND lower(trim("Fleet")) <> 'total'`;
      const [fleetRow] = await query(fleetSql, [from, to, f.match.value]);

      // 2. Login hours from income_structure_login_time
      const hourSql = f.match.kind === 'exact'
        ? `SELECT COALESCE(SUM("Hours"),0)::float AS hours
             FROM income_structure_login_time
            WHERE "Date" BETWEEN $1::date AND $2::date
              AND "Fleet" = $3`
        : `SELECT COALESCE(SUM("Hours"),0)::float AS hours
             FROM income_structure_login_time
            WHERE "Date" BETWEEN $1::date AND $2::date
              AND "Fleet" LIKE $3`;
      const [hourRow] = await query(hourSql, [from, to, f.match.value]);

      // 3. Unique vehicles via job_analogue (proxy)
      const vSql = f.vehicles.kind === 'services'
        ? `SELECT COUNT(DISTINCT vehicle_reg_number)::int AS n
             FROM job_analogue
            WHERE job_date BETWEEN $1::date AND $2::date
              AND service = ANY($3::text[])
              AND vehicle_reg_number IS NOT NULL
              AND trim(vehicle_reg_number) <> ''`
        : `SELECT COUNT(DISTINCT vehicle_reg_number)::int AS n
             FROM job_analogue
            WHERE job_date BETWEEN $1::date AND $2::date
              AND pick_up_city ILIKE $3
              AND vehicle_reg_number IS NOT NULL
              AND trim(vehicle_reg_number) <> ''`;
      const [vRow] = await query(vSql, [from, to, f.vehicles.value]);

      const jobs  = fleetRow?.jobs    || 0;
      const hours = hourRow?.hours    || 0;
      result[f.name] = {
        jobs,
        hours,
        sales:    fleetRow?.total    || 0,
        earnings: fleetRow?.earnings || 0,
        hours_per_ride:  jobs > 0 ? hours / jobs : null,
        unique_vehicles: vRow?.n     || 0,
        unique_vehicles_proxy: true,
        is_total: !!f.is_total,
        // Surface the proxy criteria so the UI tooltip can explain
        proxy_services: f.vehicles.kind === 'services' ? f.vehicles.value : null,
        proxy_city:     f.vehicles.kind === 'city'     ? f.vehicles.value : null,
      };
    }));

    ok(res, { from, to, fleets: result });
  } catch (e) {
    console.error('fleet-bundle error', e);
    bad(res, 500, e.message);
  }
}
