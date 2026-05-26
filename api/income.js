/* GET /api/income?section=vat|payment_type|grade|service|fleet|login_time
 *                  &from=YYYY-MM-DD&to=YYYY-MM-DD
 *                  [&fresh=1]
 *
 * Returns rows from the corresponding income_structure_* table/view.
 *
 * Default mode: reads from the Neon mirror table populated nightly by
 * /api/cron/sync-income — sub-50ms responses, survives source-DB outages.
 *
 * Pass &fresh=1 to bypass the mirror and query the upstream source DB
 * (data_access.income_structure_*) directly. Useful for "what does the
 * source say right now" checks. Adds the source-DB round-trip latency.
 */
import { query, sourceQuery, sourcePool, ok, bad,
         parseDateRange, requireAuth } from './_db.js';

const SECTIONS = {
  vat: {
    source: 'data_access.income_structure_vat',
    mirror: 'income_structure_vat',
  },
  payment_type: {
    source: 'data_access.income_structure_payment_type',
    mirror: 'income_structure_payment_type',
  },
  grade: {
    source: 'data_access.income_structure_grade',
    mirror: 'income_structure_grade',
  },
  service: {
    source: 'data_access.income_structure_service',
    mirror: 'income_structure_service',
  },
  fleet: {
    source: 'data_access.income_structure_fleet',
    mirror: 'income_structure_fleet',
  },
  login_time: {
    source: 'data_access.income_structure_login_time',
    mirror: 'income_structure_login_time',
  },
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!requireAuth(req, res)) return;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const section = (url.searchParams.get('section') || '').toLowerCase();
  if (!SECTIONS[section]) {
    return bad(res, 400, `section must be one of: ${Object.keys(SECTIONS).join(', ')}`);
  }

  let from, to;
  try {
    ({ from, to } = parseDateRange(req));
  } catch (e) {
    return bad(res, 400, e.message);
  }

  const fresh = url.searchParams.get('fresh') === '1';
  const tableInfo = SECTIONS[section];

  // Project "Date" via to_char so the wire format is a plain ISO date
  // string instead of a JS Date that the pg driver renders at UTC
  // midnight (which in UTC+2/3 looks like the previous day).
  // Pull non-Date columns from information_schema so this stays correct
  // even if either side adds columns in future.
  const colsSrcQuery = (schemaName, tableName) =>
    `SELECT string_agg(quote_ident(column_name), ', ')
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name <> 'Date'`;

  if (fresh) {
    if (!sourcePool()) return bad(res, 503, 'SOURCE_DATABASE_URL not set');
    try {
      const [schema, tbl] = tableInfo.source.split('.');
      const [{ string_agg: otherCols }] = await sourceQuery(
        colsSrcQuery(schema, tbl), [schema, tbl]
      );
      const rows = await sourceQuery(
        `SELECT to_char("Date", 'YYYY-MM-DD') AS "Date", ${otherCols}
           FROM ${tableInfo.source}
          WHERE "Date" BETWEEN $1::date AND $2::date
          ORDER BY "Date" ASC`,
        [from, to]
      );
      return ok(res, { section, source: 'live', from, to, rows });
    } catch (e) {
      console.error(e);
      const status = e.code === '42P01' || e.code === '42501' ? 503 : 500;
      return bad(res, status, e.message || 'source-DB income query failed', { code: e.code });
    }
  }

  // Default: Neon mirror.
  try {
    const [{ string_agg: otherCols }] = await query(
      colsSrcQuery('public', tableInfo.mirror), ['public', tableInfo.mirror]
    );
    const rows = await query(
      `SELECT to_char("Date", 'YYYY-MM-DD') AS "Date", ${otherCols}
         FROM ${tableInfo.mirror}
        WHERE "Date" BETWEEN $1::date AND $2::date
        ORDER BY "Date" ASC`,
      [from, to]
    );
    // Freshness signal so the frontend can warn if the cache is stale.
    const [meta] = await query(
      `SELECT MAX(synced_at) AS synced_at FROM ${tableInfo.mirror}`
    );
    ok(res, {
      section,
      source: 'cache',
      synced_at: meta?.synced_at ?? null,
      from, to, rows,
    }, { cache: 'public, max-age=60, must-revalidate' });
  } catch (e) {
    console.error(e);
    // 42P01: mirror table doesn't exist yet — cron hasn't run. Tell caller
    // they can retry with ?fresh=1 in the meantime.
    if (e.code === '42P01') {
      return bad(res, 503,
        'mirror table not initialised — run /api/cron/sync-income, or retry with ?fresh=1',
        { code: e.code });
    }
    bad(res, 500, e.message || 'income query failed', { code: e.code });
  }
}
