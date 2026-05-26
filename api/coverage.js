/* GET /api/coverage
 *
 * Returns what date ranges and row counts are present in each table.
 * Lets the dashboard show the date picker bounds without loading any rows,
 * and replaces the per-section metadata calls that today go to Supabase.
 *
 * Response shape:
 *   {
 *     jobs:         { rows, date_min, date_max },
 *     registrations:{ rows, created_min, created_max },
 *     income_structure: { … per view … }   // populated once views exist
 *   }
 */
import { query, ok, bad, requireAuth } from './_db.js';

const INCOME_VIEWS = [
  'income_structure_vat',
  'income_structure_payment_type',
  'income_structure_grade',
  'income_structure_service',
  'income_structure_fleet',
  'income_structure_login_time',
];

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;

  try {
    // to_char(..., 'YYYY-MM-DD') keeps dates as plain strings so the
    // pg driver doesn't convert them to UTC midnight Date objects
    // (which would shift e.g. 2025-01-01 to 2024-12-31T22:00:00Z in
    // a UTC+2 locale and confuse the frontend).
    const [jobRow] = await query(
      `SELECT COUNT(*)::int                            AS rows,
              to_char(MIN(job_date), 'YYYY-MM-DD')     AS date_min,
              to_char(MAX(job_date), 'YYYY-MM-DD')     AS date_max
       FROM job_analogue`
    );
    const [regRow] = await query(
      `SELECT COUNT(*)::int                                  AS rows,
              to_char(MIN(created_at), 'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_min,
              to_char(MAX(created_at), 'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_max
       FROM registrations`
    );

    // Hour Statistics mirror — same gentle handling as income views in
    // case it's missing on an older deploy where the table hasn't been
    // created yet.
    let hours = { rows: 0, date_min: null, date_max: null };
    try {
      const [r] = await query(
        `SELECT COUNT(*)::int                          AS rows,
                to_char(MIN(date), 'YYYY-MM-DD')       AS date_min,
                to_char(MAX(date), 'YYYY-MM-DD')       AS date_max
         FROM hour_statistics`
      );
      hours = r;
    } catch (e) {
      hours.error = e.code || 'missing';
    }

    // Income structure views may not exist yet — query gracefully.
    const income = {};
    for (const v of INCOME_VIEWS) {
      try {
        const [r] = await query(
          `SELECT COUNT(*)::int                          AS rows,
                  to_char(MIN("Date"), 'YYYY-MM-DD')     AS date_min,
                  to_char(MAX("Date"), 'YYYY-MM-DD')     AS date_max
           FROM ${v}`
        );
        income[v] = r;
      } catch (e) {
        income[v] = { error: e.code || 'missing' };
      }
    }

    ok(res, {
      jobs: jobRow,
      registrations: regRow,
      hours,
      income_structure: income,
    }, { cache: 'public, max-age=60, must-revalidate' });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'query failed');
  }
}
