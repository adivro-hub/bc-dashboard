/* GET /api/reg-rows?from=YYYY-MM-DD&to=YYYY-MM-DD&offset=N&limit=N
 *
 * Paginated registration rows in the shape the dashboard frontend
 * expects (matches the old Supabase `reg_rows` table):
 *   { created_at (ISO), status, email_hash }
 *
 * email_hash is sha256(lower(trim(email))) computed in Postgres so we
 * never send plaintext emails over the wire here.
 */
import { query, ok, bad, parseDateRange, requireAuth } from './_db.js';

const MAX_LIMIT = 10_000;
const DEFAULT_LIMIT = 5_000;

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;

  let from, to;
  try { ({ from, to } = parseDateRange(req)); }
  catch (e) { return bad(res, 400, e.message); }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const limit  = Math.min(MAX_LIMIT,
    Math.max(1, parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));

  try {
    // file_id is a constant string matching the synth reg_files
    // entry id ("registrations-neon") in shared_store_neon.js. The
    // legacy upload.js buckets rows by file_id; with Neon we have a
    // single synthetic "file" covering everything, so all rows share it.
    const rows = await query(
      `SELECT
         'registrations-neon'::text AS file_id,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
         COALESCE(status, '') AS status,
         encode(digest(lower(trim(email)), 'sha256'), 'hex') AS email_hash
       FROM registrations
       WHERE created_at >= $1::timestamp
         AND created_at <  ($2::date + INTERVAL '1 day')
       ORDER BY created_at ASC
       OFFSET $3 LIMIT $4`,
      [from, to, offset, limit]
    );
    const next_offset = rows.length < limit ? null : offset + rows.length;
    ok(res, { from, to, offset, limit, count: rows.length, next_offset, rows });
  } catch (e) {
    // pgcrypto's digest() requires the extension to be enabled. If the
    // first call hits "function digest does not exist", we tell the
    // caller exactly which one-liner unblocks it.
    if (/digest.*does not exist/i.test(e.message || '')) {
      return bad(res, 500,
        'pgcrypto missing — run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` on Neon',
        { code: e.code });
    }
    console.error(e);
    bad(res, 500, e.message || 'reg-rows query failed');
  }
}
