/* parsers.js — pure-browser ports of the Python build scripts.
 *
 * Each function takes raw SheetJS worksheet data (from XLSX.read) for a SINGLE
 * file (one week's worth) and returns the parsed structure for that week.
 * Combine current+previous outputs into the final payload shape expected by
 * dashboard.js.
 *
 * Depends on: SheetJS (xlsx).
 */
(function(){

// ---------- shared helpers ----------
function toNum(v){
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toStr(v){
  if (v == null) return '';
  return String(v).trim();
}

// SheetJS returns dates as either Date objects (cellDates:true) or Excel serials.
// Convert anything to JS Date.
function toDate(v){
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number'){
    // Excel serial date - days since 1899-12-30
    const ms = (v - 25569) * 86400 * 1000;
    return new Date(ms);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function isoDate(d){
  if (!d) return null;
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function hourOf(v){
  if (v == null) return null;
  if (v instanceof Date) return v.getHours();
  if (typeof v === 'number'){
    // Excel time (fraction of a day) or full datetime serial
    const dayFrac = v % 1;
    return Math.floor(dayFrac * 24);
  }
  const s = String(v).trim();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return parseInt(m[1], 10);
  const d = new Date(s);
  return isNaN(d) ? null : d.getHours();
}

// Convert a time-like value to minutes (for Response Time etc.)
function timeToMinutes(v){
  if (v == null) return null;
  if (v instanceof Date) return v.getHours()*60 + v.getMinutes() + v.getSeconds()/60;
  if (typeof v === 'number'){
    // Fraction of a day
    const frac = v % 1;
    return frac * 24 * 60;
  }
  const s = String(v).trim();
  if (!s) return null;
  const parts = s.split('.')[0].split(':');
  if (parts.length === 3) return (+parts[0])*60 + (+parts[1]) + (+parts[2])/60;
  if (parts.length === 2) return (+parts[0])*60 + (+parts[1]);
  return null;
}

// Read a sheet to an array of row-arrays (header == null).
function sheetToRows(workbook, sheetName){
  const ws = workbook.Sheets[sheetName || workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false});
}

// =====================================================================
// 1) INCOME STRUCTURE  (build_dashboard.py port)
// =====================================================================
const INCOME_SECTION_HEADERS = {
  "Sales": "sales",
  "Sales By Payment Type": "payment_type",
  "Sales by Customer Grade": "customer_grade",
  "Sales by Service": "service",
  "Sales by Fleet": "fleet",
  "Driver Login Time by Fleet (hours)": "driver_hours",
};

function parseIncome(workbook){
  // Use blankrows:true so indices stay stable; sniff "From:"/"To:" by content
  // rather than fixed positions, and walk every row looking for section headers.
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:true});
  if (!rows || rows.length < 5) throw new Error("Income Structure: not enough rows");

  // Find From/To dates anywhere in the first few rows
  let periodFrom = null, periodTo = null;
  for (let i = 0; i < Math.min(rows.length, 10); i++){
    const r = rows[i] || [];
    for (let j = 0; j < r.length - 1; j++){
      const tag = toStr(r[j]);
      if (tag === "From:") periodFrom = isoDate(toDate(r[j+1]));
      if (tag === "To:")   periodTo   = isoDate(toDate(r[j+1]));
    }
  }

  const sections = {};
  for (const k of Object.values(INCOME_SECTION_HEADERS)) sections[k] = {};
  let current = null;

  for (let i = 0; i < rows.length; i++){
    const r = rows[i];
    if (!r) continue;
    const label = toStr(r[0]);
    if (!label) continue;
    if (INCOME_SECTION_HEADERS[label]){ current = INCOME_SECTION_HEADERS[label]; continue; }
    if (!current) continue;
    if (label.toLowerCase().startsWith("total")) continue;
    sections[current][label] = {
      jobs:        toNum(r[1]),
      without_vat: toNum(r[2]),
      vat:         toNum(r[3]),
      total:       toNum(r[4]),
      earnings:    toNum(r[5]),
    };
  }

  // KPIs from "Sales" section
  const withVat = sections.sales["Sales with VAT"]  || {jobs:0,without_vat:0,vat:0,total:0,earnings:0};
  const noVat   = sections.sales["Sales with No VAT"] || {jobs:0,without_vat:0,vat:0,total:0,earnings:0};
  const jobs        = withVat.jobs + noVat.jobs;
  const total       = withVat.total + noVat.total;
  const kpis = {
    jobs,
    without_vat: withVat.without_vat + noVat.without_vat,
    vat:         withVat.vat + noVat.vat,
    total,
    earnings:    withVat.earnings + noVat.earnings,
    avg_per_job: jobs ? total / jobs : 0,
  };

  return { period_from: periodFrom, period_to: periodTo, sections, kpis };
}

// =====================================================================
// 2) JOB ANALOGUE  (build_jobs.py port)
// =====================================================================
function parseJobAnalogue(workbook){
  // Header row is row index 3 (zero-based). Use sheet_to_json with range to skip first 3 rows.
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false, range:3});
  if (!rows.length) return [];
  const header = rows[0].map(h => toStr(h));
  const idx = (name) => header.indexOf(name);
  const colAccountNo   = idx("Account Number");
  const colAccountName = idx("Account Name");
  const colJobNo       = idx("Job Number");
  const colUrgency     = idx("Urgency");
  const colStatus      = idx("Status");
  const colService     = idx("Service");
  const colJobTime     = idx("Job Time");
  const colTotal       = idx("Total Price");
  const colDriverTotal = idx("Driver Total Price");

  const out = [];
  for (let i = 1; i < rows.length; i++){
    const r = rows[i];
    if (!r) continue;
    const accNo = r[colAccountNo];
    const jobNo = r[colJobNo];
    if (accNo == null && jobNo == null) continue;
    const accNoStr = (typeof accNo === 'number' && Number.isInteger(accNo))
                       ? String(accNo) : toStr(accNo);
    out.push({
      account_no:   accNoStr,
      account_name: toStr(r[colAccountName]),
      job_no:       toStr(r[colJobNo]),
      urgency:      toStr(r[colUrgency]),
      status:       toStr(r[colStatus]),
      service:      toStr(r[colService]),
      hour:         hourOf(r[colJobTime]),
      total:        toNum(r[colTotal]),
      driver_total: toNum(r[colDriverTotal]),
    });
  }
  return out;
}

