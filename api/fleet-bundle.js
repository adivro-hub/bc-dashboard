/* GET /api/fleet-bundle?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Aggregated KPIs for a small whitelist of fleets in a single round trip:
 *
 *   {
 *     "Bucharest BlackCab Fleet": {
 *       jobs, hours, sales, earnings, unique_vehicles
 *     },
 *     "Bucharest Select Fleet": { ... },
 *     ...
 *   }
 *
 * Numbers come from two sources:
 *
 *   * jobs / sales / earnings / hours -> income_structure_fleet +
 *     income_structure_login_time (the daily roll-ups). Authoritative
 *     because that's how the operator's own reporting attributes a job
 *     to a fleet.
 *
 *   * unique_vehicles -> COUNT(DISTINCT vehicle_reg_number) on
 *     job_analogue, restricted by service. job_analogue has no `fleet`
 *     column, so service is used as a proxy:
 *         BlackCab Fleet  <- service IN ('BlackCab', 'BlackCab 7')
 *         Select Fleet    <- service =  'Select'
 *     Tagged `unique_vehicles_proxy` in the response so consumers know it's
 *     an approximation.
 */
import { query, ok, bad, parseDateRange, requireAuth } from './_db.js';

const FLEETS = [
  {
    name: 'Bucharest BlackCab Fleet',
    services: ['BlackCab', 'BlackCab 7'],
  },
  {
    name: 'Bucharest Select Fleet',
    services: ['Select'],
  },
];

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;

  let from, to;
  try { ({ from, to } = parseDateRange(req)); }
  catch (e) { return bad(res, 400, e.message); }

  try {
    // 1) Fleet-keyed jobs/sales/earnings from income_structure_fleet.
    const fleetRows = await query(
      `SELECT "Fleet" AS k,
              COALESCE(SUM("Jobs"),    0)::float AS jobs,
              COALESCE(SUM("Total"),   0)::float AS total,
              COALESCE(SUM("Earnings"),0)::float AS earnings
         FROM income_structure_fleet
        WHERE "Date" BETWEEN $1::date AND $2::date
          AND "Fleet" IS NOT NULL
          AND lower(trim("Fleet")) <> 'total'
          AND "Fleet" = ANY($3::text[])
        GROUP BY "Fleet"`,
      [from, to, FLEETS.map(f => f.name)]
    );

    // 2) Login hours from income_structure_login_time.
    const hourRows = await query(
      `SELECT "Fleet" AS k,
              COALESCE(SUM("Hours"), 0)::float AS hours
         FROM income_structure_login_time
        WHERE "Date" BETWEEN $1::date AND $2::date
          AND "Fleet" = ANY($2::text[])
        GROUP BY "Fleet"`,
      [from, to, FLEETS.map(f => f.name)]
    ).catch(async () => {
      // Older deploys might have had different param ordering; do it positional.
      return query(
        `SELECT "Fleet" AS k,
                COALESCE(SUM("Hours"), 0)::float AS hours
           FROM income_structure_login_time
          WHERE "Date" BETWEEN $1::date AND $2::date
            AND "Fleet" = ANY($3::text[])
          GROUP BY "Fleet"`,
        [from, to, FLEETS.map(f => f.name)]
      );
    });

    // 3) Unique vehicles per fleet (proxy via service whitelist).
    // We run one job_analogue query per fleet so the IN-list is small and
    // the planner can use an index on (job_date, service).
    const vehicleByFleet = {};
    await Promise.all(FLEETS.map(async f => {
      const rows = await query(
        `SELECT COUNT(DISTINCT vehicle_reg_number)::int AS n
           FROM job_analogue
          WHERE job_date BETWEEN $1::date AND $2::date
            AND service = ANY($3::text[])
            AND vehicle_reg_number IS NOT NULL
            AND trim(vehicle_reg_number) <> ''`,
        [from, to, f.services]
      );
      vehicleByFleet[f.name] = rows[0]?.n || 0;
    }));

    // Stitch it all together. Fleets the user asked for that don't appear
    // in income_structure_fleet still get zeroed entries so the UI can
    // render a row.
    const result = {};
    const fleetMap = new Map(fleetRows.map(r => [r.k, r]));
    const hourMap  = new Map(hourRows.map(r => [r.k, r]));
    for (const f of FLEETS) {
      const fr = fleetMap.get(f.name);
      const hr = hourMap.get(f.name);
      const jobs = fr?.jobs || 0;
      const hours = hr?.hours || 0;
      result[f.name] = {
        jobs,
        hours,
        sales:    fr?.total    || 0,
        earnings: fr?.earnings || 0,
        hours_per_ride:    jobs > 0 ? hours / jobs : null,
        unique_vehicles:   vehicleByFleet[f.name] || 0,
        unique_vehicles_proxy: true,
        proxy_services: f.services,
      };
    }

    ok(res, {
      from, to,
      fleets: result,
    });
  } catch (e) {
    console.error('fleet-bundle error', e);
    bad(res, 500, e.message);
  }
}
