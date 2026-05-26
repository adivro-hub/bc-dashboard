/* GET /api/registrations?from=YYYY-MM-DD&to=YYYY-MM-DD&group_by=day|status|origin
 *
 * Aggregates registration rows across the requested range.
 *
 * Response: { from, to, group_by, total, rows: [{ key, count }, ...] }
 */
import { query, ok, bad, parseDateRange, requireAuth } from './_db.js';

const GROUP_EXPR = {
  day:     "to_char(created_at, 'YYYY-MM-DD')",
  status:  "COALESCE(status, '(unknown)')",
  origin:  "COALESCE(origin, '(unknown)')",
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!requireAuth(req, res)) return;
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

  const orderBy = groupBy === 'day' ? '1 ASC' : 'count DESC';

  const sql = `
    SELECT
      ${GROUP_EXPR[groupBy]} AS key,
      COUNT(*)::int AS count
    FROM registrations
    WHERE created_at >= $1::timestamp
      AND created_at <  ($2::date + INTERVAL '1 day')
    GROUP BY 1
    ORDER BY ${orderBy}
  `;

  try {
    const rows = await query(sql, [from, to]);
    const total = rows.reduce((acc, r) => acc + r.count, 0);
    ok(res, { from, to, group_by: groupBy, total, rows }, {
      cache: 'public, max-age=60, must-revalidate',
    });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'query failed');
  }
}
