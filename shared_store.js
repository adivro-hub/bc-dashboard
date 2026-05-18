/* shared_store.js — thin wrapper around the Supabase client.
 *
 * Loads config from window.BC_CONFIG (set in config.js). When config is
 * missing or the user is signed out, every method returns a no-op result,
 * so upload.html keeps working in pure-local mode.
 */
(function(){

const CFG = window.BC_CONFIG || {};
const ENABLED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);

const client = ENABLED
  ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
  : null;

// -----------------------------------------------------------------
// Crypto helpers (browser-native SHA-256, hex)
// -----------------------------------------------------------------
async function sha256hex(input){
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const h = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// -----------------------------------------------------------------
// Auth
// -----------------------------------------------------------------
async function getSession(){
  if (!ENABLED) return null;
  const { data } = await client.auth.getSession();
  return data.session;
}
async function getEmail(){
  const s = await getSession();
  return s ? s.user.email : null;
}
async function getRole(){
  if (!ENABLED) return null;
  const email = await getEmail();
  if (!email) return null;
  const { data, error } = await client.from('members').select('role').eq('email', email).maybeSingle();
  if (error || !data) return null;
  return data.role;
}
async function signInWithEmail(email){
  if (!ENABLED) throw new Error('Supabase not configured');
  // emailRedirectTo defaults to current origin
  return client.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
}
async function signOut(){
  if (!ENABLED) return;
  await client.auth.signOut();
}

// -----------------------------------------------------------------
// Anonymise a parsed Job Analogue row before uploading to the server.
// The anonymised row keeps everything the dashboard needs and nothing
// that could re-identify a person.
// -----------------------------------------------------------------
async function anonymiseJobRow(row){
  const phone_hash   = row.phone   ? await sha256hex(row.phone)   : null;
  const vehicle_hash = row.vehicle ? await sha256hex(row.vehicle) : null;
  return {
    date:                row.date,
    account_no:          parseAccountNo(row.account_no),
    phone_hash,
    urgency:             row.urgency || null,
    status:              row.status  || null,
    service:             row.service || null,
    hour:                row.hour ?? null,
    total:               row.total ?? 0,
    driver_total:        row.driver_total ?? 0,
    response_min:        row.response_min ?? null,
    vehicle_hash,
    is_otp_pickup:       /OTP\/LROP|OTOPENI\s*Airport/i.test(row.pickup  || ''),
    is_otp_dropoff:      /OTP\/LROP|OTOPENI\s*Airport/i.test(row.dropoff || ''),
    is_no_supply_cancel: /no cars available|serviciul .*indisponibil|nicio ma[sș]in[aă]|nu vrea sa astepte|sofer de la bv/i
                           .test(row.cancel_reason || ''),
  };
}
function parseAccountNo(v){
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

async function anonymiseRegRow(row){
  return {
    created_at: row.created instanceof Date ? row.created.toISOString() : row.created,
    status:     row.status || null,
    email_hash: row.email ? await sha256hex(row.email.toLowerCase().trim()) : null,
  };
}

// -----------------------------------------------------------------
// Upserts (uploader-only via RLS)
// -----------------------------------------------------------------
async function pushIncome(parsedFile, fileBytes, sourceName){
  if (!ENABLED) throw new Error('Supabase not configured');
  const file_hash = await sha256hex(fileBytes);
  const row = {
    file_hash,
    source_name: sourceName,
    period_from: parsedFile.period_from,
    period_to:   parsedFile.period_to,
    sections:    parsedFile.sections,
    kpis:        parsedFile.kpis,
    uploaded_by: await getEmail(),
  };
  return client.from('income_files').upsert(row, { onConflict: 'file_hash' });
}
async function pushHours(parsedFile, fileBytes, sourceName){
  if (!ENABLED) throw new Error('Supabase not configured');
  const file_hash = await sha256hex(fileBytes);
  const periodStart = parsedFile.timestamps[0]?.slice(0,10) || null;
  const periodEnd   = parsedFile.timestamps[parsedFile.timestamps.length-1]?.slice(0,10) || null;
  const row = {
    file_hash,
    source_name: sourceName,
    period: parsedFile.period,
    period_start: periodStart,
    period_end:   periodEnd,
    timestamps:   parsedFile.timestamps,
    hourly:       parsedFile.hourly,
    uploaded_by:  await getEmail(),
  };
  return client.from('hours_files').upsert(row, { onConflict: 'file_hash' });
}

// Job Analogue: insert file metadata, then anonymised rows in chunks of 500.
async function pushJobs(rows, fileBytes, sourceName){
  if (!ENABLED) throw new Error('Supabase not configured');
  const file_hash = await sha256hex(fileBytes);
  const periodStart = rows.reduce((m,r) => !m || (r.date && r.date < m) ? r.date : m, null);
  const periodEnd   = rows.reduce((m,r) => !m || (r.date && r.date > m) ? r.date : m, null);

  // Upsert file row (returns id). If file_hash already exists, we skip the rows.
  const { data: existing } = await client.from('job_files').select('id').eq('file_hash', file_hash).maybeSingle();
  if (existing) return { skipped: true, file_id: existing.id };

  const { data: fileRow, error: e1 } = await client.from('job_files').insert({
    file_hash, source_name: sourceName,
    period_start: periodStart, period_end: periodEnd,
    row_count: rows.length, uploaded_by: await getEmail(),
  }).select('id').single();
  if (e1) throw e1;

  const anon = [];
  for (const r of rows){
    const a = await anonymiseJobRow(r);
    a.file_id = fileRow.id;
    anon.push(a);
  }
  // Insert in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < anon.length; i += CHUNK){
    const slice = anon.slice(i, i + CHUNK);
    const { error: e2 } = await client.from('job_rows').insert(slice);
    if (e2) throw e2;
  }
  return { inserted: anon.length, file_id: fileRow.id };
}

async function pushRegistrations(parsedFile, fileBytes, sourceName){
  if (!ENABLED) throw new Error('Supabase not configured');
  const file_hash = await sha256hex(fileBytes);
  const { data: existing } = await client.from('reg_files').select('id').eq('file_hash', file_hash).maybeSingle();
  if (existing) return { skipped: true, file_id: existing.id };

  const { data: fileRow, error: e1 } = await client.from('reg_files').insert({
    file_hash, source_name: sourceName, uploaded_by: await getEmail(),
  }).select('id').single();
  if (e1) throw e1;

  const anon = [];
  for (const r of parsedFile.rows){
    const a = await anonymiseRegRow(r);
    a.file_id = fileRow.id;
    anon.push(a);
  }
  const CHUNK = 500;
  for (let i = 0; i < anon.length; i += CHUNK){
    const slice = anon.slice(i, i + CHUNK);
    const { error: e2 } = await client.from('reg_rows').insert(slice);
    if (e2) throw e2;
  }
  return { inserted: anon.length, file_id: fileRow.id };
}

async function pushAccountNames(map){
  // map: { [account_no]: name }
  if (!ENABLED) throw new Error('Supabase not configured');
  const rows = Object.entries(map)
    .map(([k,v]) => ({ account_no: parseInt(k,10), name: v }))
    .filter(r => Number.isFinite(r.account_no) && r.name);
  if (!rows.length) return { inserted: 0 };
  const { error } = await client.from('account_names').upsert(rows, { onConflict: 'account_no' });
  if (error) throw error;
  return { inserted: rows.length };
}

// -----------------------------------------------------------------
// Reads (any signed-in member)
// -----------------------------------------------------------------
// Supabase caps a single SELECT at 1000 rows by default. job_rows easily
// runs to 50k+, so we paginate with .range() until a short page comes back.
async function fetchAll(table, orderBy){
  const PAGE = 1000;
  let out = [];
  let from = 0;
  while (true){
    const q = client.from(table).select('*').order(orderBy).range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || !data.length) break;
    out = out.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function loadAll(progress){
  if (!ENABLED) throw new Error('Supabase not configured');
  const note = (msg) => { if (progress) progress(msg); };
  note('Loading income files…');
  const income     = await fetchAll('income_files', 'period_from');
  note('Loading hours files…');
  const hours      = await fetchAll('hours_files',  'period_start');
  note('Loading job files…');
  const jobsFiles  = await fetchAll('job_files',    'period_start');
  note('Loading registration files…');
  const regFiles   = await fetchAll('reg_files',    'uploaded_at');
  note('Loading account names…');
  const names      = await fetchAll('account_names','account_no');
  note('Loading job rows (this is the big one)…');
  const jobsRows   = await fetchAll('job_rows',     'date');
  note('Loading registration rows…');
  const regRows    = await fetchAll('reg_rows',     'created_at');
  return {
    income_files: income,
    hours_files:  hours,
    job_files:    jobsFiles,
    job_rows:     jobsRows,
    reg_files:    regFiles,
    reg_rows:     regRows,
    account_names: Object.fromEntries(names.map(r => [r.account_no, r.name])),
  };
}

window.BCStore = {
  enabled: ENABLED,
  client,
  sha256hex,
  // auth
  getSession, getEmail, getRole, signInWithEmail, signOut,
  // pushes
  pushIncome, pushHours, pushJobs, pushRegistrations, pushAccountNames,
  // anonymise helpers (exposed so the upload page can show a preview)
  anonymiseJobRow, anonymiseRegRow,
  // reads
  loadAll,
};

})();
