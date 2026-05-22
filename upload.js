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
    _fileHashes:  new Set(),   // SHA-256 of bytes — skip duplicate uploads
    job_file_bundles: [],      // [{name, bytes, rows}] for the push-to-store flow
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

  // ---------------------------------------------------------------
  // Auth + shared-store wiring (no-op when Supabase isn't configured)
  // ---------------------------------------------------------------
  initAuth();
  document.getElementById('authSignIn')?.addEventListener('click', signIn);
  document.getElementById('authEmail')?.addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); signIn(); }
  });

  // ---- Theme toggle: persists in localStorage, reload to re-paint charts ----
  function currentTheme(){ return document.documentElement.getAttribute('data-theme') || 'dark'; }
  function syncThemeLabels(){
    const label = currentTheme() === 'dark' ? '☀️ Light' : '🌙 Dark';
    document.querySelectorAll('.theme-toggle').forEach(b => b.textContent = label);
  }
  syncThemeLabels();
  document.querySelectorAll('.theme-toggle').forEach(b => {
    b.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      localStorage.setItem('bc-theme', next);
      // Reload so Chart.js re-creates charts with the right text/grid colors.
      location.reload();
    });
  });

  // ---- Overlay sign-out (every state with an .overlay-signout button) ----
  document.querySelectorAll('.overlay-signout').forEach(b => {
    b.addEventListener('click', async () => {
      await window.BCStore?.signOut?.();
      location.reload();
    });
  });
  document.getElementById('authSignOut')?.addEventListener('click', async () => { await window.BCStore.signOut(); location.reload(); });
  document.getElementById('pushToStore')?.addEventListener('click', () => pushAllToStore());
  document.getElementById('loadFromStore')?.addEventListener('click', () => loadFromStore());

  async function initAuth(){
    const bar = document.getElementById('authBar');
    const statusEl = document.getElementById('authStatus');
    const dropZone = document.getElementById('drop-all');
    const intro    = document.getElementById('introText');
    const overlay  = document.getElementById('authOverlay');

    function setOverlayState(state){
      overlay.style.display = '';
      overlay.querySelectorAll('.overlay-state').forEach(el => {
        el.hidden = (el.dataset.state !== state);
      });
      const card = overlay.querySelector('.overlay-card');
      card.classList.toggle('picker-mode', state === 'pickPeriod');
    }
    function showOverlay(opts={}){
      setOverlayState('signin');
      const title = document.getElementById('overlayTitle');
      const sub   = document.getElementById('overlaySub');
      const msg   = document.getElementById('overlayMsg');
      const card  = overlay.querySelector('.overlay-card');
      card.classList.remove('sent');
      if (opts.title) title.textContent = opts.title;
      if (opts.sub)   sub.textContent   = opts.sub;
      if (opts.msg)   { msg.textContent = opts.msg; msg.className = 'overlay-msg ' + (opts.msgClass||''); }
      else            { msg.textContent = ''; msg.className = 'overlay-msg'; }
    }
    function hideOverlay(){ overlay.style.display = 'none'; }
    // Expose for cross-function use
    window._BC_setOverlayState = setOverlayState;
    window._BC_hideOverlay = hideOverlay;

    if (!window.BCStore || !window.BCStore.enabled){
      // Local-only mode (no Supabase): keep the legacy flow, no overlay.
      if (dropZone) dropZone.style.display = '';
      bar.style.display = '';
      statusEl.textContent = 'Local-only mode (no shared store configured).';
      return;
    }

    const role  = await window.BCStore.getRole();
    const email = await window.BCStore.getEmail();

    if (!email){
      showOverlay({title:'Sign in to continue', sub:"We'll email you a one-time sign-in link."});
      return;
    }
    if (!role){
      showOverlay({
        title:'Access not authorised',
        sub:`Signed in as ${email} — but this address isn't in the members list.`,
        msg:'Ask the admin to add you, then refresh.',
        msgClass:'error',
      });
      // Offer sign-out from inside the overlay so they can switch accounts
      document.getElementById('overlayForm').innerHTML =
        '<button id="overlaySignOut">Sign out</button>';
      document.getElementById('overlaySignOut').addEventListener('click', async () => {
        await window.BCStore.signOut(); location.reload();
      });
      return;
    }

    // Authenticated + role found: keep the overlay up but transition to
    // "loading" state while we fetch metadata + rows.
    bar.classList.add('signed-in');
    statusEl.innerHTML = `Signed in as <span class="who">${escapeHtml(email)}</span> <span class="role">${role}</span>`;
    if (role === 'uploader'){
      document.getElementById('pushToStore').style.display = '';
      if (dropZone) dropZone.style.display = '';
      if (intro) intro.innerHTML = 'Pick periods to compare and click View. Drop new reports below to push them to the shared store.';
      document.body.classList.add('uploader-mode');
    } else {
      if (intro) intro.textContent = 'Pick periods to compare and click View.';
      document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
      document.body.classList.add('viewer-mode');
    }
    setOverlayState('loading');
    const loadingMsg = document.getElementById('loadingMsg');
    if (loadingMsg) loadingMsg.textContent = '';
    try {
      await loadFromStore();
    } catch (err){
      if (loadingMsg){
        loadingMsg.textContent = 'Could not load data: ' + (err.message || err);
        loadingMsg.className = 'overlay-msg error';
      }
      return;
    }
    // Now move to period-picker state.
    bar.style.display = '';   // ensure chip is ready when overlay closes
    showPickPeriodState();
  }

  // Render the period-picker step in the overlay. Pre-fills inputs from the
  // suggested defaults (set by suggestDefaultPeriods inside loadFromStore).
  function showPickPeriodState(){
    const fromCov = document.getElementById('overlayCoverage');
    if (fromCov){
      const cov = STORE?.coverage || { from: null, to: null };
      fromCov.textContent = cov.from
        ? `Data available: ${cov.from} → ${cov.to}`
        : 'No data available yet.';
    }
    // Copy current sticky-bar dates into the overlay inputs
    ['curFrom','curTo','prevFrom','prevTo'].forEach(id => {
      const src = document.getElementById(id);
      const dst = document.getElementById('overlay' + id.charAt(0).toUpperCase() + id.slice(1));
      if (src && dst) dst.value = src.value;
    });
    window._BC_setOverlayState('pickPeriod');
  }
  async function signIn(){
    const emailInput = document.getElementById('authEmail');
    const msg = document.getElementById('overlayMsg');
    const card = document.querySelector('#authOverlay .overlay-card');
    const btn = document.getElementById('authSignIn');
    const email = emailInput.value.trim();
    if (!email){
      msg.textContent = 'Enter your email first.';
      msg.className = 'overlay-msg error';
      return;
    }
    btn.disabled = true;
    msg.textContent = 'Sending…';
    msg.className = 'overlay-msg';
    try {
      await window.BCStore.signInWithEmail(email);
      // Swap the form for a "check your email" state
      card?.classList.add('sent');
      msg.innerHTML = `Magic link sent to <strong>${escapeHtml(email)}</strong>.<br>Open your inbox and click the link to finish signing in.`;
      msg.className = 'overlay-msg ok';
    } catch (err){
      btn.disabled = false;
      msg.textContent = 'Sign-in failed: ' + (err.message || err);
      msg.className = 'overlay-msg error';
    }
  }

  async function pushAllToStore(){
    if (!window.BCStore?.enabled) return;
    setStatus('Pushing to shared store…');
    let pushed = 0, skipped = 0;
    try {
      // Income
      for (const f of STORE.income_files){
        const bytes = f._bytes;
        const res = await window.BCStore.pushIncome(f, bytes, f.source_name);
        if (res?.error) throw res.error;
        pushed++;
      }
      // Hours
      for (const f of STORE.hours_files){
        const bytes = f._bytes;
        const res = await window.BCStore.pushHours(f, bytes, f.source_name);
        if (res?.error) throw res.error;
        pushed++;
      }
      // Jobs — grouped by source file (we have STORE._jobsByFile)
      for (const jf of (STORE.job_file_bundles || [])){
        const res = await window.BCStore.pushJobs(jf.rows, jf.bytes, jf.name);
        if (res?.skipped) { skipped++; }
        else { pushed++; }
      }
      // Registrations
      for (const f of STORE.reg_files){
        const bytes = f._bytes;
        const res = await window.BCStore.pushRegistrations(f, bytes, f.name);
        if (res?.skipped) { skipped++; }
        else { pushed++; }
      }
      // Account names map — extracted from current top corp rows if available
      if (window.__TOPCLIENTS__?.corporate?.top){
        const nameMap = {};
        for (const r of window.__TOPCLIENTS__.corporate.top){
          if (r.account_no && r.account_name) nameMap[r.account_no] = r.account_name;
        }
        await window.BCStore.pushAccountNames(nameMap);
      }
      setStatus(`Pushed ${pushed} files (${skipped} already in store).`, 'ok');
    } catch (err){
      console.error(err);
      setStatus('Push failed: ' + (err.message || err), 'error');
    }
  }

  async function loadFromStore(){
    if (!window.BCStore?.enabled) return;
    const isUploader = document.body.classList.contains('uploader-mode');
    setStatus('Loading data…');
    try {
      // Only show technical per-table progress for uploaders.
      const onProgress = isUploader ? (msg => setStatus(msg)) : null;
      // Lazy load: fetch only metadata now; rows come on View click.
      const blob = { ...(await window.BCStore.loadMetadata(onProgress)), job_rows: [], reg_rows: [] };
      // Stash the account-name lookup so generate() can hydrate jobs later.
      STORE._accountNames = blob.account_names || {};
      // Replace the in-memory STORE with what came from the server.
      STORE.income_files = blob.income_files.map(f => ({
        source_name: f.source_name, period_from: f.period_from, period_to: f.period_to,
        sections: f.sections, kpis: f.kpis,
      }));
      STORE.hours_files = blob.hours_files.map(f => ({
        source_name: f.source_name, period: f.period,
        timestamps: f.timestamps, hourly: f.hourly,
        by_hour_of_day: deriveByHourOfDay(f.timestamps, f.hourly),
        derived: deriveHoursDerived(f.timestamps, f.hourly),
      }));
      // Job rows: server gave us anonymised rows. Rehydrate to the shape the
      // dashboard expects.
      STORE.job_rows = blob.job_rows.map(r => ({
        account_no:   r.account_no != null ? String(r.account_no) : '',
        account_name: blob.account_names[r.account_no] || '',
        job_no:       '',
        urgency:      r.urgency || '',
        status:       r.status  || '',
        service:      r.service || '',
        date:         r.date,
        hour:         r.hour,
        pickup:       r.is_otp_pickup  ? 'OTP/LROP' : '',
        dropoff:      r.is_otp_dropoff ? 'OTP/LROP' : '',
        vehicle:      r.vehicle_hash || '',
        cancel_reason:r.is_no_supply_cancel ? 'no cars available' : '',
        response_min: r.response_min,
        phone:        r.phone_hash || '',
        total:        Number(r.total) || 0,
        driver_total: Number(r.driver_total) || 0,
      }));
      // Preserve id so we can attach rows on demand in generate().
      STORE.reg_files = blob.reg_files.map(f => ({ id: f.id, name: f.source_name, rows: [], min: null, max: null }));
      STORE.raw_files = [
        ...STORE.income_files.map(f => ({name: f.source_name, kind: 'income (shared)'})),
        ...STORE.hours_files.map(f => ({name: f.source_name, kind: 'hours (shared)'})),
        ...(blob.job_files || []).map(f => ({name: f.source_name, kind: 'jobs (shared)'})),
        ...STORE.reg_files.map(f => ({name: f.name, kind: 'registrations (shared)'})),
      ];
      recomputeCoverage();
      refreshSummary();
      suggestDefaultPeriods();
      const msg = 'Ready — pick periods to compare.';
      setStatus(msg, 'ok');
    } catch (err){
      console.error(err);
      setStatus('Could not load data: ' + (err.message || err), 'error');
    }
  }

  function deriveByHourOfDay(timestamps, hourly){
    const keys = Object.keys(hourly);
    const out = {}; for (const k of keys) out[k] = new Array(24).fill(0);
    const counts = new Array(24).fill(0);
    for (let i = 0; i < timestamps.length; i++){
      const h = new Date(timestamps[i]).getHours();
      counts[h]++;
      for (const k of keys) out[k][h] += hourly[k][i] || 0;
    }
    for (const k of keys) out[k] = out[k].map((v,h) => counts[h] ? v/counts[h] : 0);
    return out;
  }
  function deriveHoursDerived(timestamps, hourly){
    const onlineTotal = (hourly.online    || []).reduce((s,v)=>s+v,0);
    const onBreakTotal= (hourly.on_break  || []).reduce((s,v)=>s+v,0);
    const busyTotal   = (hourly.doing_job || []).reduce((s,v)=>s+v,0);
    const avail = onlineTotal - onBreakTotal;
    return {
      available_total: avail, busy_total: busyTotal,
      online_total: onlineTotal, on_break_total: onBreakTotal,
      util_avg: avail ? busyTotal/avail : 0,
      peak_available: Math.max(...(hourly.online || []).map((o,i)=>o - (hourly.on_break||[])[i] || 0)),
      peak_busy: Math.max(...(hourly.doing_job || [0])),
    };
  }

  // Presets removed — date inputs only.

  // ---- flatpickr: consistent calendar picker on every <input type="date"> ----
  if (window.flatpickr){
    window.flatpickr('input[type="date"]', {
      dateFormat: 'Y-m-d',          // keep ISO so our date math doesn't change
      allowInput: true,             // user can also type
      disableMobile: true,          // use flatpickr UI everywhere, not OS native
    });
  }
  document.getElementById('overlayGenerate')?.addEventListener('click', () => {
    // Copy overlay inputs back to sticky-bar inputs, then generate + dismiss.
    ['curFrom','curTo','prevFrom','prevTo'].forEach(id => {
      const src = document.getElementById('overlay' + id.charAt(0).toUpperCase() + id.slice(1));
      const dst = document.getElementById(id);
      if (src && dst) dst.value = src.value;
    });
    const cf = document.getElementById('curFrom').value;
    const ct = document.getElementById('curTo').value;
    if (!cf || !ct){
      const m = document.getElementById('overlayPickerMsg');
      if (m){ m.textContent = 'Pick the Current period first.'; m.className = 'overlay-msg error'; }
      return;
    }
    window._BC_hideOverlay();
    generate();
  });

  // Mirror of applyPreset but writes to the overlay inputs. Re-uses date math.
  function applyOverlayPreset(preset, target){
    if (!STORE.coverage.to) return;
    const to = STORE.coverage.to;
    function addDays(iso, n){
      const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+n);
      return d.toISOString().slice(0,10);
    }
    function daysBetween(a, b){
      return Math.round((new Date(b+'T12:00:00Z') - new Date(a+'T12:00:00Z'))/86400000);
    }
    let from, until;
    if (target === 'cur'){
      if (preset === 'last7')      { until = to; from = addDays(to, -6); }
      else if (preset === 'last30'){ until = to; from = addDays(to, -29); }
      else if (preset === 'lastWeek'){ until = to; from = addDays(to, -6); }
      else if (preset === 'lastMonth'){ until = to; from = addDays(to, -29); }
      document.getElementById('overlayCurFrom').value = from;
      document.getElementById('overlayCurTo').value   = until;
    } else {
      const curFrom = document.getElementById('overlayCurFrom').value;
      const curTo   = document.getElementById('overlayCurTo').value;
      if (!curFrom || !curTo) return;
      const len = daysBetween(curFrom, curTo) + 1;
      if (preset === 'priorEqual'){
        until = addDays(curFrom, -1); from = addDays(until, -(len-1));
      } else if (preset === 'lastWeek-1'){
        until = addDays(curFrom, -1); from = addDays(until, -6);
      } else if (preset === 'lastMonth-1'){
        until = addDays(curFrom, -1); from = addDays(until, -29);
      }
      document.getElementById('overlayPrevFrom').value = from;
      document.getElementById('overlayPrevTo').value   = until;
    }
  }

  function setStatus(msg, cls=''){ statusEl.textContent = msg; statusEl.className = cls; }

  async function handleFiles(fileList){
    setStatus(`Reading ${fileList.length} file${fileList.length===1?'':'s'}…`);
    let dupCount = 0;
    for (const f of fileList){
      try {
        const buf = await f.arrayBuffer();
        const hash = await sha256hex(new Uint8Array(buf));
        // Skip if we've already ingested an identical file (same bytes).
        if (STORE._fileHashes.has(hash)) { dupCount++; continue; }
        STORE._fileHashes.add(hash);
        const wb = XLSX.read(buf, { type: 'array', cellDates: true });
        const kind = BCParsers.detectFileType(wb);
        const file = { name: f.name, workbook: wb };
        const bytes = new Uint8Array(buf);
        if (kind === 'income'){
          const parsed = BCParsers.parseIncomePerFile(file);
          parsed._bytes = bytes;
          STORE.income_files.push(parsed);
        } else if (kind === 'hours'){
          const parsed = BCParsers.parseHoursPerFile(file);
          parsed._bytes = bytes;
          STORE.hours_files.push(parsed);
        } else if (kind === 'jobs'){
          const rows = BCParsers.parseJobAnalogue(wb);
          for (const r of rows) STORE.job_rows.push(r);
          STORE.job_file_bundles.push({ name: f.name, bytes, rows });
        } else if (kind === 'registrations'){
          const parsed = BCParsers.parseRegistrationsPerFile(file);
          parsed._bytes = bytes;
          STORE.reg_files.push(parsed);
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
    const note = dupCount ? ` (${dupCount} duplicate file${dupCount===1?'':'s'} skipped)` : '';
    setStatus(`Files loaded${note}. Pick periods and click Generate dashboard.`, 'ok');
  }

  async function sha256hex(bytes){
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join('');
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

    // Viewer-friendly coverage line (always shown; sits above the picker)
    const cov = document.getElementById('coverageNote');
    if (cov){
      if (STORE.coverage.from && STORE.coverage.to){
        cov.innerHTML = `<strong>Data available:</strong> ${STORE.coverage.from} → ${STORE.coverage.to}`;
      } else {
        cov.innerHTML = '';
      }
    }

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
  async function generate(){
    const curFrom = document.getElementById('curFrom').value;
    const curTo   = document.getElementById('curTo').value;
    const prevFrom= document.getElementById('prevFrom').value;
    const prevTo  = document.getElementById('prevTo').value;
    if (!curFrom || !curTo){ setStatus('Pick a Current period.', 'error'); return; }

    // Lazy fetch: pull only the rows in the selected ranges from Supabase.
    // We aggregate the requested union once, then filter client-side per period.
    if (window.BCStore?.enabled){
      const rangeFrom = (prevFrom && prevFrom < curFrom) ? prevFrom : curFrom;
      const rangeTo   = (prevTo   && prevTo   > curTo)   ? prevTo   : curTo;
      // Cache: skip re-fetch if we already pulled this exact union range
      const cacheKey  = `${rangeFrom}|${rangeTo}`;
      if (STORE._lastRangeKey !== cacheKey){
        setStatus('Fetching rows for the selected periods…');
        try {
          const [jobRows, regRows] = await Promise.all([
            window.BCStore.loadJobRowsForRange(rangeFrom, rangeTo),
            (STORE.reg_files.length ? window.BCStore.loadRegRowsForRange(rangeFrom, rangeTo) : Promise.resolve([])),
          ]);
          STORE.job_rows = jobRows.map(r => ({
            account_no:   r.account_no != null ? String(r.account_no) : '',
            account_name: STORE._accountNames?.[r.account_no] || '',
            job_no:       '',
            urgency:      r.urgency || '',
            status:       r.status  || '',
            service:      r.service || '',
            date:         r.date,
            hour:         r.hour,
            pickup:       r.is_otp_pickup  ? 'OTP/LROP' : '',
            dropoff:      r.is_otp_dropoff ? 'OTP/LROP' : '',
            vehicle:      r.vehicle_hash || '',
            cancel_reason:r.is_no_supply_cancel ? 'no cars available' : '',
            response_min: r.response_min,
            phone:        r.phone_hash || '',
            total:        Number(r.total) || 0,
            driver_total: Number(r.driver_total) || 0,
          }));
          // Rebuild reg_files rows arrays from the freshly-fetched reg_rows
          if (STORE.reg_files.length){
            const byFile = {};
            for (const r of regRows){
              if (!byFile[r.file_id]) byFile[r.file_id] = [];
              byFile[r.file_id].push(r);
            }
            STORE.reg_files = STORE.reg_files.map(f => {
              const rows = (byFile[f.id] || []).map(r => ({
                email: r.email_hash || '', created: new Date(r.created_at),
                status: r.status || '', src: f.name,
              }));
              const ds = rows.map(r => r.created).sort((a,b)=>a-b);
              return { ...f, rows, min: ds[0] || null, max: ds[ds.length-1] || null };
            });
          }
          STORE._lastRangeKey = cacheKey;
        } catch (err){
          console.error(err);
          setStatus('Could not fetch rows: ' + (err.message || err), 'error');
          return;
        }
      }
    }

    setStatus('Aggregating…');

    function buildPeriod(from, to){
      const income = BCParsers.aggregateIncome(STORE.income_files, from, to);
      const hours  = BCParsers.aggregateHours(STORE.hours_files,   from, to);
      const jobs   = BCParsers.aggregateJobs(STORE.job_rows,        from, to);
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