// =====================================================================
// 3) HOUR STATISTICS  (build_hours.py port)
// =====================================================================
const HOURS_METRIC_KEY = {
  "Number of jobs booked ASAP": "jobs_asap",
  "Number of jobs booked Preebook": "jobs_prebook",
  "Number of cancelled jobs": "jobs_cancelled",
  "Number of completed jobs": "jobs_completed",
  "Number of vehicles online": "online",
  "Number of vehicles doing job": "doing_job",
  "Number of vehicles in rank": "in_rank",
  "Number of vehicles empty": "empty",
  "Number of vehicles on break": "on_break",
  "Number of vehicles going home": "going_home",
  "Number of vehicles logged off": "logged_off",
  "Number of vehicles with status unknown": "unknown",
};
const HOURLY_HEADER_RE = /^(\d{2}\/\d{2}\/\d{2}) (\d{2}):00$/;

function parseHours(workbook){
  const rows = sheetToRows(workbook, "Average");
  if (!rows.length) throw new Error("Hour Statistics: empty");
  const headers = rows[0].map(h => h == null ? "" : String(h).trim());
  const period = headers[0];

  // Build list of [colIdx, Date] for hourly columns
  const hourlyCols = [];
  for (let i = 0; i < headers.length; i++){
    const m = HOURLY_HEADER_RE.exec(headers[i]);
    if (m){
      const [, dStr, hStr] = m;
      const [dd, mm, yy] = dStr.split('/').map(s=>parseInt(s,10));
      const ts = new Date(2000+yy, mm-1, dd, parseInt(hStr,10));
      hourlyCols.push([i, ts]);
    }
  }

  // Map metric label -> row index
  const labelToRow = {};
  for (let r = 1; r < rows.length; r++){
    const lbl = rows[r] && typeof rows[r][0] === 'string' ? rows[r][0].trim() : null;
    if (lbl) labelToRow[lbl] = r;
  }

  const series = {};
  for (const k of Object.values(HOURS_METRIC_KEY)) series[k] = [];

  for (const [nice, key] of Object.entries(HOURS_METRIC_KEY)){
    const ri = labelToRow[nice];
    if (ri == null){ series[key] = new Array(hourlyCols.length).fill(0); continue; }
    series[key] = hourlyCols.map(([ci, _]) => toNum(rows[ri][ci]));
  }

  // by_hour_of_day rollup
  const byHour = {};
  for (const k of Object.values(HOURS_METRIC_KEY)) byHour[k] = new Array(24).fill(0);
  const counts = new Array(24).fill(0);
  hourlyCols.forEach(([_, ts], idx)=>{
    const h = ts.getHours();
    counts[h]++;
    for (const k of Object.values(HOURS_METRIC_KEY)){
      byHour[k][h] += series[k][idx];
    }
  });
  for (const k of Object.keys(byHour)){
    byHour[k] = byHour[k].map((v,h) => counts[h] ? v/counts[h] : 0);
  }

  // Derived
  const onlineTotal  = series.online.reduce((s,v)=>s+v,0);
  const onBreakTotal = series.on_break.reduce((s,v)=>s+v,0);
  const busyTotal    = series.doing_job.reduce((s,v)=>s+v,0);
  const availableTotal = onlineTotal - onBreakTotal;
  const derived = {
    available_total: availableTotal,
    busy_total:      busyTotal,
    online_total:    onlineTotal,
    on_break_total:  onBreakTotal,
    util_avg:        availableTotal ? busyTotal/availableTotal : 0,
    peak_available:  Math.max(...series.online.map((o,i)=>o - series.on_break[i])),
    peak_busy:       Math.max(...series.doing_job),
  };

  return {
    period,
    timestamps: hourlyCols.map(([_, ts]) => ts.toISOString()),
    hourly: series,
    by_hour_of_day: byHour,
    derived,
  };
}

