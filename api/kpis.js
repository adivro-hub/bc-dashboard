/* GET /api/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Mirrors build_kpis.py's compute_week, restricted to KPIs that can be
 * derived from job_analogue alone. The hours-based KPIs (#1, #2, #4, #5)
 * are returned as null until the Hour Statistics view is wired up.
 *
 * Response:
 *   {
 *     range: { from, to, days },
 *     bookings: { total, done, cancelled, fulfilment_rate_pct },
 *     vehicles: { unique_active },
 *     supply:   { no_supply_cancels, no_supply_pct_of_cancel },
 *     pickup_time: { asap_done_jobs, avg_min, median_min },
 *     revenue:  { total_price, driver_price, gross_commission, monthly_run_rate },
 *     hours:    null   // populated once Hour Statistics lands
 *   }
 */
import { query, ok, bad, parseDateRange, requireAuth } from './_db.js';

const SUPPLY_REGEX =
  '(no cars available|serviciul .*indisponibil|nicio ma[sș]in[aă]|nu vrea sa astepte|sofer de la bv)';

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!requireAuth(req, res)) return;
  let from, to;
  try {
    ({ from, to } = parseDateRange(req));
  } catch (e) {
    return bad(res, 400, e.message);
  }

  try {
    // One big query to minimise round-trips. Aggregates over the range.
    const [row] = await query(
      `WITH window_rows AS (
         SELECT * FROM job_analogue
         WHERE job_date BETWEEN $1::date AND $2::date
       ),
       d AS (SELECT * FROM window_rows WHERE status = 'DONE'),
       c AS (SELECT * FROM window_rows WHERE status = 'CANCELLED'),
       asap AS (SELECT * FROM d WHERE upper(urgency) = 'ASAP'
                                  AND response_time IS NOT NULL),
       supply AS (SELECT * FROM c WHERE cancel_reason ~* $3)
       SELECT
         (SELECT COUNT(*) FROM window_rows)::int                        AS total_bookings,
         (SELECT COUNT(*) FROM d)::int                                   AS done_jobs,
         (SELECT COUNT(*) FROM c)::int                                   AS cancelled_jobs,
         (SELECT COUNT(DISTINCT vehicle_reg_number) FROM d
            WHERE vehicle_reg_number IS NOT NULL AND vehicle_reg_number <> '')::int AS unique_active_vehicles,
         (SELECT COUNT(*) FROM supply)::int                              AS no_supply_cancels,
         (SELECT COUNT(*) FROM asap)::int                                AS asap_done_jobs,
         (SELECT EXTRACT(EPOCH FROM AVG(response_time))/60.0 FROM asap)::float AS avg_pickup_min,
         (SELECT EXTRACT(EPOCH FROM PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time))/60.0 FROM asap)::float AS median_pickup_min,
         (SELECT COALESCE(SUM(total_price), 0)        FROM d)::float     AS total_price,
         (SELECT COALESCE(SUM(driver_total_price), 0) FROM d)::float     AS driver_price`,
      [from, to, SUPPLY_REGEX]
    );

    const totalCancel = row.cancelled_jobs;
    const fulfilment = row.done_jobs + totalCancel
      ? (row.done_jobs / (row.done_jobs + totalCancel)) * 100
      : 0;
    const noSupplyPct = totalCancel ? (row.no_supply_cancels / totalCancel) * 100 : 0;
    const grossCommission = row.total_price - row.driver_price;

    // Days in range — used for the monthly run-rate normalisation.
    const days = Math.max(
      1,
      Math.round((new Date(to) - new Date(from)) / 86_400_000) + 1
    );
    const monthlyRunRate = grossCommission * (30.4375 / days);

    ok(res, {
      range: { from, to, days },
      bookings: {
        total: row.total_bookings,
        done: row.done_jobs,
        cancelled: row.cancelled_jobs,
        fulfilment_rate_pct: fulfilment,
      },
      vehicles: { unique_active: row.unique_active_vehicles },
      supply: {
        no_supply_cancels: row.no_supply_cancels,
        no_supply_pct_of_cancel: noSupplyPct,
      },
      pickup_time: {
        asap_done_jobs: row.asap_done_jobs,
        avg_min: row.avg_pickup_min,
        median_min: row.median_pickup_min,
      },
      revenue: {
        total_price: row.total_price,
        driver_price: row.driver_price,
        gross_commission: grossCommission,
        monthly_run_rate: monthlyRunRate,
      },
      hours: null, // pending hour_statistics ingestion
    }, { cache: 'public, max-age=60, must-revalidate' });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'query failed');
  }
}
