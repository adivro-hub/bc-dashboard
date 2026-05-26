/* GET /api/income-bundle?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Aggregates the six Neon income_structure_* mirror tables into the
 * "sections" shape that dashboard.js consumes today (donut + bar charts
 * keyed by category name).
 *
 * Response:
 *   {
 *     period_from, period_to,
 *     sections: {
 *       sales:          { "Sales with VAT": { jobs, without_vat, vat, total, earnings }, ... },
 *       payment_type:   { "Cash": {...}, ... },
 *       customer_grade: { "Corporate": {...}, ... },
 *       service:        { "BlackCab": {...}, ... },
 *       fleet:          { "Bucharest BlackCab CS Fleet": {...}, ... },
 *       driver_hours:   { "Bucharest BlackCab CS Fleet": { hours }, ... }
 *     },
 *     kpis: { jobs, without_vat, vat, total, earnings, avg_per_job }
 *   }
 */
import { query, ok, bad, parseDateRange, requireAuth } from './_db.js';

const SECTION_MAP = [
  { table: 'income_structure_vat',          key: 'sales',          label: 'Sales'       },
  { table: 'income_structure_payment_type', key: 'payment_type',   label: 'PaymentType' },
  { table: 'income_structure_grade',        key: 'customer_grade', label: 'Grade'       },
  { table: 'income_structure_service',      key: 'service',        label: 'Service'     },
  { table: 'income_structure_fleet',        key: 'fleet',          label: 'Fleet'       },
];

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;

  let from, to;
  try { ({ from, to } = parseDateRange(req)); }
  catch (e) { return bad(res, 400, e.message); }

  try {
    // For each category view: SUM the 5 measures per category label,
    // restricted to the date window. The source views emit a literal
    // "Total" row per day that's a pre-computed rollup of the other
    // categories — excluding it here prevents the dashboard from both
    // (a) rendering a redundant "Total" bar/donut slice and (b)
    // double-counting in the KPI sum below.
    const sections = {};
    for (const { table, key, label } of SECTION_MAP) {
      const rows = await query(
        `SELECT "${label}" AS k,
                COALESCE(SUM("Jobs"),       0)::float AS jobs,
                COALESCE(SUM("WithoutTax"), 0)::float AS without_vat,
                COALESCE(SUM("Tax"),        0)::float AS vat,
                COALESCE(SUM("Total"),      0)::float AS total,
                COALESCE(SUM("Earnings"),   0)::float AS earnings
           FROM ${table}
          WHERE "Date" BETWEEN $1::date AND $2::date
            AND "${label}" IS NOT NULL
            AND lower(trim("${label}")) <> 'total'
          GROUP BY "${label}"
          ORDER BY "${label}"`,
        [from, to]
      );
      const bucket = {};
      for (const r of rows) {
        if (!r.k) continue;
        bucket[r.k] = {
          jobs: r.jobs,
          without_vat: r.without_vat,
          vat: r.vat,
          total: r.total,
          earnings: r.earnings,
        };
      }
      sections[key] = bucket;
    }

    // driver_hours = fleet-keyed login_time totals (no Tax/Earnings cols).
    // Skip any "Total" rollup row for the same reason as above.
    const hourRows = await query(
      `SELECT "Fleet" AS k, COALESCE(SUM("Hours"), 0)::float AS hours
         FROM income_structure_login_time
        WHERE "Date" BETWEEN $1::date AND $2::date
          AND "Fleet" IS NOT NULL
          AND lower(trim("Fleet")) <> 'total'
        GROUP BY "Fleet"
        ORDER BY "Fleet"`,
      [from, to]
    );
    // Driver-hours items need BOTH a `.jobs` and `.hours` field set to
    // the hours total. The legacy XLS pipeline reused the "jobs" slot
    // for the hours number (column-position reuse in the source XLS),
    // so the bar/table widget reads `.jobs` while the hours-per-job
    // computation reads `.hours`. Setting both keeps every consumer
    // happy without touching dashboard.js. Other metric slots stay 0
    // so any rendering that sums them doesn't break.
    const driver_hours = {};
    for (const r of hourRows) {
      if (!r.k) continue;
      driver_hours[r.k] = {
        jobs:        r.hours,
        hours:       r.hours,
        without_vat: 0,
        vat:         0,
        total:       0,
        earnings:    0,
      };
    }
    sections.driver_hours = driver_hours;

    // KPIs roll-up = sum across the Sales (VAT) view's rows, with the
    // "Total" rollup row excluded so we don't double-count.
    const [kpiRow] = await query(
      `SELECT COALESCE(SUM("Jobs"),       0)::float AS jobs,
              COALESCE(SUM("WithoutTax"), 0)::float AS without_vat,
              COALESCE(SUM("Tax"),        0)::float AS vat,
              COALESCE(SUM("Total"),      0)::float AS total,
              COALESCE(SUM("Earnings"),   0)::float AS earnings
         FROM income_structure_vat
        WHERE "Date" BETWEEN $1::date AND $2::date
          AND "Sales" IS NOT NULL
          AND lower(trim("Sales")) <> 'total'`,
      [from, to]
    );
    const kpis = {
      jobs:        kpiRow.jobs,
      without_vat: kpiRow.without_vat,
      vat:         kpiRow.vat,
      total:       kpiRow.total,
      earnings:    kpiRow.earnings,
      avg_per_job: kpiRow.jobs > 0 ? kpiRow.total / kpiRow.jobs : 0,
    };

    ok(res, {
      period_from: from,
      period_to:   to,
      sections,
      kpis,
    }, { cache: 'public, max-age=60, must-revalidate' });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'income-bundle query failed');
  }
}