// =====================================================================
// 4) REGISTRATIONS  (build_reg.py port)
// =====================================================================
function parseRegistrations(files /* array of {name, workbook} */){
  // returns { summary: {current:{}, previous:{}}, files: [...] }
  const PERIODS = {
    current:  null,  // filled below from the dates we see
    previous: null,
  };
  // We don't know which file is which week up-front. Use the dates inside.

  const allRows = [];   // {email, created: Date, status, src}
  const fileInfo = [];
  for (const {name, workbook} of files){
    const ws = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false});
    if (!data.length) continue;
    const header = data[0].map(h => toStr(h));
    const iEmail   = header.indexOf("Email");
    const iStatus  = header.indexOf("Status");
    const iCreated = header.indexOf("Created At");
    let minD = null, maxD = null, count = 0;
    for (let i = 1; i < data.length; i++){
      const r = data[i]; if (!r) continue;
      const d = toDate(r[iCreated]);
      if (!d) continue;
      allRows.push({
        email:   toStr(r[iEmail]),
        created: d,
        status:  toStr(r[iStatus]),
        src:     name,
      });
      if (!minD || d < minD) minD = d;
      if (!maxD || d > maxD) maxD = d;
      count++;
    }
    fileInfo.push({
      file: name,
      rows: count,
      min:  minD ? minD.toISOString() : null,
      max:  maxD ? maxD.toISOString() : null,
    });
  }

  if (!allRows.length){
    return { summary: { current: emptyReg(), previous: emptyReg() }, files: fileInfo,
             deduped_rows_dropped: 0, rows_outside_either_week: 0 };
  }

  // Determine the two week boundaries based on min/max dates.
  // Each file likely covers one week. Sort files by min date.
  const filesByMin = [...fileInfo].sort((a,b)=> new Date(a.min) - new Date(b.min));
  // The earlier file is "previous", the later is "current".
  const prevFile = filesByMin[0];
  const curFile  = filesByMin[filesByMin.length - 1];

  function dayFloor(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }
  // periods: from min of file to min + 7 days (exclusive)
  PERIODS.current  = curFile  ? [dayFloor(new Date(curFile.min)),  new Date(dayFloor(new Date(curFile.min)).getTime() + 7*86400*1000)] : null;
  PERIODS.previous = prevFile ? [dayFloor(new Date(prevFile.min)), new Date(dayFloor(new Date(prevFile.min)).getTime() + 7*86400*1000)] : null;

  // Dedup by (email, created)
  const seen = new Set();
  const deduped = [];
  let dropped = 0;
  for (const r of allRows){
    const key = `${r.email}|${r.created.getTime()}`;
    if (seen.has(key)){ dropped++; continue; }
    seen.add(key);
    deduped.push(r);
  }

  function assignPeriod(d){
    for (const key of ['current','previous']){
      const p = PERIODS[key];
      if (p && d >= p[0] && d < p[1]) return key;
    }
    return null;
  }
  function emptyReg(){ return { total: 0, by_status: {}, daily: {} }; }

  const summary = { current: emptyReg(), previous: emptyReg() };
  let outOfRange = 0;
  for (const r of deduped){
    const k = assignPeriod(r.created);
    if (!k){ outOfRange++; continue; }
    const s = summary[k];
    s.total++;
    const st = r.status || '(unknown)';
    s.by_status[st] = (s.by_status[st] || 0) + 1;
    const d = isoDate(dayFloor(r.created));
    s.daily[d] = (s.daily[d] || 0) + 1;
  }
  return { summary, files: fileInfo, deduped_rows_dropped: dropped, rows_outside_either_week: outOfRange };
}

