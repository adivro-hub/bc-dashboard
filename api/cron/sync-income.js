/* GET /api/cron/sync-income
 *
 * Nightly job (Vercel Cron) that copies the six data_access.income_structure_*
 * views from the source DB into mirror tables inside Neon. /api/income reads
 * the Neon mirror by default for sub-50ms responses; ?fresh=1 falls through
 * to the source DB on demand.
 *
 * Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. We accept
 * either that or the regular API_TOKEN, so a manual trigger also works.
 *
 * Strategy: TRUNCATE + INSERT inside one Neon transaction per view. ~28k
 * total rows across all six → completes in a few seconds. Atomic per view,
 * so a partial failure leaves the other views consistent.
 *
 * Response: { synced: { vat: { rows, ms }, ... }, total_ms }
 */
import { pool, sourcePool, ok, bad } from '../_db.js';

const VIEWS = [
  {
    section: 'vat',
    source: 'data_access.income_structure_vat',
    target: 'income_structure_vat',
    pk:     ['"Date"', '"Sales"'],
    columns: [
      ['"Date"',       'date'],
      ['"Sales"',      'text'],
      ['"Jobs"',       'numeric'],
      ['"WithoutTax"', 'numeric'],
      ['"Tax"',        'numeric'],
      ['"Total"',      'numeric'],
      ['"Earnings"',   'numeric'],
    ],
  },
  {
    section: 'payment_type',
    source: 'data_access.income_structure_payment_type',
    target: 'income_structure_payment_type',
    pk: ['"Date"', '"PaymentType"'],
    columns: [
      ['"Date"',        'date'],
      ['"PaymentType"', 'text'],
      ['"Jobs"',        'numeric'],
      ['"WithoutTax"',  'numeric'],
      ['"Tax"',         'numeric'],
      ['"Total"',       'numeric'],
      ['"Earnings"',    'numeric'],
    ],
  },
  {
    section: 'grade',
    source: 'data_access.income_structure_grade',
    target: 'income_structure_grade',
    pk: ['"Date"', '"Grade"'],
    columns: [
      ['"Date"',       'date'],
      ['"Grade"',      'text'],
      ['"Jobs"',       'numeric'],
      ['"WithoutTax"', 'numeric'],
      ['"Tax"',        'numeric'],
      ['"Total"',      'numeric'],
      ['"Earnings"',   'numeric'],
    ],
  },
  {
    section: 'service',
    source: 'data_access.income_structure_service',
    target: 'income_structure_service',
    pk: ['"Date"', '"Service"'],
    columns: [
      ['"Date"',       'date'],
      ['"Service"',    'text'],
      ['"Jobs"',       'numeric'],
      ['"WithoutTax"', 'numeric'],
      ['"Tax"',        'numeric'],
      ['"Total"',      'numeric'],
      ['"Earnings"',   'numeric'],
    ],
  },
  {
    section: 'fleet',
    source: 'data_access.income_structure_fleet',
    target: 'income_structure_fleet',
    pk: ['"Date"', '"Fleet"'],
    columns: [
      ['"Date"',       'date'],
      ['"Fleet"',      'text'],
      ['"Jobs"',       'numeric'],
      ['"WithoutTax"', 'numeric'],
      ['"Tax"',        'numeric'],
      ['"Total"',      'numeric'],
      ['"Earnings"',   'numeric'],
    ],
  },
  {
    section: 'login_time',
    source: 'data_access.income_structure_login_time',
    target: 'income_structure_login_time',
    pk: ['"Date"', '"Fleet"'],
    columns: [
      ['"Date"',  'date'],
      ['"Fleet"', 'text'],
      ['"Hours"', 'numeric'],
    ],
  },
];

function authOk(req) {
  const cronSecret = process.env.CRON_SECRET;
  const apiToken   = process.env.API_TOKEN;
  const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/, '');
  if (cronSecret && got === cronSecret) return true;
  if (apiToken   && got === apiToken)   return true;
  // If neither env var is set, allow (smoke testing in dev).
  return !cronSecret && !apiToken;
}

function ensureTableSql(v) {
  const cols = v.columns.map(([name, type]) => `${name} ${type}`).join(', ');
  return `CREATE TABLE IF NOT EXISTS ${v.target} (${cols},
    PRIMARY KEY (${v.pk.join(', ')}),
    synced_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_${v.target}_date ON ${v.target} ("Date");`;
}

async function syncOne(neonClient, v) {
  const t0 = Date.now();
  await neonClient.query(ensureTableSql(v));
  await neonClient.query('BEGIN');
  try {
    // Skip the literal "Total" rollup row the source views emit per
    // day — those are sums of the other categories and would
    // double-count downstream. v.pk[1] is the category column (e.g.
    // "Sales", "PaymentType", "Fleet") since pk[0] is always "Date".
    const categoryCol = v.pk[1];
    const sourceRows = await sourcePool().query(
      `SELECT ${v.columns.map(c => c[0]).join(', ')}
         FROM ${v.source}
        WHERE ${categoryCol} IS NOT NULL
          AND lower(trim(${categoryCol})) <> 'total'`
    );
    const cols = v.columns.map(c => c[0]).join(', ');
    const placeholders = v.columns.map((_, i) => `$${i + 1}`).join(', ');
    // UPSERT (not TRUNCATE+INSERT) so XLS-supplied days for dates the
    // source DB hasn't caught up to yet aren't wiped on each run.
    // Whenever source eventually has the data it overwrites the XLS row.
    const nonPkCols = v.columns
      .filter(c => !v.pk.includes(c[0]))
      .map(c => `${c[0]} = EXCLUDED.${c[0]}`)
      .concat([`synced_at = NOW()`])
      .join(', ');
    const upsert =
      `INSERT INTO ${v.target} (${cols}) VALUES (${placeholders})
       ON CONFLICT (${v.pk.join(', ')}) DO UPDATE SET ${nonPkCols}`;
    for (const row of sourceRows.rows) {
      const values = v.columns.map(c => {
        const key = c[0].replace(/"/g, '');
        return row[key];
      });
      await neonClient.query(upsert, values);
    }
    await neonClient.query('COMMIT');
    return { rows: sourceRows.rows.length, ms: Date.now() - t0 };
  } catch (e) {
    await neonClient.query('ROLLBACK');
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return bad(res, 405, 'GET/POST only');
  if (!authOk(req)) return bad(res, 401, 'unauthorized');
  if (!sourcePool()) return bad(res, 503, 'SOURCE_DATABASE_URL not set');

  const overall = Date.now();
  const result = {};
  const neonClient = await pool().connect();
  try {
    for (const v of VIEWS) {
      try {
        result[v.section] = await syncOne(neonClient, v);
      } catch (e) {
        console.error(`sync ${v.section} failed:`, e);
        result[v.section] = { error: e.message, code: e.code };
      }
    }
  } finally {
    neonClient.release();
  }
  ok(res, { synced: result, total_ms: Date.now() - overall });
}
