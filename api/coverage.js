/* GET /api/coverage
 *
 * Returns what date ranges and row counts are present in each table,
 * for the dashboard's coverage chip + period bounds.
 *
 * Response shape:
 *   {
 *     jobs:             { rows, date_min, date_max },
 *     registrations:    { rows, created_min, created_max },
 *     hours:            { rows, date_min, date_max },
 *     income_structure: { <view>: { rows, date_min, date_max | error }, ... }
 *   }
 *
 * All 9 queries run in parallel (pg pool max=10) so total latency is
 * roughly one round-trip to Neon plus the slowest individual query
 * instead of the sum. Response is cached at the CDN for 5 min — the
 * underlying counts only change after a sync run.
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

// One generic count + min/max query per table. Wrapped in try so a
// missing-table error degrades that entry without taking out the rest
// of the response (used to be the income views; now they all exist but
// the safety net is cheap). Also returns max(synced_at) for the mirror
// tables that have it, so the dashboard can show freshness ("data
// refreshed at HH:MM"). Tables without a synced_at column (the raw
// XLS-ingested ones) report null.
async function probeTable(table, dateExpr, { isTimestamp = false, hasSyncedAt = true } = {}) {
  const fmt = isTimestamp
    ? `'YYYY-MM-DD"T"HH24:MI:SSOF'`
    : `'YYYY-MM-DD'`;
  const syncedExpr = hasSyncedAt
    ? `, to_char(MAX(synced_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS synced_at`
    : '';
  try {
    const [r] = await query(
      `SELECT COUNT(*)::int AS rows,
              to_char(MIN(${dateExpr}), ${fmt}) AS date_min,
              to_char(MAX(${dateExpr}), ${fmt}) AS date_max
              ${syncedExpr}
       FROM ${table}`
    );
    return r;
  } catch (e) {
    return { rows: 0, date_min: null, date_max: null, error: e.code || 'missing' };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;

  try {
    const [jobs, regsRaw, hours, ...incomes] = await Promise.all([
      // job_analogue + registrations have no synced_at column (XLS ingest
      // doesn't add it). The income mirror tables + hour_statistics do.
      probeTable('job_analogue',   'job_date',                { hasSyncedAt: false }),
      probeTable('registrations',  'created_at', { isTimestamp: true, hasSyncedAt: false }),
      probeTable('hour_statistics','date'),
      ...INCOME_VIEWS.map(v => probeTable(v, '"Date"')),
    ]);

    // Frontend reads created_min / created_max; rename for stable contract.
    const registrations = regsRaw.error
      ? regsRaw
      : { rows: regsRaw.rows, created_min: regsRaw.date_min, created_max: regsRaw.date_max };

    const income_structure = {};
    INCOME_VIEWS.forEach((v, i) => { income_structure[v] = incomes[i]; });

    ok(res, { jobs, registrations, hours, income_structure },
       { cache: 'public, max-age=300, s-maxage=300, must-revalidate' });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'query failed');
  }
}