// =====================================================================
// 5) OTP AIRPORT  (build_otp.py port)
// =====================================================================
const OTP_AIRPORT_RE = /OTP\/LROP|OTOPENI\s*Airport/i;

function buildOtp(jobsByWeek){
  // jobsByWeek: { current: [rows], previous: [rows] }  (need raw rows with Pick Up/Drop Off)
  // For OTP we need full pickup/dropoff text, which our compact jobs.json doesn't keep.
  // So we get them passed in separately as { current: [{pickup, dropoff, service, total}], ... }
  function aggregate(rows, side){
    const out = {};
    for (const r of rows){
      const text = r[side] || '';
      if (!OTP_AIRPORT_RE.test(text)) continue;
      const s = r.service || '(blank)';
      if (!out[s]) out[s] = { jobs: 0, total: 0 };
      out[s].jobs += 1;
      out[s].total += r.total || 0;
    }
    return out;
  }
  return {
    current:  { pickup: aggregate(jobsByWeek.current,  'pickup'), dropoff: aggregate(jobsByWeek.current,  'dropoff') },
    previous: { pickup: aggregate(jobsByWeek.previous, 'pickup'), dropoff: aggregate(jobsByWeek.previous, 'dropoff') },
  };
}

// Variant of Job Analogue parser that also returns pickup/dropoff text — needed for OTP.
function parseJobAnalogueWithLocations(workbook){
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false, range:3});
  if (!rows.length) return [];
  const header = rows[0].map(h => toStr(h));
  const idx = name => header.indexOf(name);
  const iPickup   = idx("Pick Up");
  const iDrop     = idx("Drop Off");
  const iService  = idx("Service");
  const iTotal    = idx("Total Price");
  const out = [];
  for (let i = 1; i < rows.length; i++){
    const r = rows[i]; if (!r) continue;
    out.push({
      pickup:  toStr(r[iPickup]),
      dropoff: toStr(r[iDrop]),
      service: toStr(r[iService]),
      total:   toNum(r[iTotal]),
    });
  }
  return out;
}

// =====================================================================
// 6) TOP CLIENTS  (build_top_clients.py port)
// =====================================================================
const PUBLIC_ACCOUNT = "110000";
const EXCLUDED_CORP = new Set(["120297", "901100", "110003"]);
const TOP_N = 25;

function normalisePhone(v){
  if (v == null) return "";
  const s = String(v).trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, '');
  if (!digits) return "";
  if (/^0+$/.test(digits)) return "";
  return digits;
}

