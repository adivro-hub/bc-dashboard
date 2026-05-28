/* GET /api/clients/ltv
 *
 * Lifetime Value for Public-account (110000) retail clients, sliced into
 * 30-day / 90-day / 180-day post-registration windows. Data comes from
 * the materialised client_ltv table refreshed nightly.
 *
 * Query params:
 *   min_rides       (default 1)            filter on rides_180d OR fallback rides_30d
 *   registered_from (YYYY-MM-DD optional)
 *   registered_to   (YYYY-MM-DD optional)
 *   mature_only     ('true'|'false'; default false) — only mature_180d clients
 *   order_by        ltv_180d | ltv_90d | ltv_30d | total_earn_all | registered_at  (default ltv_180d)
 *   order_dir       desc|asc (default desc)
 *   limit           default 50, max 500
 *   offset          default 0
 *
 * Response:
 *   {
 *     summary: {
 *       total_clients, mature_180d_clients, match_rate,
 *       avg_ltv_30d, avg_ltv_90d, avg_ltv_180d,
 *       median_ltv_180d, top_decile_ltv_180d, max_ltv_180d
 *     },
 *     by_cohort_month: [{ month, signups, matched, avg_ltv_30d, avg_ltv_90d, avg_ltv_180d }],
 *     total_clients_in_filter, returned, offset, limit,
 *     clients: [{ client_id, registered_at, reg_status,
 *                 ltv_30d, rides_30d, ltv_90d, rides_90d, ltv_180d, rides_180d,
 *                 total_rides_all, total_earn_all,
 *                 first_ride_at, last_ride_at,
 *                 mature_30d, mature_90d, mature_180d }]
 *   }
 */
import { query, ok, bad, requireAuth } from '../_db.js';

