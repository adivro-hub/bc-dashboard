/* GET /api/auth/me
 *
 * Returns the current session (from the JWT cookie). 200 with
 * { email, role } if signed in; 401 otherwise.
 */
import { ok, bad } from '../_db.js';
import { getSessionFromRequest } from '../_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  const session = await getSessionFromRequest(req);
  if (!session) return bad(res, 401, 'not signed in');
  ok(res, session);
}
