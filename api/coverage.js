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
import { query, ok, bad } from './_db.js';

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

  try {
    const [jobRow] = await query(
      `SELECT COUNT(*)::int AS rows,
              MIN(job_date)  AS date_min,
              MAX(job_date)  AS date_max
       FROM job_analogue`
    );
    const [regRow] = await query(
      `SELECT COUNT(*)::int AS rows,
              MIN(created_at) AS created_min,
              MAX(created_at) AS created_max
       FROM registrations`
    );

    // Income structure views may not exist yet — query gracefully.
    const income = {};
    for (const v of INCOME_VIEWS) {
      try {
        const [r] = await query(
          `SELECT COUNT(*)::int AS rows,
                  MIN("Date") AS date_min,
                  MAX("Date") AS date_max
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
      income_structure: income,
    }, { cache: 'public, max-age=60, must-revalidate' });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'query failed');
  }
}
