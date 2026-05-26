/* POST /api/auth/logout
 *
 * Clears the session cookie. Idempotent.
 */
import { ok, bad } from '../_db.js';
import { clearSessionCookie } from '../_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return bad(res, 405, 'POST or GET');
  }
  clearSessionCookie(res);
  ok(res, { signed_out: true });
}