function buildTopClients(workbooks){
  // workbooks: { current: workbook, previous: workbook }
  // Parse each Job Analogue with Account+Phone+Total+Driver+Vehicle.
  function parseFull(workbook){
    const ws = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false, range:3});
    if (!rows.length) return [];
    const header = rows[0].map(h => toStr(h));
    const iAcc   = header.indexOf("Account Number");
    const iName  = header.indexOf("Account Name");
    const iJob   = header.indexOf("Job Number");
    const iPhone = header.indexOf("Passenger Telephone");
    const iTotal = header.indexOf("Total Price");
    const iDrv   = header.indexOf("Driver Total Price");
    const out = [];
    for (let i = 1; i < rows.length; i++){
      const r = rows[i]; if (!r) continue;
      const accNo = r[iAcc];
      const accNoStr = (typeof accNo === 'number' && Number.isInteger(accNo))
                         ? String(accNo) : toStr(accNo);
      if (!accNoStr) continue;
      out.push({
        account_no:   accNoStr,
        account_name: toStr(r[iName]),
        job_no:       toStr(r[iJob]),
        phone:        normalisePhone(r[iPhone]),
        total:        toNum(r[iTotal]),
        driver:       toNum(r[iDrv]),
      });
    }
    return out;
  }

  const curRows  = parseFull(workbooks.current);
  const prevRows = parseFull(workbooks.previous);

  function aggregate(rows, keyFn, filterFn){
    const out = {};
    for (const r of rows){
      if (filterFn && !filterFn(r)) continue;
      const k = keyFn(r);
      if (!out[k]) out[k] = { jobs: 0, total: 0, driver: 0 };
      out[k].jobs++; out[k].total += r.total; out[k].driver += r.driver;
    }
    return out;
  }

  // RETAIL — Public Account, group by phone, exclude empty/0000
  const isRetail = r => r.account_no === PUBLIC_ACCOUNT && r.phone !== "";
  const curRetail  = aggregate(curRows,  r => r.phone, isRetail);
  const prevRetail = aggregate(prevRows, r => r.phone, isRetail);

  // CORPORATE — non-Public, non-excluded
  const isCorp = r => r.account_no && r.account_no !== PUBLIC_ACCOUNT && !EXCLUDED_CORP.has(r.account_no);
  const curCorp  = aggregate(curRows,  r => r.account_no, isCorp);
  const prevCorp = aggregate(prevRows, r => r.account_no, isCorp);

  // Account name map
  const nameMap = {};
  for (const r of [...curRows, ...prevRows]){
    if (isCorp(r) && r.account_name && !nameMap[r.account_no]){
      nameMap[r.account_no] = r.account_name;
    }
  }

  function rank(cur, prev, valueToLabel){
    const keys = new Set([...Object.keys(cur), ...Object.keys(prev)]);
    const rows = [];
    for (const k of keys){
      const c = cur[k] || {jobs:0,total:0,driver:0};
      const p = prev[k] || {jobs:0,total:0,driver:0};
      rows.push({
        _key: k,
        cur_jobs: c.jobs, cur_total: c.total, cur_earnings: c.total - c.driver,
        prev_jobs: p.jobs, prev_total: p.total, prev_earnings: p.total - p.driver,
        combined_jobs: c.jobs + p.jobs,
        combined_total: c.total + p.total,
        combined_earnings: (c.total - c.driver) + (p.total - p.driver),
      });
    }
    rows.sort((a,b) => b.combined_jobs - a.combined_jobs || b.combined_total - a.combined_total);
    const top = rows.slice(0, TOP_N);
    for (const r of top){
      Object.assign(r, valueToLabel(r._key));
      delete r._key;
    }
    return top;
  }

  const retailTop = rank(curRetail, prevRetail, k => ({ client_id: "" }));
  retailTop.forEach((r,i) => r.client_id = `Client #${i+1}`);

  const corpTop = rank(curCorp, prevCorp, k => ({
    account_no:   isNaN(+k) ? k : +k,
    account_name: nameMap[k] || "",
  }));

  function totalRevenue(rows, filter){
    let t = 0; for (const r of rows) if (filter(r)) t += r.total; return t;
  }
  function uniqueKey(rows, filter, key){
    const s = new Set(); for (const r of rows) if (filter(r)) s.add(key(r)); return s.size;
  }
  const retail_ctx = {
    cur_clients:  uniqueKey(curRows,  isRetail, r => r.phone),
    prev_clients: uniqueKey(prevRows, isRetail, r => r.phone),
    cur_total:    totalRevenue(curRows,  isRetail),
    prev_total:   totalRevenue(prevRows, isRetail),
  };
  const corp_ctx = {
    cur_clients:  uniqueKey(curRows,  isCorp, r => r.account_no),
    prev_clients: uniqueKey(prevRows, isCorp, r => r.account_no),
    cur_total:    totalRevenue(curRows,  isCorp),
    prev_total:   totalRevenue(prevRows, isCorp),
  };

  return {
    retail:    { top: retailTop, context: retail_ctx },
    corporate: { top: corpTop,   context: corp_ctx },
  };
}

// =====================================================================
// 7) OPERATIONAL KPIs  (build_kpis.py port)
// =====================================================================
const SUPPLY_RE = /no cars available|serviciul .*indisponibil|nicio ma[sș]in[aă]|nu vrea sa astepte|sofer de la bv/i;

