/* shared_store_neon.js — Neon-backed BCStore.
 *
 * Drop-in replacement for shared_store.js. Method signatures and return
 * shapes match what dashboard.js / upload.js already consume from the
 * old `BCStore`. Differences live behind the seam:
 *   - Auth is HTTP-cookie JWT via /api/auth/*, not Supabase
 *   - Reads come from /api/coverage, /api/job-rows, /api/reg-rows,
 *     /api/account-names instead of Supabase rest calls
 *   - Pushes (upload-side) currently throw. The new ingestion happens
 *     server-side via the Python scripts; we can add upload endpoints
 *     later if we want browser uploads back.
 *
 * The frontend's STORE shape is preserved 1:1 so charts and filters
 * don't need to change.
 */
(function(){

const PAGE_SIZE = 5000;

// -----------------------------------------------------------------
// Tiny fetch helpers
// -----------------------------------------------------------------
async function getJson(url){
  const r = await fetch(url, { credentials: 'same-origin' });
  if (r.status === 401) throw new Error('not signed in');
  if (!r.ok) {
    let body = ''; try { body = await r.text(); } catch {}
    throw new Error(`GET ${url} → ${r.status} ${body.slice(0, 200)}`);
  }
  return r.json();
}
async function postJson(url, body){
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) {
    let txt = ''; try { txt = await r.text(); } catch {}
    throw new Error(`POST ${url} → ${r.status} ${txt.slice(0, 200)}`);
  }
  return r.json();
}

// -----------------------------------------------------------------
// Auth
// -----------------------------------------------------------------
let _cachedSession = undefined;     // undefined = not checked yet
async function refreshSession(){
  try { _cachedSession = await getJson('/api/auth/me'); }
  catch { _cachedSession = null; }
  return _cachedSession;
}
async function getSession(){
  if (_cachedSession === undefined) await refreshSession();
  return _cachedSession;
}
async function getEmail(){
  const s = await getSession();
  return s ? s.email : null;
}
async function getRole(){
  const s = await getSession();
  return s ? (s.role || 'viewer') : null;
}
async function signInWithEmail(email){
  await postJson('/api/auth/login', { email });
  // The user goes to their inbox; /api/auth/verify will redirect them
  // back to '/' with a session cookie set, at which point the next
  // page load picks up the session.
  return { data: { sent: true }, error: null };
}
async function signOut(){
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
  _cachedSession = null;
}

// -----------------------------------------------------------------
// Paginated row fetch
// -----------------------------------------------------------------
async function fetchAllPaged(baseUrl){
  let out = [];
  let offset = 0;
  while (true) {
    const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}offset=${offset}&limit=${PAGE_SIZE}`;
    const body = await getJson(url);
    if (body.rows && body.rows.length) out = out.concat(body.rows);
    if (body.next_offset == null) break;
    offset = body.next_offset;
  }
  return out;
}

async function loadJobRowsForRange(from, to){
  return fetchAllPaged(`/api/job-rows?from=${from}&to=${to}`);
}
async function loadRegRowsForRange(from, to){
  return fetchAllPaged(`/api/reg-rows?from=${from}&to=${to}`);
}

// On-demand income aggregation for a date range. Returns the "sections"
// shape dashboard.js renders: sales / payment_type / customer_grade /
// service / fleet / driver_hours buckets, each keyed by category name.
// upload.js prefers this over BCParsers.aggregateIncome() when present.
async function loadIncomeForRange(from, to){
  return getJson(`/api/income-bundle?from=${from}&to=${to}`);
}

// -----------------------------------------------------------------
// Metadata (coverage + account_names + synthetic "file" objects)
//
// The legacy frontend expects arrays of "files" with id / source_name /
// period_start / period_end / row_count etc. We don't have files in
// Neon — just continuous data. So we synthesise a single "file" per
// dataset covering the whole data range, plus a pseudo job_files entry.
// That keeps the dashboard's coverage chip + period pickers working
// without rewriting them.
// -----------------------------------------------------------------
function synthFile(prefix, dateMin, dateMax, rowCount){
  return [{
    id: `${prefix}-neon`,
    source_name: `${prefix} (Neon)`,
    period_start: dateMin,
    period_end:   dateMax,
    period_from:  dateMin,
    period_to:    dateMax,
    row_count:    rowCount,
    uploaded_at:  new Date().toISOString(),
    uploaded_by:  null,
    sections:     null,
    kpis:         null,
    timestamps:   [],
    hourly:       null,
  }];
}

async function loadMetadata(progress){
  const note = (m) => { if (progress) progress(m); };
  note('Loading metadata…');
  const [coverage, names] = await Promise.all([
    getJson('/api/coverage'),
    getJson('/api/account-names'),
  ]);

  const j   = coverage.jobs || {};
  const r   = coverage.registrations || {};
  const inc = coverage.income_structure || {};
  const incRows = Object.values(inc).reduce((acc, v) => acc + (v && v.rows || 0), 0);
  // Best-effort date bounds for income — first non-error view we find.
  let incMin = null, incMax = null;
  for (const v of Object.values(inc)) {
    if (v && v.date_min && (!incMin || v.date_min < incMin)) incMin = v.date_min;
    if (v && v.date_max && (!incMax || v.date_max > incMax)) incMax = v.date_max;
  }
  // Registrations come back as ISO strings; we want just the date part.
  const regMin = r.created_min ? String(r.created_min).slice(0, 10) : null;
  const regMax = r.created_max ? String(r.created_max).slice(0, 10) : null;

  return {
    income_files: incMin && incMax ? synthFile('income', incMin, incMax, incRows) : [],
    hours_files:  [],   // wire up once hour_statistics mirror lands
    job_files:    j.date_min ? synthFile('jobs', j.date_min, j.date_max, j.rows || 0) : [],
    reg_files:    regMin ? synthFile('registrations', regMin, regMax, r.rows || 0) : [],
    account_names: (names && names.account_names) || {},
  };
}

async function loadAll(progress){
  const meta = await loadMetadata(progress);
  // Match the legacy contract: empty rows here — the dashboard pulls
  // row data on-demand via loadJobRowsForRange / loadRegRowsForRange.
  return { ...meta, job_rows: [], reg_rows: [] };
}

// -----------------------------------------------------------------
// Push methods — currently disabled
// -----------------------------------------------------------------
function pushDisabled(name){
  return async () => {
    throw new Error(
      `${name}: browser uploads are disabled in the Neon backend. ` +
      `Data is ingested server-side via the Python scripts in the repo. ` +
      `Re-enable this later by adding /api/ingest/* endpoints.`
    );
  };
}

// -----------------------------------------------------------------
// Anonymise helpers — kept for backward compat with upload.html
// previews. They mirror what shared_store.js used to do client-side.
// -----------------------------------------------------------------
async function sha256hex(input){
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const h = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function parseAccountNo(v){
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
async function anonymiseJobRow(row){
  const phone_hash   = row.phone   ? await sha256hex(row.phone)   : null;
  const vehicle_hash = row.vehicle ? await sha256hex(row.vehicle) : null;
  return {
    date: row.date,
    account_no: parseAccountNo(row.account_no),
    phone_hash,
    urgency: row.urgency || null,
    status:  row.status  || null,
    service: row.service || null,
    hour:    row.hour ?? null,
    total:   row.total ?? 0,
    driver_total: row.driver_total ?? 0,
    response_min: row.response_min ?? null,
    vehicle_hash,
    is_otp_pickup:       /OTP\/LROP|OTOPENI\s*Airport/i.test(row.pickup  || ''),
    is_otp_dropoff:      /OTP\/LROP|OTOPENI\s*Airport/i.test(row.dropoff || ''),
    is_no_supply_cancel: /no cars available|serviciul .*indisponibil|nicio ma[sș]in[aă]|nu vrea sa astepte|sofer de la bv/i
                           .test(row.cancel_reason || ''),
  };
}
async function anonymiseRegRow(row){
  return {
    created_at: row.created instanceof Date ? row.created.toISOString() : row.created,
    status:     row.status || null,
    email_hash: row.email ? await sha256hex(row.email.toLowerCase().trim()) : null,
  };
}

window.BCStore = {
  enabled: true,
  client: null,                  // legacy field; nothing reads it
  sha256hex,
  // auth
  getSession, getEmail, getRole, signInWithEmail, signOut,
  // pushes (disabled in Neon backend)
  pushIncome:        pushDisabled('pushIncome'),
  pushHours:         pushDisabled('pushHours'),
  pushJobs:          pushDisabled('pushJobs'),
  pushRegistrations: pushDisabled('pushRegistrations'),
  pushAccountNames:  pushDisabled('pushAccountNames'),
  // anonymise helpers (kept for preview UIs)
  anonymiseJobRow, anonymiseRegRow,
  // reads
  loadAll, loadMetadata, loadJobRowsForRange, loadRegRowsForRange,
  loadIncomeForRange,
};

})();
