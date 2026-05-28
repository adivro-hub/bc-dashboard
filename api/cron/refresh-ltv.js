/* GET/POST /api/cron/refresh-ltv
 *
 * Rebuilds the client_ltv table from registrations + Public-account
 * (110000) DONE rides in job_analogue. Runs as a single transaction
 * with TEMP tables; ON COMMIT DROP cleans them up.
 *
 * Schedule: nightly at 03:30 (after the 03:00 income cron).
 *
 * Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. We
 * also accept the regular API_TOKEN for manual triggers.
 */
import { pool, ok, bad } from '../_db.js';

const BUILD_SQL = `
CREATE TEMP TABLE _rides ON COMMIT DROP AS
SELECT
  job_date,
  (COALESCE(total_price, 0) - COALESCE(driver_total_price, 0))::numeric AS earnings,
  NULLIF(lower(trim(passenger_email)), '')                                AS email_n,
  CASE WHEN length(regexp_replace(split_part(passenger_telephone::text, '.', 1), '\\D', '', 'g')) >= 9
       THEN right(regexp_replace(split_part(passenger_telephone::text, '.', 1), '\\D', '', 'g'), 9)
  END                                                                    AS phone_n
FROM job_analogue
WHERE account_number = 110000 AND status = 'DONE' AND job_date IS NOT NULL;

CREATE INDEX ON _rides (phone_n) WHERE phone_n IS NOT NULL;
CREATE INDEX ON _rides (email_n) WHERE email_n IS NOT NULL;

CREATE TEMP TABLE _regs ON COMMIT DROP AS
SELECT
  created_at, status AS reg_status, origin AS reg_origin,
  NULLIF(lower(trim(email)), '')                                                    AS email_n,
  CASE WHEN length(regexp_replace(split_part(mobile_phone::text, '.', 1), '\\D', '', 'g')) >= 9
       THEN right(regexp_replace(split_part(mobile_phone::text, '.', 1), '\\D', '', 'g'), 9)
  END                                                                               AS phone_n
FROM registrations WHERE created_at IS NOT NULL;

CREATE INDEX ON _regs (phone_n) WHERE phone_n IS NOT NULL;
CREATE INDEX ON _regs (email_n) WHERE email_n IS NOT NULL;

CREATE TEMP TABLE _matches ON COMMIT DROP AS
SELECT g.email_n, g.phone_n, g.created_at, g.reg_status, g.reg_origin,
       r.job_date, r.earnings, (r.job_date - g.created_at::date) AS days_after
FROM _regs g JOIN _rides r ON r.phone_n = g.phone_n
WHERE g.phone_n IS NOT NULL AND r.phone_n IS NOT NULL
  AND r.job_date >= g.created_at::date
UNION ALL
SELECT g.email_n, g.phone_n, g.created_at, g.reg_status, g.reg_origin,
       r.job_date, r.earnings, (r.job_date - g.created_at::date) AS days_after
FROM _regs g JOIN _rides r ON r.email_n = g.email_n
WHERE g.email_n IS NOT NULL AND r.email_n IS NOT NULL
  AND r.job_date >= g.created_at::date
  AND (g.phone_n IS NULL OR r.phone_n IS NULL);

TRUNCATE TABLE client_ltv;

INSERT INTO client_ltv (
  client_id, email_hash, phone_hash,
  registered_at, reg_status, reg_origin,
  ltv_30d, rides_30d, ltv_90d, rides_90d, ltv_180d, rides_180d,
  mature_30d, mature_90d, mature_180d,
  first_ride_at, last_ride_at, total_rides_all, total_earn_all
)
SELECT
  encode(digest(COALESCE(email_n,'') || '|' || COALESCE(phone_n,''), 'sha256'), 'hex'),
  CASE WHEN email_n IS NULL THEN NULL ELSE encode(digest(email_n, 'sha256'), 'hex') END,
  CASE WHEN phone_n IS NULL THEN NULL ELSE encode(digest(phone_n, 'sha256'), 'hex') END,
  MIN(created_at), MIN(reg_status), MIN(reg_origin),
  COALESCE(SUM(earnings) FILTER (WHERE days_after <=  30), 0),
  COUNT(*)                FILTER (WHERE days_after <=  30),
  COALESCE(SUM(earnings) FILTER (WHERE days_after <=  90), 0),
  COUNT(*)                FILTER (WHERE days_after <=  90),
  COALESCE(SUM(earnings) FILTER (WHERE days_after <= 180), 0),
  COUNT(*)                FILTER (WHERE days_after <= 180),
  (MIN(created_at) + INTERVAL '30 days')  <= NOW(),
  (MIN(created_at) + INTERVAL '90 days')  <= NOW(),
  (MIN(created_at) + INTERVAL '180 days') <= NOW(),
  MIN(job_date), MAX(job_date), COUNT(*), COALESCE(SUM(earnings), 0)
FROM _matches
GROUP BY email_n, phone_n;
`;

function authOk(req){
  const cronSecret = process.env.CRON_SECRET;
  const apiToken   = process.env.API_TOKEN;
  const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/, '');
  if (cronSecret && got === cronSecret) return true;
  if (apiToken   && got === apiToken)   return true;
  return !cronSecret && !apiToken;
}

export default async function handler(req, res){
  if (req.method !== 'GET' && req.method !== 'POST') return bad(res, 405, 'GET/POST only');
  if (!authOk(req)) return bad(res, 401, 'unauthorized');

  const t0 = Date.now();
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query(BUILD_SQL);
    await client.query('COMMIT');
    const [stats] = (await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE mature_180d)::int AS mature_180d,
              ROUND(AVG(ltv_180d) FILTER (WHERE mature_180d)::numeric, 2) AS avg_ltv_180d
       FROM client_ltv`
    )).rows;
    ok(res, { ok: true, ms: Date.now() - t0, stats });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('LTV refresh failed:', e);
    bad(res, 500, e.message || 'refresh failed', { code: e.code });
  } finally {
    client.release();
  }
}
