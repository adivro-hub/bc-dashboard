/* Shared Neon Postgres client.
 *
 * Vercel functions can be invoked concurrently and a fresh module instance
 * may be reused across invocations of the same warm container. We keep one
 * pg.Pool per container with conservative limits — Neon's pooler endpoint
 * (`-pooler` in the host name) handles the heavy lifting on its side.
 *
 * Required env vars:
 *   DATABASE_URL  — pooled Neon URI (postgresql://...-pooler.../neondb?sslmode=require)
 */
import pg from 'pg';

const { Pool } = pg;

let _pool = null;
let _sourcePool = null;

export function pool() {
  if (_pool) return _pool;
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    throw new Error('DATABASE_URL is not set');
  }
  _pool = new Pool({
    connectionString: conn,
    // Neon pooler already multiplexes; small per-container pool is enough.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  _pool.on('error', (err) => {
    // Don't crash the function on idle-client errors; just log.
    console.error('pg pool error:', err);
  });
  return _pool;
}

/**
 * Connection to the *source* Postgres (Leaseweb, 62.212.86.214) where
 * data_access.income_structure_* views live. Used for the nightly sync
 * and for ?fresh=1 bypass on /api/income.
 *
 * Requires env var SOURCE_DATABASE_URL. Returns null (not throws) if
 * unset, so a deploy without it still serves cached data.
 */
export function sourcePool() {
  if (_sourcePool) return _sourcePool;
  const conn = process.env.SOURCE_DATABASE_URL;
  if (!conn) return null;
  _sourcePool = new Pool({
    connectionString: conn,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Source DB serves a self-signed cert. Encryption stays on (so the
    // password isn't sent in plaintext), but we skip CN/CA validation —
    // the IP-allowlist is what gives us authenticity here, not PKI.
    // Neon's pool above is unaffected (it has a properly trusted cert).
    ssl: { rejectUnauthorized: false },
  });
  _sourcePool.on('error', (err) => {
    console.error('source pg pool error:', err);
  });
  return _sourcePool;
}

/** Run a query and return rows (helper for the common case). */
export async function query(sql, params = []) {
  const res = await pool().query(sql, params);
  return res.rows;
}

/** Same as query() but against the source DB. */
export async function sourceQuery(sql, params = []) {
  const p = sourcePool();
  if (!p) throw new Error('SOURCE_DATABASE_URL is not set');
  const res = await p.query(sql, params);
  return res.rows;
}

/** Standard JSON response helper. */
export function ok(res, body, { cache } = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cache) {
    res.setHeader('Cache-Control', cache);
  }
  res.status(200).send(JSON.stringify(body));
}

export function bad(res, status, message, extra = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify({ error: message, ...extra }));
}

/**
 * Auth guard. Accepts either:
 *   (a) a valid JWT session cookie (set by /api/auth/verify), or
 *   (b) the shared bearer token in env API_TOKEN (for cron / curl /
 *       smoke tests / scheduled jobs).
 *
 * When neither matches, returns 401 and writes the response. On success
 * attaches req.session = { email, role } when authenticated via cookie;
 * bearer auth leaves req.session unset.
 *
 * Returns `true` if the request is allowed; otherwise writes a 401 to
 * `res` and returns `false` — callers should `return` immediately when
 * this returns false.
 *
 * NOTE: this function is async (cookie verification involves JWT
 * crypto), so handlers must `if (!await requireAuth(req, res)) return;`.
 */
export async function requireAuth(req, res) {
  // 1) Cookie / JWT session.
  try {
    const { getSessionFromRequest } = await import('./_auth.js');
    const session = await getSessionFromRequest(req);
    if (session) {
      req.session = session;
      return true;
    }
  } catch (e) {
    // If _auth.js can't load (e.g. JWT_SECRET missing in dev), fall
    // through to bearer-token path.
    console.warn('cookie auth check failed:', e.message);
  }

  // 2) Bearer token / ?token=
  const expected = process.env.API_TOKEN;
  if (!expected) return true; // both auth methods unconfigured — dev only

  const auth = req.headers['authorization'] || '';
  let token = '';
  if (auth.startsWith('Bearer ')) {
    token = auth.slice('Bearer '.length).trim();
  } else {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      token = url.searchParams.get('token') || '';
    } catch { /* ignore */ }
  }
  if (token && token.length === expected.length && token === expected) {
    return true;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('WWW-Authenticate', 'Bearer');
  res.status(401).send(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

/** Parse and validate ?from=YYYY-MM-DD&to=YYYY-MM-DD; returns [from, to] strings. */
export function parseDateRange(req, { required = true } = {}) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (required && (!from || !to)) {
    throw new RangeError('Missing ?from=YYYY-MM-DD&to=YYYY-MM-DD');
  }
  if (from && !re.test(from)) throw new RangeError(`Bad 'from' date: ${from}`);
  if (to && !re.test(to)) throw new RangeError(`Bad 'to' date: ${to}`);
  if (from && to && from > to) throw new RangeError(`'from' > 'to'`);
  return { from, to };
}
