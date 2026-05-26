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

/** Run a query and return rows (helper for the common case). */
export async function query(sql, params = []) {
  const res = await pool().query(sql, params);
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