function buildKpis(jobWorkbooks, hoursParsed, incomeParsed){
  // jobWorkbooks: { current, previous }
  // hoursParsed:  { current, previous } from parseHours
  // incomeParsed: { current, previous } from parseIncome
  function compute(workbook, hoursBlock){
    const ws = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false, range:3});
    const header = rows[0].map(h => toStr(h));
    const iStatus = header.indexOf("Status");
    const iCancel = header.indexOf("Cancel Reason");
    const iUrg    = header.indexOf("Urgency");
    const iVeh    = header.indexOf("Vehicle Reg Number");
    const iResp   = header.indexOf("Response Time");
    const iTotal  = header.indexOf("Total Price");
    const iDrv    = header.indexOf("Driver Total Price");

    const allRows = rows.slice(1);
    const done    = allRows.filter(r => toStr(r[iStatus]) === "DONE");
    const cancel  = allRows.filter(r => toStr(r[iStatus]) === "CANCELLED");
    const total_b = allRows.length;

    const vehicles = new Set();
    for (const r of done){
      const v = toStr(r[iVeh]); if (v) vehicles.add(v);
    }
    const onlineHours = hoursBlock.derived.online_total;

    const lphd = vehicles.size ? onlineHours / vehicles.size / 7 : 0;
    const jph  = onlineHours ? done.length / onlineHours : 0;

    const noSupply = cancel.filter(r => SUPPLY_RE.test(toStr(r[iCancel]))).length;

    // ASAP DONE response times
    const asapDone = done.filter(r => toStr(r[iUrg]).toUpperCase() === "ASAP");
    const respMin = [];
    for (const r of asapDone){
      const m = timeToMinutes(r[iResp]);
      if (m != null) respMin.push(m);
    }
    function mean(a){ return a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0; }
    function median(a){
      if (!a.length) return 0;
      const s = [...a].sort((x,y)=>x-y);
      const m = s.length>>1;
      return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
    }
    const ful = (done.length + cancel.length)
                  ? (done.length/(done.length+cancel.length))*100 : 0;

    const totPrice = done.reduce((s,r)=>s+toNum(r[iTotal]), 0);
    const drvPrice = done.reduce((s,r)=>s+toNum(r[iDrv]),   0);
    const commission = totPrice - drvPrice;

    return {
      total_login_hours:       onlineHours,
      login_h_per_car_per_day: lphd,
      unique_active_vehicles:  vehicles.size,
      fleet_utilisation_pct:   hoursBlock.derived.util_avg * 100,
      jobs_per_online_hour:    jph,
      no_supply_cancels:       noSupply,
      no_supply_pct_of_cancel: cancel.length ? (noSupply/cancel.length)*100 : 0,
      avg_time_to_pickup_min:  mean(respMin),
      median_time_to_pickup_min: median(respMin),
      asap_done_jobs:          asapDone.length,
      fulfilment_rate_pct:     ful,
      request_to_paid_pct:     ful,
      done_jobs:               done.length,
      cancelled_jobs:          cancel.length,
      total_bookings:          total_b,
      total_price:             totPrice,
      driver_price:            drvPrice,
      gross_commission:        commission,
    };
  }
  return {
    current:  compute(jobWorkbooks.current,  hoursParsed.current),
    previous: compute(jobWorkbooks.previous, hoursParsed.previous),
  };
}

// =====================================================================
// FILE-TYPE AUTO-DETECTION
// =====================================================================
function detectFileType(workbook){
  const sheetNames = workbook.SheetNames;
  if (sheetNames.includes("Average")){
    return "hours";
  }
  const ws = workbook.Sheets[sheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null, blankrows:false, range:0});
  if (!rows.length) return "unknown";
  const r0 = (rows[0] || []).map(c => toStr(c));
  // Income Structure starts with "Miiles Report Sales Volume"
  if (r0[0] && /Miiles Report/i.test(r0[0])) return "income";
  // Registration: header at row 0 contains "Email", "Mobile Phone", "Created At"
  if (r0.includes("Email") && r0.includes("Created At")) return "registrations";
  // Job Analogue: first row has "From:" in col A. The header row may end up at
  // output index 2 or 3 depending on whether the blank separator row is kept,
  // so probe both.
  if (r0[0] && /^From:/i.test(r0[0])){
    for (const probe of [rows[2], rows[3]]){
      const r = (probe || []).map(c => toStr(c));
      if (r.includes("Account Number") && r.includes("Job Number")) return "jobs";
    }
  }
  return "unknown";
}

// =====================================================================
// PUBLIC API
// =====================================================================
window.BCParsers = {
  parseIncome,
  parseJobAnalogue,
  parseJobAnalogueWithLocations,
  parseHours,
  parseRegistrations,
  buildOtp,
  buildTopClients,
  buildKpis,
  detectFileType,
  // helpers exposed for upload.js
  toDate, isoDate,
};

})();
