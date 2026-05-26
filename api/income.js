/* GET /api/income?section=vat|payment_type|grade|service|fleet|login_time
 *                  &from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns rows from the corresponding data_access.income_structure_* view,
 * filtered by the "Date" column. The shape of each row is forwarded as-is
 * because each view has different columns — once we have access we'll
 * inspect them via inspect_income_views.py and tighten this if needed.
 *
 * Until the DB views are reachable from our infra, calls fall through with
 * a 503 + the underlying error so the frontend can degrade gracefully.
 */
import { query, ok, bad, parseDateRange } from './_db.js';

const SECTIONS = {
  vat:          'data_access.income_structure_vat',
  payment_type: 'data_access.income_structure_payment_type',
  grade:        'data_access.income_structure_grade',
  service:      'data_access.income_structure_service',
  fleet:        'data_access.income_structure_fleet',
  login_time:   'data_access.income_structure_login_time',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const section = (url.searchParams.get('section') || '').toLowerCase();
  if (!SECTIONS[section]) {
    return bad(res, 400, `section must be one of: ${Object.keys(SECTIONS).join(', ')}`);
  }

  let from, to;
  try {
    ({ from, to } = parseDateRange(req));
  } catch (e) {
    return bad(res, 400, e.message);
  }

  const view = SECTIONS[section];
  try {
    const rows = await query(
      `SELECT * FROM ${view}
       WHERE "Date" BETWEEN $1::date AND $2::date
       ORDER BY "Date" ASC`,
      [from, to]
    );
    ok(res, { section, view, from, to, rows }, {
      cache: 'public, max-age=60, must-revalidate',
    });
  } catch (e) {
    console.error(e);
    // 503 (vs 500) signals "temporarily unavailable" — the view may not
    // exist yet, or our infra cannot reach the source DB. Frontend can
    // show a friendlier message in this case.
    const status = (e.code === '42P01' /* undefined_table */) ? 503 : 500;
    bad(res, status, e.message || 'income query failed', { code: e.code });
  }
}
