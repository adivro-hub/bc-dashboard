/* GET /api/jobs?from=YYYY-MM-DD&to=YYYY-MM-DD&group_by=...
 *
 * Aggregates job_analogue across the requested date range.
 *
 * Query params:
 *   from, to       Required date bounds (inclusive)
 *   group_by       day | hour | service | status | urgency | account
 *                  (default: day)
 *   status         Optional: filter on job status (e.g. DONE)
 *   service        Optional: filter on service
 *   limit          For 'account' grouping, cap rows (default 50, max 500)
 *
 * For each group, returns:
 *   { key, jobs, done, cancelled, total_price, driver_total_price }
 */
import { query, ok, bad, parseDateRange, requireAuth } from './_db.js';

const GROUP_EXPR = {
  day:     "to_char(job_date, 'YYYY-MM-DD')",
  hour:    "EXTRACT(HOUR FROM job_time)::int::text",
  service: 'COALESCE(service, \'(none)\')',
  status:  'COALESCE(status, \'(none)\')',
  urgency: 'COALESCE(urgency, \'(none)\')',
  account: 'COALESCE(account_name, account_number::text, \'(none)\')',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const groupBy = (url.searchParams.get('group_by') || 'day').toLowerCase();
  if (!GROUP_EXPR[groupBy]) {
    return bad(res, 400, `group_by must be one of ${Object.keys(GROUP_EXPR).join(', ')}`);
  }

  let from, to;
  try {
    ({ from, to } = parseDateRange(req));
  } catch (e) {
    return bad(res, 400, e.message);
  }

  const statusFilter  = url.searchParams.get('status');
  const serviceFilter = url.searchParams.get('service');
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') || '0', 10) || 0, 0),
    500
  );

  const whereParts = ['job_date BETWEEN $1::date AND $2::date'];
  const params = [from, to];
  if (statusFilter) { params.push(statusFilter);  whereParts.push(`status = $${params.length}`); }
  if (serviceFilter){ params.push(serviceFilter); whereParts.push(`service = $${params.length}`); }
  const whereSql = whereParts.join(' AND ');

  // For 'account' we also return the account number alongside the label.
  const extraCols = groupBy === 'account'
    ? ', MIN(account_number) AS account_number'
    : '';

  const orderBy = (groupBy === 'day' || groupBy === 'hour')
    ? '1 ASC'
    : 'jobs DESC';
  const limitSql = limit ? `LIMIT ${limit}` : (groupBy === 'account' ? 'LIMIT 50' : '');

  const sql = `
    SELECT
      ${GROUP_EXPR[groupBy]} AS key,
      COUNT(*)::int AS jobs,
      COUNT(*) FILTER (WHERE status = 'DONE')::int      AS done,
      COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
      COALESCE(SUM(total_price), 0)::float        AS total_price,
      COALESCE(SUM(driver_total_price), 0)::float AS driver_total_price
      ${extraCols}
    FROM job_analogue
    WHERE ${whereSql}
    GROUP BY 1
    ORDER BY ${orderBy}
    ${limitSql}
  `;

  try {
    const rows = await query(sql, params);
    ok(res, { from, to, group_by: groupBy, rows }, {
      cache: 'public, max-age=60, must-revalidate',
    });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'query failed');
  }
}
