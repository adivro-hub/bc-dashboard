/* upload.js — single-zone uploader with auto-classification + date-range picker.
 *
 * 1. User drops any number of .xls/.xlsx files.
 * 2. Each file is auto-classified by content signature (income / jobs / hours / regs).
 * 3. We parse each file once and cache it (with the date metadata it carries).
 * 4. UI shows total coverage; user picks Period A (current) and Period B (previous).
 * 5. On "Generate dashboard", parsers slice + aggregate by the picked ranges
 *    and feed the existing renderer.
 *
 * Repeat step 5 freely — re-pick periods to compare different ranges without
 * re-uploading.
 */
(function(){
  // In-memory store of every parsed file.
  // income_files: [{ source_name, period_from, period_to, sections, kpis }]
  // hours_files:  [{ source_name, period, timestamps, hourly, by_hour_of_day, derived }]
  // job_rows:     flat array of all rows across all uploaded job files (each has .date)
  // reg_files:    [{ name, rows: [{email, created, status, src}], min, max }]
  const STORE = {
    income_files: [],
    hours_files:  [],
    job_rows:     [],
    reg_files:    [],
    raw_files:    [],   // [{name, kind}] for the visible file list
    coverage:     { from: null, to: null },
  };

  const dropAll  = document.getElementById('drop-all');
  const input    = dropAll.querySelector('input[type=file]');
  const statusEl = document.getElementById('status');
  const summary  = document.getElementById('files-summary');
  const strip    = document.getElementById('files-strip');
  const filesList= document.getElementById('files-list');

  input.addEventListener('change', () => handleFiles(Array.from(input.files)));
  dropAll.addEventListener('dragover', e => { e.preventDefault(); dropAll.classList.add('dragover'); });
  dropAll.addEventListener('dragleave', () => dropAll.classList.remove('dragover'));
  dropAll.addEventListener('drop', e => {
    e.preventDefault(); dropAll.classList.remove('dragover');
    handleFiles(Array.from(e.dataTransfer.files));
  });
  document.getElementById('reset').addEventListener('click', () => location.reload());
  document.getElementById('generate').addEventListener('click', () => generate());

  // Preset buttons
  document.querySelectorAll('.period-presets button').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset, btn.dataset.target));
  });

  function setStatus(msg, cls=''){ statusEl.textContent = msg; statusEl.className = cls; }

  async function handleFiles(fileList){
    setStatus(`Reading ${fileList.length} file${fileList.length===1?'':'s'}…`);
    for (const f of fileList){
      try {
        const wb = await readWorkbook(f);
        const kind = BCParsers.detectFileType(wb);
        const file = { name: f.name, workbook: wb };
        if (kind === 'income'){
          STORE.income_files.push(BCParsers.parseIncomePerFile(file));
        } else if (kind === 'hours'){
          STORE.hours_files.push(BCParsers.parseHoursPerFile(file));
        } else if (kind === 'jobs'){
          const rows = BCParsers.parseJobAnalogue(wb);
          for (const r of rows) STORE.job_rows.push(r);
        } else if (kind === 'registrations'){
          STORE.reg_files.push(BCParsers.parseRegistrationsPerFile(file));
        } else {
          STORE.raw_files.push({ name: f.name, kind: 'unknown' });
          continue;
        }
        STORE.raw_files.push({ name: f.name, kind });
      } catch (err){
        console.error(err);
        setStatus(`Failed to read ${f.name}: ${err.message}`, 'error');
        return;
      }
    }
    recomputeCoverage();
    refreshSummary();
    suggestDefaultPeriods();
    setStatus('Files loaded. Pick periods and click Generate dashboard.', 'ok');
  }

  function recomputeCoverage(){
    const dates = [];
    for (const f of STORE.income_files) { if (f.period_from) dates.push(f.period_from); if (f.period_to) dates.push(f.period_to); }
    for (const f of STORE.hours_files)  { for (const t of f.timestamps) dates.push(t.slice(0,10)); }
    for (const r of STORE.job_rows)     { if (r.date) dates.push(r.date); }
    for (const f of STORE.reg_files)    { if (f.min) dates.push(f.min.toISOString().slice(0,10)); if (f.max) dates.push(f.max.toISOString().slice(0,10)); }
    dates.sort();
    STORE.coverage.from = dates[0] || null;
    STORE.coverage.to   = dates[dates.length-1] || null;
  }

  function refreshSummary(){
    const counts = { income: STORE.income_files.length, jobs: STORE.job_rows.length, hours: STORE.hours_files.length, registrations: STORE.reg_files.length };
    summary.style.display = 'block';
    strip.innerHTML = '';
    const chip = (label, val) => `<span class="chip">${label}: <strong>${val}</strong></span>`;
    strip.innerHTML += chip('Coverage', `${STORE.coverage.from || '—'} → ${STORE.coverage.to || '—'}`);
    strip.innerHTML += chip('Income files',         counts.income);
    strip.innerHTML += chip('Job rows',             counts.jobs.toLocaleString());
    strip.innerHTML += chip('Hour-stats files',     counts.hours);
    strip.innerHTML += chip('Registration files',   counts.registrations);

    // File list
    filesList.innerHTML = STORE.raw_files.map(f =>
      `<div><span class="kind">${escapeHtml(f.kind)}</span> ${escapeHtml(f.name)}</div>`
    ).join('') + (STORE.raw_files.some(f=>f.kind==='unknown')
        ? '<div class="range">Some files could not be classified — they were ignored.</div>'
        : '');

    document.getElementById('generate').disabled = !STORE.coverage.from;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- Date helpers (UTC-safe; avoid local TZ drift) ----------
  function addDays(iso, n){
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0,10);
  }
  function daysBetween(a, b){
    return Math.round((new Date(b+'T12:00:00Z') - new Date(a+'T12:00:00Z'))/86400000);
  }
  // Sunday-end week: Monday → Sunday convention isn't strict here; we just take
  // the last 7 calendar days that have any data.
  function suggestDefaultPeriods(){
    if (!STORE.coverage.to) return;
    const to = STORE.coverage.to;
    const curFrom = addDays(to, -6);
    document.getElementById('curFrom').value = curFrom;
    document.getElementById('curTo').value   = to;
    // Previous = 7 days right before current
    const prevTo   = addDays(curFrom, -1);
    const prevFrom = addDays(prevTo, -6);
    document.getElementById('prevFrom').value = prevFrom;
    document.getElementById('prevTo').value   = prevTo;
  }
  function applyPreset(preset, target){
    if (!STORE.coverage.to) return;
    const to = STORE.coverage.to;
    let from, until;
    if (target === 'cur'){
      if (preset === 'last7')      { until = to; from = addDays(to, -6); }
      else if (preset === 'last30'){ until = to; from = addDays(to, -29); }
      else if (preset === 'lastWeek'){ until = to; from = addDays(to, -6); }
      else if (preset === 'lastMonth'){ until = to; from = addDays(to, -29); }
      document.getElementById('curFrom').value = from;
      document.getElementById('curTo').value   = until;
    } else {
      const curFrom = document.getElementById('curFrom').value;
      const curTo   = document.getElementById('curTo').value;
      if (!curFrom || !curTo){ setStatus('Set current period first.', 'error'); return; }
      const len = daysBetween(curFrom, curTo) + 1;
      if (preset === 'priorEqual'){
        until = addDays(curFrom, -1);
        from  = addDays(until, -(len-1));
      } else if (preset === 'lastWeek-1'){
        until = addDays(curFrom, -1);
        from  = addDays(until, -6);
      } else if (preset === 'lastMonth-1'){
        until = addDays(curFrom, -1);
        from  = addDays(until, -29);
      }
      document.getElementById('prevFrom').value = from;
      document.getElementById('prevTo').value   = until;
    }
  }

  function readWorkbook(file){
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = e => { try { resolve(XLSX.read(e.target.result, { type:'array', cellDates:true })); } catch(err){ reject(err); } };
      r.onerror = () => reject(new Error('read failed'));
      r.readAsArrayBuffer(file);
    });
  }

  // ---------- Generate dashboard ----------
  function generate(){
    const curFrom = document.getElementById('curFrom').value;
    const curTo   = document.getElementById('curTo').value;
    const prevFrom= document.getElementById('prevFrom').value;
    const prevTo  = document.getElementById('prevTo').value;
    if (!curFrom || !curTo){ setStatus('Pick a Current period.', 'error'); return; }
    setStatus('Aggregating…');

    function buildPeriod(from, to){
      const income = BCParsers.aggregateIncome(STORE.income_files, from, to);
      const hours  = BCParsers.aggregateHours(STORE.hours_files,   from, to);
      const jobs   = BCParsers.aggregateJobs(STORE.job_rows,        from, to);
      // Synthesise income if missing (so the dashboard can still render)
      const finalIncome = income || synthesiseIncomeFromJobs(jobs, from, to);
      const { otp, kpis } = BCParsers.buildPeriodPayloads(finalIncome, hours, jobs);
      return { income: finalIncome, hours, jobs, otp, kpis };
    }

    const A = buildPeriod(curFrom, curTo);
    const B = (prevFrom && prevTo) ? buildPeriod(prevFrom, prevTo) : emptyPeriod(prevFrom, prevTo);

    window.__DATA__ = {
      current:  A.income,
      previous: B.income,
    };
    window.__JOBS__ = { current: A.jobs, previous: B.jobs };
    window.__HOURS__ = (A.hours || B.hours) ? { current: A.hours || emptyHours(curFrom, curTo), previous: B.hours || emptyHours(prevFrom, prevTo) } : null;
    window.__OTP__ = { current: A.otp, previous: B.otp };
    window.__KPIS__ = { current: A.kpis, previous: B.kpis };
    window.__TOPCLIENTS__ = BCParsers.buildTopClientsFromRows(A.jobs, B.jobs);

    if (STORE.reg_files.length){
      window.__REG__ = {
        summary: {
          current:  BCParsers.aggregateRegistrations(STORE.reg_files, curFrom, curTo),
          previous: prevFrom ? BCParsers.aggregateRegistrations(STORE.reg_files, prevFrom, prevTo) : { total:0, by_status:{}, daily:{} },
        },
        files: STORE.reg_files.map(f => ({ file: f.name, rows: f.rows.length,
                                           min: f.min ? f.min.toISOString() : '',
                                           max: f.max ? f.max.toISOString() : '' })),
      };
    } else {
      window.__REG__ = null;
    }

    document.getElementById('upload-wrap').style.display = 'none';
    document.getElementById('dashboard-area').style.display = 'block';
    // Clear any prior render from a previous Generate run
    clearDashboardSlots();
    window.renderDashboard();
    setStatus('Done.', 'ok');
    // Smoothly scroll to the dashboard
    document.getElementById('dashboard-area').scrollIntoView({behavior:'smooth'});
  }

  function emptyHours(from, to){
    return { period: `${from || ''} → ${to || ''}`, timestamps: [],
             hourly: { online:[], doing_job:[], on_break:[], in_rank:[], empty:[], going_home:[], logged_off:[], unknown:[], jobs_asap:[], jobs_prebook:[], jobs_cancelled:[], jobs_completed:[] },
             by_hour_of_day: Object.fromEntries(['online','doing_job','on_break','in_rank','empty','going_home','logged_off','unknown','jobs_asap','jobs_prebook','jobs_cancelled','jobs_completed'].map(k => [k, new Array(24).fill(0)])),
             derived: { available_total:0, busy_total:0, online_total:0, on_break_total:0, util_avg:0, peak_available:0, peak_busy:0 } };
  }

  function emptyPeriod(from, to){
    return { income: synthesiseIncomeFromJobs([], from || '', to || ''), hours: null, jobs: [], otp: { pickup:{}, dropoff:{} }, kpis: emptyKpis() };
  }
  function emptyKpis(){
    return { total_login_hours:0, login_h_per_car_per_day:0, unique_active_vehicles:0, fleet_utilisation_pct:0, jobs_per_online_hour:0, no_supply_cancels:0, no_supply_pct_of_cancel:0, avg_time_to_pickup_min:0, median_time_to_pickup_min:0, asap_done_jobs:0, fulfilment_rate_pct:0, request_to_paid_pct:0, done_jobs:0, cancelled_jobs:0, total_bookings:0, total_price:0, driver_price:0, gross_commission:0 };
  }
  // If no Income Structure files cover the period, fabricate the minimal
  // structure from Job rows so the dashboard's KPI cards still work.
  function synthesiseIncomeFromJobs(rows, from, to){
    const done = rows.filter(r => r.status === 'DONE');
    const totalPrice = done.reduce((s,r)=>s+r.total, 0);
    const totalJobs  = done.length;
    return {
      period_from: from,
      period_to:   to,
      sections: {
        sales: {},
        payment_type: {},
        customer_grade: {},
        service: aggregateField(done, 'service'),
        fleet: {},
        driver_hours: {},
      },
      kpis: {
        jobs:        totalJobs,
        without_vat: 0,
        vat:         0,
        total:       totalPrice,
        earnings:    totalPrice - done.reduce((s,r)=>s+r.driver_total, 0),
        avg_per_job: totalJobs ? totalPrice/totalJobs : 0,
      },
      synthesised: true,
    };
  }
  function aggregateField(rows, field){
    const out = {};
    for (const r of rows){
      const k = r[field] || '(blank)';
      if (!out[k]) out[k] = { jobs:0, without_vat:0, vat:0, total:0, earnings:0 };
      out[k].jobs += 1;
      out[k].total += r.total || 0;
      out[k].earnings += (r.total || 0) - (r.driver_total || 0);
    }
    return out;
  }

  // Reset DOM slots between Generate calls (so re-running doesn't double-append)
  function clearDashboardSlots(){
    ['kpiGrid','hourKpis','opsKpis','regKpis','regStatus','regNote',
     'topRetailSummary','topRetailTable','topCorpSummary','topCorpTable',
     'pivotSummary','pivotCur','pivotPrev',
     'tblPayment','tblCustomer','tblService','tblFleet','tblHours','tblHoursPerJob',
     'otpSummary','otpPickupTable','otpDropoffTable'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    document.querySelectorAll('canvas').forEach(c => {
      const w = c.width, h = c.height;
      const newC = c.cloneNode(false);   // drop attached Chart instances
      c.parentNode.replaceChild(newC, c);
    });
  }
})();