const ALLOWED_ORDER = {
  ltv_180d: 'ltv_180d', ltv_90d: 'ltv_90d', ltv_30d: 'ltv_30d',
  total_earn_all: 'total_earn_all', registered_at: 'registered_at',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const minRides    = Math.max(0, parseInt(url.searchParams.get('min_rides') || '1', 10) || 0);
  const regFrom     = url.searchParams.get('registered_from') || null;
  const regTo       = url.searchParams.get('registered_to')   || null;
  const matureOnly  = url.searchParams.get('mature_only') === 'true';
  // Registration status filter: default 'Current' (real organic signups);
  // 'all' = include status='New' too (mostly spam batches from Jan/May/Jul
  // 2025 — only useful for explicit anomaly analysis).
  const includeNew  = url.searchParams.get('include_new') === 'true';
  const orderBy     = ALLOWED_ORDER[url.searchParams.get('order_by') || 'ltv_180d'] || 'ltv_180d';
  const orderDir    = (url.searchParams.get('order_dir') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const limit       = Math.min(Math.max(parseInt(url.searchParams.get('limit')  || '50', 10) || 50, 1), 500);
  const offset      = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  // ISO date regex for the optional from/to params
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (regFrom && !dateRe.test(regFrom)) return bad(res, 400, 'registered_from must be YYYY-MM-DD');
  if (regTo   && !dateRe.test(regTo))   return bad(res, 400, 'registered_to must be YYYY-MM-DD');

  // Build a shared WHERE clause + params for the filtered subset.
  const where = ['(rides_180d >= $1 OR rides_30d >= $1)'];
  const params = [minRides];
  if (!includeNew) where.push(`reg_status = 'Current'`);
  if (regFrom){ params.push(regFrom); where.push(`registered_at >= $${params.length}::date`); }
  if (regTo)  { params.push(regTo);   where.push(`registered_at <  $${params.length}::date + INTERVAL '1 day'`); }
  if (matureOnly) where.push('mature_180d');
  const whereSql = `WHERE ${where.join(' AND ')}`;

  try {
    // Status-aware filters for the inline subselects in the summary query.
    const statusFilterRegInline = includeNew ? '' : `WHERE status = 'Current'`;
    const statusFilterLtvInline = includeNew ? '' : `WHERE reg_status = 'Current'`;

    // Summary across the filtered set + match_rate over all registrations
    // honouring the same status filter (so the rate is apples-to-apples).
    const [summaryRow] = await query(
      `WITH filt AS (SELECT * FROM client_ltv ${whereSql})
       SELECT
         (SELECT COUNT(*)::int FROM filt)                                    AS total_clients,
         (SELECT COUNT(*)::int FROM filt WHERE mature_180d)                  AS mature_180d_clients,
         (SELECT ROUND(AVG(ltv_30d)::numeric,  2) FROM filt WHERE mature_30d)  AS avg_ltv_30d,
         (SELECT ROUND(AVG(ltv_90d)::numeric,  2) FROM filt WHERE mature_90d)  AS avg_ltv_90d,
         (SELECT ROUND(AVG(ltv_180d)::numeric, 2) FROM filt WHERE mature_180d) AS avg_ltv_180d,
         (SELECT ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ltv_180d))::numeric, 2)
            FROM filt WHERE mature_180d)                                       AS median_ltv_180d,
         (SELECT ROUND((PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ltv_180d))::numeric, 2)
            FROM filt WHERE mature_180d)                                       AS top_decile_ltv_180d,
         (SELECT MAX(ltv_180d)                FROM filt WHERE mature_180d)    AS max_ltv_180d,
         (SELECT COUNT(*) FROM registrations ${statusFilterRegInline})::int    AS registrations_total,
         (SELECT COUNT(*) FROM client_ltv ${statusFilterLtvInline})::int       AS clients_with_any_match`,
      params
    );

    const matchRate = summaryRow.registrations_total
      ? +(summaryRow.clients_with_any_match / summaryRow.registrations_total).toFixed(4)
      : 0;

    // Cohort breakdown — monthly buckets from registered_at, average LTV per
    // window. Signups + matched both honour the include_new toggle so the
    // match rate is apples-to-apples.
    const cohortRows = await query(
      `WITH reg_by_month AS (
         SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                COUNT(*)::int AS signups
         FROM registrations
         ${statusFilterRegInline}
         GROUP BY 1
       ),
       ltv_by_month AS (
         SELECT to_char(date_trunc('month', registered_at), 'YYYY-MM') AS month,
                COUNT(*)::int                              AS matched,
                ROUND(AVG(ltv_30d)  FILTER (WHERE mature_30d)::numeric,  2) AS avg_ltv_30d,
                ROUND(AVG(ltv_90d)  FILTER (WHERE mature_90d)::numeric,  2) AS avg_ltv_90d,
                ROUND(AVG(ltv_180d) FILTER (WHERE mature_180d)::numeric, 2) AS avg_ltv_180d
         FROM client_ltv
         ${statusFilterLtvInline}
         GROUP BY 1
       )
       SELECT r.month, r.signups,
              COALESCE(l.matched, 0)        AS matched,
              l.avg_ltv_30d, l.avg_ltv_90d, l.avg_ltv_180d
       FROM reg_by_month r
       LEFT JOIN ltv_by_month l USING (month)
       ORDER BY r.month`
    );

    // Paginated client list — truncated client_id (12 chars) for display.
    const clients = await query(
      `SELECT
         substr(client_id, 1, 12)               AS client_id,
         to_char(registered_at, 'YYYY-MM-DD')   AS registered_at,
         reg_status,
         ltv_30d::float, rides_30d,
         ltv_90d::float, rides_90d,
         ltv_180d::float, rides_180d,
         total_rides_all, total_earn_all::float,
         to_char(first_ride_at, 'YYYY-MM-DD')   AS first_ride_at,
         to_char(last_ride_at, 'YYYY-MM-DD')    AS last_ride_at,
         mature_30d, mature_90d, mature_180d
       FROM client_ltv
       ${whereSql}
       ORDER BY ${orderBy} ${orderDir} NULLS LAST, client_id
       OFFSET $${params.length + 1} LIMIT $${params.length + 2}`,
      [...params, offset, limit]
    );

    ok(res, {
      summary: {
        total_clients:        summaryRow.total_clients,
        mature_180d_clients:  summaryRow.mature_180d_clients,
        avg_ltv_30d:          summaryRow.avg_ltv_30d  ? +summaryRow.avg_ltv_30d  : 0,
        avg_ltv_90d:          summaryRow.avg_ltv_90d  ? +summaryRow.avg_ltv_90d  : 0,
        avg_ltv_180d:         summaryRow.avg_ltv_180d ? +summaryRow.avg_ltv_180d : 0,
        median_ltv_180d:      summaryRow.median_ltv_180d ? +summaryRow.median_ltv_180d : 0,
        top_decile_ltv_180d:  summaryRow.top_decile_ltv_180d ? +summaryRow.top_decile_ltv_180d : 0,
        max_ltv_180d:         summaryRow.max_ltv_180d ? +summaryRow.max_ltv_180d : 0,
        match_rate:           matchRate,
        registrations_total:  summaryRow.registrations_total,
        clients_with_any_match: summaryRow.clients_with_any_match,
      },
      by_cohort_month: cohortRows,
      total_clients_in_filter: summaryRow.total_clients,
      offset, limit,
      returned: clients.length,
      clients,
    }, { cache: 'public, max-age=300, s-maxage=300, must-revalidate' });
  } catch (e) {
    if ((e.code || '') === '42P01') {
      return bad(res, 503, 'client_ltv table not initialised — run migrations/0003_client_ltv.sql + the build script', { code: e.code });
    }
    console.error(e);
    bad(res, 500, e.message || 'ltv query failed', { code: e.code });
  }
}
