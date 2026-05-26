/* POST /api/auth/login
 * Body: { email }
 *
 * Generates a one-time magic-link token, stores its hash, emails the
 * plaintext link to the user via Resend. Only addresses listed in the
 * members table are accepted.
 *
 * Response: { sent: true } on success; 200 even when the email is not in
 * members (we never tell callers whether a given email is enrolled — that
 * would let them brute-force enumerate the allow-list).
 */
import { query, ok, bad } from '../_db.js';
import {
  readJsonBody, looksLikeEmail, newToken, sha256,
  sendMagicLinkEmail, LINK_TTL_MS,
} from '../_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return bad(res, 405, 'POST only');

  const body = await readJsonBody(req);
  const email = (body.email || '').trim().toLowerCase();
  if (!looksLikeEmail(email)) return bad(res, 400, 'invalid email');

  // Allow-list check — never reveal whether the email is enrolled.
  const [member] = await query('SELECT email FROM members WHERE email = $1', [email]);

  if (member) {
    try {
      const token = newToken();
      const tokenHash = sha256(token);
      const expiresAt = new Date(Date.now() + LINK_TTL_MS);
      await query(
        `INSERT INTO auth_tokens (token_hash, email, expires_at)
         VALUES ($1, $2, $3)`,
        [tokenHash, email, expiresAt]
      );

      const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
      if (!appUrl) {
        console.error('APP_URL not set — cannot build magic link');
        return bad(res, 500, 'server misconfigured: APP_URL not set');
      }
      const link = `${appUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;
      await sendMagicLinkEmail({ to: email, link });
    } catch (e) {
      console.error('login error:', e);
      // Still return generic success — but a 500 is also fine; choose to be honest.
      return bad(res, 500, 'could not send magic link');
    }
  }

  // Constant-ish response so non-members can't tell they were rejected.
  ok(res, { sent: true });
}
