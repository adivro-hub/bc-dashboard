/* GET /api/job-rows?from=YYYY-MM-DD&to=YYYY-MM-DD&offset=N&limit=N
 *
 * Returns paginated job rows in the *anonymised* shape that the
 * existing dashboard frontend expects (matches the old Supabase
 * `job_rows` table). The Neon `job_analogue` table has the raw fields;
 * we project them down so shared_store_neon.js can be a drop-in.
 *
 * Response:
 *   {
 *     from, to, offset, limit, count,
 *     next_offset,                  // null when we've reached the end
 *     rows: [
 *       { date, account_no, urgency, status, service, hour,
 *         total, driver_total, response_min,
 *         is_otp_pickup, is_otp_dropoff, is_no_supply_cancel }
 *     ]
 *   }
 */
import { query, ok, bad, parseDateRange, requireAuth } from './_db.js';

const NO_SUPPLY_REGEX =
  '(no cars available|serviciul .*indisponibil|nicio ma[sș]in[aă]|nu vrea sa astepte|sofer de la bv)';
const OTP_REGEX = '(OTP/LROP|OTOPENI\\s*Airport)';

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
    const rows = await query(
      `SELECT
         to_char(job_date, 'YYYY-MM-DD') AS date,
         CASE WHEN account_number IS NULL THEN ''
              ELSE account_number::text END AS account_no,
         COALESCE(urgency, '')           AS urgency,
         COALESCE(status, '')            AS status,
         COALESCE(service, '')           AS service,
         EXTRACT(HOUR FROM job_time)::int AS hour,
         COALESCE(total_price, 0)::float AS total,
         COALESCE(driver_total_price, 0)::float AS driver_total,
         CASE WHEN response_time IS NULL THEN NULL
              ELSE (EXTRACT(EPOCH FROM response_time) / 60.0)::float END AS response_min,
         (pick_up   ~* $3) AS is_otp_pickup,
         (drop_off  ~* $3) AS is_otp_dropoff,
         (cancel_reason ~* $4) AS is_no_supply_cancel
       FROM job_analogue
       WHERE job_date BETWEEN $1::date AND $2::date
       ORDER BY job_date ASC, job_number ASC
       OFFSET $5 LIMIT $6`,
      [from, to, OTP_REGEX, NO_SUPPLY_REGEX, offset, limit]
    );

    // The next call should use offset + rows.length. When rows < limit we
    // know we've reached the end and signal null so the client can stop.
    const next_offset = rows.length < limit ? null : offset + rows.length;

    ok(res, {
      from, to, offset, limit,
      count: rows.length,
      next_offset,
      rows,
    });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'job-rows query failed');
  }
}
