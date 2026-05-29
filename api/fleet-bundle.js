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

// Same regex as api/kpis.js — matches both EN and RO no-supply cancel reasons.
const NO_SUPPLY_REGEX =
  '(no cars available|serviciul .*indisponibil|nicio ma[sș]in[aă]|nu vrea sa astepte|sofer de la bv)';

// Bucharest + Ilfov county localities served by the Bucharest fleet.
// pick_up_city in job_analogue gets matched against this list with ILIKE +
// trim, so it survives 'Sector 1', 'Otopeni, Ilfov', accents, etc.
// Services operated by the Bucharest fleets — used as the cross-job_analogue
// proxy for the Bucharest total card. If a new service rolls out (e.g.
// 'Electric'), add it here and the Bucharest total picks it up automatically.
const BUCHAREST_FLEET_SERVICES = [
  'BlackCab', 'BlackCab 7',
  'Select',
  'Elite',
  'ChildSeat', 'KidsCab',
  'iDrive Your Car',
  'MailCab',
  'Shuttle Bus',
];

const BUCHAREST_AREA_CITIES = [
  // Bucharest itself (any sector / variation)
  'Bucharest', 'București', 'Bucuresti',
  // Ilfov county catch-all
  'Ilfov',
  // Towns and communes in Ilfov
  'Otopeni', 'Voluntari', 'Pipera', 'Mogoșoaia', 'Mogosoaia',
  'Buftea', 'Snagov', 'Chitila', 'Pantelimon', 'Popești-Leordeni',
  'Popesti-Leordeni', 'Bragadiru', 'Chiajna', 'Jilava', 'Tunari',
  'Cernica', 'Dobroești', 'Dobroesti', 'Glina', 'Afumați', 'Afumati',
  'Balotești', 'Balotesti', 'Brănești', 'Branesti', 'Corbeanca',
  'Domnești', 'Domnesti', 'Măgurele', 'Magurele', 'Ștefănești',
  'Stefanesti', 'Clinceni', 'Cornetu', 'Berceni', 'Vidra', 'Periș',
  'Peris', '1 Decembrie', 'Băneasa', 'Baneasa',
];

