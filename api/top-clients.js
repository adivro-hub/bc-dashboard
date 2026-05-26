/* GET /api/top-clients?from=YYYY-MM-DD&to=YYYY-MM-DD&segment=retail|corporate|all&limit=N
 *
 * Top accounts in the range, ranked by combined job count (matches
 * build_top_clients.py's tie-breaker on Σ Total Price).
 *
 * Definitions (mirroring build_top_clients.py):
 *   retail    => account_number = 110000   (Public Account)
 *   corporate => account_number <> 110000
 *
 * Response: { from, to, segment, total_revenue, rows: [...] }
 *   rows[]:
 *     account_number, account_name, jobs, total_price, driver_price,
 *     earnings (total_price - driver_price)
 */
import { query, ok, bad, parseDateRange } from './_db.js';

const PUBLIC_ACCOUNT_NO = 110000;

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const segment = (url.searchParams.get('segment') || 'all').toLowerCase();
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1),
    200
  );

  let from, to;
  try {
    ({ from, to } = parseDateRange(req));
  } catch (e) {
    return bad(res, 400, e.message);
  }

  const filter =
    segment === 'retail'    ? `AND account_number = ${PUBLIC_ACCOUNT_NO}`
  : segment === 'corporate' ? `AND account_number <> ${PUBLIC_ACCOUNT_NO}`
  : '';

  try {
    const rows = await query(
      `SELECT
         account_number,
         MIN(account_name) AS account_name,
         COUNT(*)::int AS jobs,
         COALESCE(SUM(total_price), 0)::float        AS total_price,
         COALESCE(SUM(driver_total_price), 0)::float AS driver_price,
         (COALESCE(SUM(total_price), 0) - COALESCE(SUM(driver_total_price), 0))::float
                                                     AS earnings
       FROM job_analogue
       WHERE job_date BETWEEN $1::date AND $2::date
         ${filter}
       GROUP BY account_number
       ORDER BY jobs DESC, total_price DESC
       LIMIT ${limit}`,
      [from, to]
    );

    const [totalsRow] = await query(
      `SELECT COALESCE(SUM(total_price), 0)::float AS total_revenue
       FROM job_analogue
       WHERE job_date BETWEEN $1::date AND $2::date
         ${filter}`,
      [from, to]
    );

    ok(res, {
      from, to, segment, limit,
      total_revenue: totalsRow.total_revenue,
      rows,
    }, { cache: 'public, max-age=60, must-revalidate' });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'query failed');
  }
}
