/* upload.js — glue between the file-picker UI and BCParsers.
 * Runs only on upload.html. Calls window.renderDashboard() once the user clicks Generate.
 */
(function(){
  const PARSED = {
    income:        [],   // [{name, workbook}, …]
    jobs:          [],
    hours:         [],
    registrations: [],
  };

  const drops = document.querySelectorAll('.drop');
  drops.forEach(zone => {
    const input = zone.querySelector('input[type=file]');
    input.addEventListener('change', () => handleFiles(zone, Array.from(input.files)));
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('dragover');
      handleFiles(zone, Array.from(e.dataTransfer.files));
    });
  });

  document.getElementById('reset').addEventListener('click', () => location.reload());
  document.getElementById('auto-sort').addEventListener('click', () => autoSort());
  document.getElementById('generate').addEventListener('click', () => generate());

  async function handleFiles(zone, fileList){
    const kind = zone.dataset.kind;
    for (const f of fileList){
      try {
        const wb = await readWorkbook(f);
        PARSED[kind].push({ name: f.name, workbook: wb });
      } catch (err) {
        setStatus(`Could not read ${f.name}: ${err.message}`, 'error');
      }
    }
    refreshZone(zone);
  }

  function refreshZone(zone){
    const kind = zone.dataset.kind;
    const list = zone.querySelector('[data-files]');
    list.innerHTML = PARSED[kind].map(x =>
      `<div>✓ ${escapeHtml(x.name)}</div>`).join('');
    zone.classList.toggle('ok', PARSED[kind].length >= 1);
    updateGenerateState();
  }

  function refreshAllZones(){
    drops.forEach(refreshZone);
  }

  function escapeHtml(s){
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function setStatus(msg, cls=''){
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = cls;
  }

  function readWorkbook(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
          resolve(wb);
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsArrayBuffer(file);
    });
  }

  function updateGenerateState(){
    // Income Structure x2 required. Others optional but recommended.
    const ok = PARSED.income.length >= 2;
    document.getElementById('generate').disabled = !ok;
  }

  function autoSort(){
    // Re-classify every loaded file by content type. Re-distribute into the right buckets.
    const allFiles = [];
    for (const k of Object.keys(PARSED)){
      for (const f of PARSED[k]) allFiles.push(f);
      PARSED[k] = [];
    }
    let unknown = 0;
    for (const f of allFiles){
      const t = BCParsers.detectFileType(f.workbook);
      if (PARSED[t]){
        PARSED[t].push(f);
      } else {
        unknown++;
      }
    }
    refreshAllZones();
    setStatus(unknown ? `Auto-sorted (${unknown} unknown files ignored)` : 'Auto-sorted by content', 'ok');
  }

  // ---------- helpers for the two-file-per-week split ----------
  // Determine which file is "current" vs "previous" based on a date hint we can find.
  function periodFromIncome(wb){
    // Income files have "From:" date in row 1 col 2 and "To:" in row 2 col 2
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, raw:true, defval:null, blankrows:false });
    return BCParsers.toDate(rows[1] && rows[1][2]);
  }
  function periodFromJobs(wb){
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, raw:true, defval:null, blankrows:false });
    return BCParsers.toDate(rows[0] && rows[0][1]);
  }
  function periodFromHours(wb){
    const ws = wb.Sheets["Average"] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, raw:true, defval:null, blankrows:false });
    const header = rows[0] && rows[0][0] ? String(rows[0][0]) : "";
    // Format: "DD/MM/YYYY - DD/MM/YYYY"
    const m = header.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (!m) return null;
    const [, dStr] = m;
    const [dd, mm, yy] = dStr.split('/').map(s=>parseInt(s,10));
    return new Date(yy, mm-1, dd);
  }
  function periodFromReg(wb){
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, raw:true, defval:null, blankrows:false });
    if (rows.length < 2) return null;
    const header = rows[0].map(h=>String(h||'').trim());
    const iC = header.indexOf("Created At");
    if (iC < 0) return null;
    // Use min Created At as the proxy for the week start
    let minD = null;
    for (let i = 1; i < rows.length; i++){
      const d = BCParsers.toDate(rows[i] && rows[i][iC]);
      if (d && (!minD || d < minD)) minD = d;
    }
    return minD;
  }

  // Split a kind's files into {current, previous} based on date.
  function splitByDate(arr, getDate){
    if (arr.length === 0) return { current: null, previous: null };
    if (arr.length === 1) return { current: arr[0], previous: null };
    const tagged = arr.map(f => ({ f, d: getDate(f.workbook) }));
    tagged.sort((a,b) => (a.d||0) - (b.d||0));
    // First two: earliest = previous, latest = current
    return { previous: tagged[0].f, current: tagged[tagged.length-1].f };
  }

  async function generate(){
    try {
      setStatus('Parsing income structure…');
      const incPair = splitByDate(PARSED.income, periodFromIncome);
      if (!incPair.current || !incPair.previous){
        setStatus('Need 2 Income Structure files (one per week).', 'error');
        return;
      }
      const income = {
        current:  BCParsers.parseIncome(incPair.current.workbook),
        previous: BCParsers.parseIncome(incPair.previous.workbook),
      };
      window.__DATA__ = income;

      // Hours
      let hoursParsed = null;
      if (PARSED.hours.length >= 2){
        setStatus('Parsing hour statistics…');
        const hp = splitByDate(PARSED.hours, periodFromHours);
        hoursParsed = {
          current:  BCParsers.parseHours(hp.current.workbook),
          previous: BCParsers.parseHours(hp.previous.workbook),
        };
        window.__HOURS__ = hoursParsed;
      }

      // Jobs
      let jobPair = null;
      if (PARSED.jobs.length >= 2){
        setStatus('Parsing job analogue (this is the big one)…');
        jobPair = splitByDate(PARSED.jobs, periodFromJobs);
        const jobs = {
          current:  BCParsers.parseJobAnalogue(jobPair.current.workbook),
          previous: BCParsers.parseJobAnalogue(jobPair.previous.workbook),
        };
        window.__JOBS__ = jobs;

        // OTP
        setStatus('Building OTP airport breakdown…');
        const jobLocCur  = BCParsers.parseJobAnalogueWithLocations(jobPair.current.workbook);
        const jobLocPrev = BCParsers.parseJobAnalogueWithLocations(jobPair.previous.workbook);
        window.__OTP__ = BCParsers.buildOtp({ current: jobLocCur, previous: jobLocPrev });

        // Top clients
        setStatus('Ranking top clients…');
        window.__TOPCLIENTS__ = BCParsers.buildTopClients({
          current:  jobPair.current.workbook,
          previous: jobPair.previous.workbook,
        });

        // Operational KPIs (need hours too)
        if (hoursParsed){
          setStatus('Computing operational KPIs…');
          window.__KPIS__ = BCParsers.buildKpis(
            { current: jobPair.current.workbook, previous: jobPair.previous.workbook },
            hoursParsed,
            income
          );
        }
      }

      // Registrations
      if (PARSED.registrations.length >= 1){
        setStatus('Parsing registrations…');
        window.__REG__ = BCParsers.parseRegistrations(PARSED.registrations);
      }

      setStatus('Rendering dashboard…');
      // Hide upload UI, show dashboard
      document.getElementById('upload-wrap').style.display = 'none';
      document.getElementById('dashboard-area').style.display = 'block';
      window.renderDashboard();
      setStatus('Done.', 'ok');
    } catch (err){
      console.error(err);
      setStatus('Error: ' + err.message, 'error');
    }
  }
})();
