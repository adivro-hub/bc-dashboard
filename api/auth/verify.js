/* GET /api/auth/verify?token=...
 *
 * Validates the one-time token from a magic-link email, marks it used,
 * issues a JWT, sets it as an HttpOnly session cookie, and 302s to /.
 *
 * Any failure renders a tiny error page (the request came from a browser
 * via email click, so HTML is the right response shape).
 */
import { query } from '../_db.js';
import {
  sha256, signSessionJWT, setSessionCookie,
} from '../_auth.js';

function htmlError(res, status, msg) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in failed</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0b1020;color:#cdd6ee;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
  .card{max-width:480px;background:#14193a;border:1px solid #2a3168;border-radius:12px;padding:28px}
  h1{margin:0 0 12px;font-size:20px;color:#fff}
  a{color:#7c9cff}
  .err{color:#ff9a9a;margin:16px 0;font-size:14px}
</style></head>
<body><div class="card">
  <h1>Sign in failed</h1>
  <p class="err">${msg}</p>
  <p><a href="/upload.html">Try again</a></p>
</div></body></html>`);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('GET only');
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!token) return htmlError(res, 400, 'Missing token in URL.');

  const tokenHash = sha256(token);

  const [row] = await query(
    `SELECT t.email, t.expires_at, t.used_at, m.role
       FROM auth_tokens t
       JOIN members m ON m.email = t.email
      WHERE t.token_hash = $1`,
    [tokenHash]
  );
  if (!row) {
    return htmlError(res, 400, 'This link is invalid. It may have already been used or never existed.');
  }
  if (row.used_at) {
    return htmlError(res, 400, 'This link has already been used. Request a fresh one.');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return htmlError(res, 400, 'This link has expired (15-minute window). Request a fresh one.');
  }

  // Mark token used. Best-effort — we'll still set the cookie even if
  // this update somehow fails, but log loudly.
  try {
    await query(`UPDATE auth_tokens SET used_at = NOW() WHERE token_hash = $1`, [tokenHash]);
  } catch (e) {
    console.error('mark-used failed:', e);
  }

  const jwt = await signSessionJWT({ email: row.email, role: row.role || 'viewer' });
  setSessionCookie(res, jwt);
  res.statusCode = 302;
  res.setHeader('Location', '/');
  res.end();
}
