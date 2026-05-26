/* GET /api/account-names
 *
 * Returns the account_number → account_name lookup the dashboard uses
 * to render top-clients / per-account breakdowns. Mirrors the old
 * `account_names` Supabase table.
 *
 * Response: { account_names: { "110000": "Public Account", ... } }
 *
 * Built on the fly from DISTINCT (account_number, account_name) in
 * job_analogue. For ~280k jobs across ~3k accounts this is a few
 * hundred ms and the result is heavily cacheable.
 */
import { query, ok, bad, requireAuth } from './_db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;
  try {
    // Pick one name per account_number (MIN avoids relying on row order).
    const rows = await query(
      `SELECT account_number::text AS account_no, MIN(account_name) AS name
         FROM job_analogue
        WHERE account_number IS NOT NULL
        GROUP BY account_number`
    );
    const account_names = {};
    for (const r of rows) {
      if (r.name) account_names[r.account_no] = r.name;
    }
    ok(res, { count: rows.length, account_names },
       { cache: 'public, max-age=600, must-revalidate' });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'account-names query failed');
  }
}