// Each entry:
//   match.kind = 'exact' | 'pattern'   — for income_structure_fleet/login_time
//   match.value                        — fleet name or LIKE pattern
//   vehicles.kind = 'services' | 'city' — for job_analogue lookup
//   vehicles.value                     — array of services or city LIKE pattern
const FLEETS = [
  {
    // Headline card — always rendered first. Union of all Bucharest-
    // prefixed fleets, with the cross-job_analogue proxy widened to the
    // full whitelist of services the Bucharest fleets operate. Catches
    // out-of-Bucharest rides done by Bucharest-fleet vehicles (Constanța,
    // Brașov runs, Otopeni airport rides regardless of how the city is
    // labelled, etc.) at the cost of also catching any non-Bucharest
    // operations on those services (if any exist in the data).
    name: 'Bucharest fleet (total)',
    match:    { kind: 'pattern',   value: 'Bucharest%' },
    vehicles: { kind: 'services',  value: BUCHAREST_FLEET_SERVICES },
    is_total: true,
  },
  {
    // Bucharest BlackCab Fleet + Bucharest BlackCab CS Fleet rolled up.
    name: 'Bucharest BlackCab',
    match:    { kind: 'pattern', value: 'Bucharest BlackCab%' },
    vehicles: { kind: 'services', value: ['BlackCab', 'BlackCab 7'] },
  },
  {
    // Bucharest Select Fleet + Bucharest Select CS Fleet rolled up.
    name: 'Bucharest Select',
    match:    { kind: 'pattern', value: 'Bucharest Select%' },
    vehicles: { kind: 'services', value: ['Select'] },
  },
];

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;

  let from, to;
  try { ({ from, to } = parseDateRange(req)); }
  catch (e) { return bad(res, 400, e.message); }

  try {
    // Collect each fleet's payload as a [name, data] pair via Promise.all,
    // then Object.fromEntries — preserves FLEETS[] order in the response
    // (Object.fromEntries respects iteration order). Just assigning into
    // a shared object inside the .map callback used insertion-by-completion
    // order, which let the Total card sometimes appear after BlackCab/Select.
    const entries = await Promise.all(FLEETS.map(async f => {
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

      // 3. Unique vehicles + their cross-service activity. status='DONE' on
      // every count so a driver that only picked-and-cancelled doesn't show
      // up. Uses a CTE to first find the fleet vehicles, then probe what
      // OTHER rides those exact vehicles did in the same period.
      let vSql, vParams;
      if (f.vehicles.kind === 'services') {
        vSql = `
          WITH fleet_vehicles AS (
            SELECT DISTINCT vehicle_reg_number
              FROM job_analogue
             WHERE job_date BETWEEN $1::date AND $2::date
               AND status = 'DONE'
               AND service = ANY($3::text[])
               AND vehicle_reg_number IS NOT NULL
               AND trim(vehicle_reg_number) <> ''
          )
          SELECT
            (SELECT COUNT(*)::int FROM fleet_vehicles) AS unique_n,
            -- Total DONE rides by these vehicles across ALL services
            (SELECT COUNT(*)::int FROM job_analogue ja
               JOIN fleet_vehicles fv USING (vehicle_reg_number)
              WHERE ja.job_date BETWEEN $1::date AND $2::date
                AND ja.status = 'DONE') AS total_rides_n,
            -- Of these vehicles, how many also did rides OUTSIDE the whitelist
            (SELECT COUNT(DISTINCT ja.vehicle_reg_number)::int FROM job_analogue ja
               JOIN fleet_vehicles fv USING (vehicle_reg_number)
              WHERE ja.job_date BETWEEN $1::date AND $2::date
                AND ja.status = 'DONE'
                AND NOT (ja.service = ANY($3::text[]))) AS cross_fleet_vehicles_n,
            -- Cross-fleet ride count (their DONE rides on services outside the whitelist)
            (SELECT COUNT(*)::int FROM job_analogue ja
               JOIN fleet_vehicles fv USING (vehicle_reg_number)
              WHERE ja.job_date BETWEEN $1::date AND $2::date
                AND ja.status = 'DONE'
                AND NOT (ja.service = ANY($3::text[]))) AS cross_fleet_rides_n`;
        vParams = [from, to, f.vehicles.value];
      } else if (f.vehicles.kind === 'city_list') {
        vSql = `
          WITH fleet_vehicles AS (
            SELECT DISTINCT vehicle_reg_number
              FROM job_analogue
             WHERE job_date BETWEEN $1::date AND $2::date
               AND status = 'DONE'
               AND lower(trim(pick_up_city)) = ANY($3::text[])
               AND vehicle_reg_number IS NOT NULL
               AND trim(vehicle_reg_number) <> ''
          )
          SELECT
            (SELECT COUNT(*)::int FROM fleet_vehicles) AS unique_n,
            (SELECT COUNT(*)::int FROM job_analogue ja
               JOIN fleet_vehicles fv USING (vehicle_reg_number)
              WHERE ja.job_date BETWEEN $1::date AND $2::date
                AND ja.status = 'DONE') AS total_rides_n,
            -- For the city-based total card, 'cross-fleet' = rides outside Bucharest+Ilfov
            (SELECT COUNT(DISTINCT ja.vehicle_reg_number)::int FROM job_analogue ja
               JOIN fleet_vehicles fv USING (vehicle_reg_number)
              WHERE ja.job_date BETWEEN $1::date AND $2::date
                AND ja.status = 'DONE'
                AND NOT (lower(trim(ja.pick_up_city)) = ANY($3::text[]))) AS cross_fleet_vehicles_n,
            (SELECT COUNT(*)::int FROM job_analogue ja
               JOIN fleet_vehicles fv USING (vehicle_reg_number)
              WHERE ja.job_date BETWEEN $1::date AND $2::date
                AND ja.status = 'DONE'
                AND NOT (lower(trim(ja.pick_up_city)) = ANY($3::text[]))) AS cross_fleet_rides_n`;
        vParams = [from, to, f.vehicles.value.map(s => s.toLowerCase().trim())];
      } else {
        vSql = `
          WITH fleet_vehicles AS (
            SELECT DISTINCT vehicle_reg_number
              FROM job_analogue
             WHERE job_date BETWEEN $1::date AND $2::date
               AND status = 'DONE'
               AND pick_up_city ILIKE $3
               AND vehicle_reg_number IS NOT NULL
               AND trim(vehicle_reg_number) <> ''
          )
          SELECT
            (SELECT COUNT(*)::int FROM fleet_vehicles) AS unique_n,
            (SELECT COUNT(*)::int FROM job_analogue ja
               JOIN fleet_vehicles fv USING (vehicle_reg_number)
              WHERE ja.job_date BETWEEN $1::date AND $2::date
                AND ja.status = 'DONE') AS total_rides_n,
            0::int AS cross_fleet_vehicles_n,
            0::int AS cross_fleet_rides_n`;
        vParams = [from, to, f.vehicles.value];
      }
      const [vRow] = await query(vSql, vParams);

      // 4. Avg ON-WAY time (minutes) split by urgency, restricted to DONE
      // jobs with a non-null on_way_time. This is the time the driver
      // spent driving toward the pickup AFTER accepting the job — not
      // booking-to-acceptance. Same fleet proxy as unique_vehicles.
      let rtSql, rtParams;
      const rtBase = `
        SELECT upper(urgency) AS urg,
               EXTRACT(EPOCH FROM AVG(on_way_time))/60.0         AS avg_min,
               EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5)
                 WITHIN GROUP (ORDER BY on_way_time))/60.0       AS median_min,
               COUNT(*)::int                                     AS n
          FROM job_analogue
         WHERE job_date BETWEEN $1::date AND $2::date
           AND status = 'DONE'
           AND on_way_time IS NOT NULL
           AND on_way_time > INTERVAL '0'
           AND upper(urgency) IN ('ASAP','PREBOOK')`;
      if (f.vehicles.kind === 'services') {
        rtSql = rtBase + ` AND service = ANY($3::text[]) GROUP BY upper(urgency)`;
        rtParams = [from, to, f.vehicles.value];
      } else if (f.vehicles.kind === 'city_list') {
        rtSql = rtBase + ` AND lower(trim(pick_up_city)) = ANY($3::text[]) GROUP BY upper(urgency)`;
        rtParams = [from, to, f.vehicles.value.map(s => s.toLowerCase().trim())];
      } else {
        rtSql = rtBase + ` AND pick_up_city ILIKE $3 GROUP BY upper(urgency)`;
        rtParams = [from, to, f.vehicles.value];
      }
      const rtRows = await query(rtSql, rtParams);
      const byUrg = Object.fromEntries(rtRows.map(r => [r.urg, r]));

      // 5. Cancellation diagnostics: total bookings, DONE, CANCELLED, and
      // the subset of cancellations attributable to lack of supply.
      // Cancellation rate uses ALL bookings as denominator (out of total).
      // Same fleet proxy as elsewhere.
      let cancelSql, cancelParams;
      const cancelBase = `
        SELECT
          COUNT(*)::int                                                        AS total_n,
          COUNT(*) FILTER (WHERE status = 'DONE')::int                         AS done_n,
          COUNT(*) FILTER (WHERE status = 'CANCELLED')::int                    AS cancel_n,
          COUNT(*) FILTER (WHERE status = 'CANCELLED' AND cancel_reason ~* $4)::int AS no_supply_n,
          COUNT(*) FILTER (WHERE upper(urgency) = 'ASAP')::int                                AS asap_total_n,
          COUNT(*) FILTER (WHERE upper(urgency) = 'ASAP'    AND status = 'CANCELLED')::int     AS asap_cancel_n,
          COUNT(*) FILTER (WHERE upper(urgency) = 'ASAP'    AND status = 'DONE')::int          AS asap_done_n,
          COUNT(*) FILTER (WHERE upper(urgency) = 'PREBOOK')::int                              AS prebook_total_n,
          COUNT(*) FILTER (WHERE upper(urgency) = 'PREBOOK' AND status = 'CANCELLED')::int     AS prebook_cancel_n,
          COUNT(*) FILTER (WHERE upper(urgency) = 'PREBOOK' AND status = 'DONE')::int          AS prebook_done_n
          FROM job_analogue
         WHERE job_date BETWEEN $1::date AND $2::date`;
      if (f.vehicles.kind === 'services') {
        cancelSql = cancelBase + ` AND service = ANY($3::text[])`;
        cancelParams = [from, to, f.vehicles.value, NO_SUPPLY_REGEX];
      } else if (f.vehicles.kind === 'city_list') {
        cancelSql = cancelBase + ` AND lower(trim(pick_up_city)) = ANY($3::text[])`;
        cancelParams = [from, to, f.vehicles.value.map(s => s.toLowerCase().trim()), NO_SUPPLY_REGEX];
      } else {
        cancelSql = cancelBase + ` AND pick_up_city ILIKE $3`;
        cancelParams = [from, to, f.vehicles.value, NO_SUPPLY_REGEX];
      }
      const [cancelRow] = await query(cancelSql, cancelParams);

      const jobs  = fleetRow?.jobs    || 0;
      const hours = hourRow?.hours    || 0;
      return [f.name, {
        jobs,
        hours,
        sales:    fleetRow?.total    || 0,
        earnings: fleetRow?.earnings || 0,
        hours_per_ride:  jobs > 0 ? hours / jobs : null,
        unique_vehicles: vRow?.unique_n || 0,
        unique_vehicles_proxy: true,
        // Total DONE rides by those exact vehicles, across every service —
        // this tells you how busy the fleet's vehicles really were (incl.
        // when they did rides for OTHER fleets too).
        unique_vehicles_total_rides: vRow?.total_rides_n || 0,
        // Of the fleet's vehicles, how many also did rides outside the
        // fleet's whitelist (other services for service-based cards, or
        // outside Bucharest+Ilfov for the city-based total).
        cross_fleet_vehicles: vRow?.cross_fleet_vehicles_n || 0,
        cross_fleet_rides:    vRow?.cross_fleet_rides_n    || 0,
        // New: split response time
        response_time: {
          asap:    byUrg.ASAP    ? { avg_min: byUrg.ASAP.avg_min,    median_min: byUrg.ASAP.median_min,    n: byUrg.ASAP.n }    : null,
          prebook: byUrg.PREBOOK ? { avg_min: byUrg.PREBOOK.avg_min, median_min: byUrg.PREBOOK.median_min, n: byUrg.PREBOOK.n } : null,
        },
        // Diagnostics for correlating volume drops with supply/demand
        total_bookings:      cancelRow?.total_n     || 0,
        done_jobs:           cancelRow?.done_n      || 0,
        cancelled_jobs:      cancelRow?.cancel_n    || 0,
        no_supply_cancels:   cancelRow?.no_supply_n || 0,
        // CANCELLED / total bookings (out of all reservations in the period)
        cancellation_rate:   cancelRow?.total_n > 0
                               ? cancelRow.cancel_n / cancelRow.total_n
                               : null,
        // Split by urgency. PREBOOK bookings cancel at a very different
        // (lower) rate than ASAP requests dispatched on driver availability,
        // so blending them hides the actual story. DONE-counts let the UI
        // split "Service rides" the same way.
        asap_total:          cancelRow?.asap_total_n    || 0,
        asap_cancelled:      cancelRow?.asap_cancel_n   || 0,
        asap_done:           cancelRow?.asap_done_n     || 0,
        cancellation_rate_asap:    cancelRow?.asap_total_n > 0
                                     ? cancelRow.asap_cancel_n / cancelRow.asap_total_n
                                     : null,
        prebook_total:       cancelRow?.prebook_total_n  || 0,
        prebook_cancelled:   cancelRow?.prebook_cancel_n || 0,
        prebook_done:        cancelRow?.prebook_done_n   || 0,
        cancellation_rate_prebook: cancelRow?.prebook_total_n > 0
                                     ? cancelRow.prebook_cancel_n / cancelRow.prebook_total_n
                                     : null,
        is_total: !!f.is_total,
        // Surface the proxy criteria so the UI tooltip can explain
        proxy_services: f.vehicles.kind === 'services'  ? f.vehicles.value : null,
        proxy_city:     f.vehicles.kind === 'city'      ? f.vehicles.value : null,
        proxy_cities:   f.vehicles.kind === 'city_list' ? f.vehicles.value : null,
      }];
    }));
    const result = Object.fromEntries(entries);

    ok(res, { from, to, fleets: result });
  } catch (e) {
    console.error('fleet-bundle error', e);
    bad(res, 500, e.message);
  }
}
