/* Auth helpers — magic-link via Resend, JWT cookie session.
 *
 * Token lifecycle (login -> verify):
 *   1. POST /api/auth/login {email}:
 *        - generate 32-byte random token
 *        - store SHA-256 hash in auth_tokens with 15-min expiry
 *        - email magic link `${APP_URL}/api/auth/verify?token=<plaintext>`
 *   2. GET  /api/auth/verify?token=...:
 *        - hash, look up, check not expired & not used
 *        - mark used, sign a JWT (7d), set HttpOnly cookie
 *        - redirect to /
 *
 * JWT verify is also called by requireAuth() in _db.js so any /api/*
 * endpoint accepts the cookie alongside the legacy bearer token.
 */
import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export const COOKIE_NAME = 'bc_session';
export const JWT_ALG     = 'HS256';
export const JWT_TTL_SEC = 7 * 24 * 60 * 60;          // 7 days
export const LINK_TTL_MS = 15 * 60 * 1000;            // 15 min

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return new TextEncoder().encode(s);
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function newToken() {
  // 32 bytes → 43-char base64url. URL-safe and roomy.
  return crypto.randomBytes(32).toString('base64url');
}

export async function signSessionJWT(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + JWT_TTL_SEC)
    .sign(jwtSecret());
}

export async function verifySessionJWT(token) {
  try {
    const { payload } = await jwtVerify(token, jwtSecret(), { algorithms: [JWT_ALG] });
    return payload;
  } catch {
    return null;
  }
}

/** Parse a single cookie value out of the request headers. */
export function readCookie(req, name) {
  const raw = req.headers['cookie'] || '';
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}

export function setSessionCookie(res, jwt) {
  // SameSite=Lax keeps the cookie attached on top-level GETs (e.g. user
  // clicking the magic link in their email), but blocks cross-site POSTs.
  // Secure is fine on Vercel; localhost won't be a deploy target for this.
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(jwt)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${JWT_TTL_SEC}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

/** Read JSON body from a Vercel function request. */
export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let chunks = '';
  await new Promise((resolve, reject) => {
    req.on('data', (c) => { chunks += c; });
    req.on('end', resolve);
    req.on('error', reject);
  });
  try { return JSON.parse(chunks || '{}'); } catch { return {}; }
}

/** Light email validation — just shape, not deliverability. */
export function looksLikeEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/**
 * Send the magic-link email via Resend's REST API. Returns the parsed
 * Resend response on success; throws otherwise.
 */
export async function sendMagicLinkEmail({ to, link }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  const from = process.env.EMAIL_FROM || 'BC Dashboard <onboarding@resend.dev>';

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Sign in to BC Dashboard',
      text:
        `Click here to sign in (link expires in 15 minutes):\n\n${link}\n\n` +
        `If you didn't request this, you can ignore the email.`,
      html:
        `<p>Click here to sign in (link expires in 15 minutes):</p>` +
        `<p><a href="${link}">${link}</a></p>` +
        `<p style="color:#666;font-size:12px">If you didn't request this, you can ignore the email.</p>`,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    const err = new Error(`Resend ${r.status}: ${body}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/**
 * Resolve a session from a request. Returns { email, role } or null.
 * Used by requireAuth() in _db.js — keeps cookie/JWT logic in one place.
 */
export async function getSessionFromRequest(req) {
  const jwt = readCookie(req, COOKIE_NAME);
  if (!jwt) return null;
  const payload = await verifySessionJWT(jwt);
  if (!payload || !payload.email) return null;
  return { email: payload.email, role: payload.role || 'viewer' };
}
