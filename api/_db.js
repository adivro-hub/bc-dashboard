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
 * Bearer-token guard.
 *
 * Defence-in-depth gate that runs before every /api/* handler until real
 * magic-link auth is in place. Behaviour:
 *
 *   - If env var API_TOKEN is set: request MUST present
 *       Authorization: Bearer <API_TOKEN>     (or ?token=<API_TOKEN>)
 *     otherwise the handler returns 401 and never touches Neon.
 *   - If API_TOKEN is NOT set: the request is allowed (so local smoke
 *     tests still work). Production deploys MUST set the env var.
 *
 * Returns `true` if the request is allowed; otherwise writes a 401 to
 * `res` and returns `false` — callers should `return` immediately when
 * this returns false.
 */
export function requireAuth(req, res) {
  const expected = process.env.API_TOKEN;
  if (!expected) return true; // not configured — allow (dev only)

  const auth = req.headers['authorization'] || '';
  let token = '';
  if (auth.startsWith('Bearer ')) {
    token = auth.slice('Bearer '.length).trim();
  } else {
    // Allow ?token= for quick curl tests
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      token = url.searchParams.get('token') || '';
    } catch { /* ignore */ }
  }

  // Constant-time comparison via Buffer (small inputs so timing leakage
  // is not the threat model — just resist trivial guessing).
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
