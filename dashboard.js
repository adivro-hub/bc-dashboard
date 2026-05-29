/* Shared rendering layer for the dashboard.
 * Reads window.__DATA__, __JOBS__, __HOURS__, __REG__, __OTP__, __TOPCLIENTS__,
 * __KPIS__ and renders all KPI cards, charts, tables and the pivot UI.
 *
 * Call window.renderDashboard() AFTER setting those globals.
 * The function is idempotent-ish: it appends DOM, so call only once per build.
 */
window.renderDashboard = function renderDashboard(){
  // ---------- Theme-aware Chart.js colours ----------
  const _cs = getComputedStyle(document.documentElement);
  const TEXT_COLOR  = (_cs.getPropertyValue('--text')  || '#1a2138').trim();
  const MUTED_COLOR = (_cs.getPropertyValue('--muted') || '#5d6788').trim();
  const PANEL_BG    = (_cs.getPropertyValue('--bg')    || '#0b1020').trim();
  const GRID_COLOR  = MUTED_COLOR.startsWith('#') && MUTED_COLOR.length === 7
    ? `rgba(${parseInt(MUTED_COLOR.slice(1,3),16)},${parseInt(MUTED_COLOR.slice(3,5),16)},${parseInt(MUTED_COLOR.slice(5,7),16)},.12)`
    : 'rgba(154,166,207,.12)';
  if (window.Chart && window.Chart.defaults){
    window.Chart.defaults.color = TEXT_COLOR;
    window.Chart.defaults.borderColor = GRID_COLOR;
  }

  // ---------- TAB SWITCHING ----------
  const tabsEl = document.getElementById('tabs');
  if (tabsEl && !tabsEl._wired){
    tabsEl._wired = true;
    tabsEl.addEventListener('click', e=>{
      if (e.target.tagName !== 'BUTTON') return;
      const target = e.target.dataset.tab;
      document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('active', b.dataset.tab===target));
      document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active', v.dataset.view===target));
      window.scrollTo({top:0, behavior:'smooth'});
    });
  }

  const D = window.__DATA__;
  if (!D) return;   // nothing to render without income structure
  const cur = D.current, prev = D.previous;
  const fmtMoney = v => (v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmtInt   = v => Math.round(v||0).toLocaleString('en-US');
  const fmtPct   = v => (v>=0?'+':'') + v.toFixed(1) + '%';

  function daysBetween(a, b){
    if (!a || !b) return 0;
    return Math.max(1, Math.round(
      (new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z'))/86400000) + 1);
  }
  function fmtDate(iso){
    if (!iso) return '—';
    const d = new Date(iso + 'T12:00:00Z');
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  const curDays  = daysBetween(cur.period_from,  cur.period_to);
  const prevDays = daysBetween(prev.period_from, prev.period_to);

  // Prominent banner — populated even if elements are missing (legacy DOM).
  const setText = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  setText('periodCurRange',  `${fmtDate(cur.period_from)} → ${fmtDate(cur.period_to)}`);
  setText('periodCurDays',   `${curDays} ${curDays === 1 ? 'day' : 'days'}`);
  setText('periodPrevRange', `${fmtDate(prev.period_from)} → ${fmtDate(prev.period_to)}`);
  setText('periodPrevDays',  `${prevDays} ${prevDays === 1 ? 'day' : 'days'}`);

  // Legacy line kept for any caller still relying on it.
  setText('periodLine',
    `Current: ${cur.period_from} → ${cur.period_to} (${curDays} days)`
    + `    •    Previous: ${prev.period_from} → ${prev.period_to} (${prevDays} days)`);

  // Freshness indicator: when each dataset was last refreshed.
  // Pulls synced_at (where available) + max date from /api/coverage.
  const freshEl = document.getElementById('freshnessLine');
  if (freshEl){
    const cov = window.BCCoverage || {};
    const parts = [];
    function part(label, dateMax, synced){
      if (!dateMax) return;
      let s = `${label}: <strong>${dateMax}</strong>`;
      if (synced){
        const d = new Date(synced);
        const ago = (Date.now() - d.getTime()) / 60000;  // minutes
        let when;
        if (ago < 1)        when = 'now';
        else if (ago < 60)  when = Math.round(ago) + ' min ago';
        else if (ago < 1440) when = Math.round(ago/60) + ' h ago';
        else                 when = d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' });
        s += ` <span class="muted">· refreshed ${when}</span>`;
      }
      parts.push(s);
    }
    part('Jobs',   (cov.jobs||{}).date_max);
    part('Regs',   (cov.registrations||{}).created_max ? String(cov.registrations.created_max).slice(0,10) : null);
    part('Hours',  (cov.hours||{}).date_max,         (cov.hours||{}).synced_at);
    // Income: pick the freshest synced_at across the 6 mirror tables; cap date is the min(max_date).
    const income = cov.income_structure || {};
    const incomeViews = Object.values(income).filter(v => v && !v.error);
    if (incomeViews.length){
      const incomeMaxDate = incomeViews.map(v => v.date_max).filter(Boolean).sort().slice(-1)[0];
      const incomeSynced  = incomeViews.map(v => v.synced_at).filter(Boolean).sort().slice(-1)[0];
      part('Income', incomeMaxDate, incomeSynced);
    }
    freshEl.innerHTML = parts.join('<span class="sep">·</span>');
  }

  // ---------- KPI CARDS ----------
  const kpiDefs = [
    {key:'total',       label:'Total sales (RON)', fmt:fmtMoney},
    {key:'jobs',        label:'Total jobs',        fmt:fmtInt},
    {key:'earnings',    label:'Earnings (RON)',    fmt:fmtMoney},
    {key:'avg_per_job', label:'Avg per job (RON)', fmt:fmtMoney},
    {key:'vat',         label:'VAT collected (RON)', fmt:fmtMoney},
  ];
  const grid = document.getElementById('kpiGrid');
  function addKpi(label, c, p, fmt){
    const delta = p? ((c-p)/p)*100 : 0;
    const cls = Math.abs(delta) < 0.05 ? 'flat' : (delta>=0?'up':'down');
    const arrow = cls==='up'?'▲':cls==='down'?'▼':'■';
    grid.insertAdjacentHTML('beforeend', `
      <div class="card kpi">
        <div class="label">${label}</div>
        <div class="value num">${fmt(c)}</div>
        <div class="prev num">prev ${fmt(p)}</div>
        <span class="delta ${cls}">${arrow} ${fmtPct(delta)}</span>
      </div>`);
  }
  kpiDefs.forEach(d=>{
    addKpi(d.label, cur.kpis[d.key], prev.kpis[d.key], d.fmt);
  });
  if (window.__TOPCLIENTS__ && window.__TOPCLIENTS__.retail){
    const rc = window.__TOPCLIENTS__.retail.context;
    addKpi('Unique retail clients', rc.cur_clients, rc.prev_clients, fmtInt);
  }

  // ---------- HELPERS ----------
  const COLOURS = ['#7c9cff','#ffb86b','#3ddc97','#ff6b8a','#a78bfa','#5ee2ff','#ffd166','#f78fb3',MUTED_COLOR,'#b4f8c8','#fbc4ab','#caffbf'];

  function unionKeys(a, b, sortByCurTotal=true){
    const set = new Set([...Object.keys(a||{}), ...Object.keys(b||{})]);
    let keys = [...set];
    if (sortByCurTotal){
      keys.sort((k1,k2) => ((b[k2]?.total ?? b[k2]?.jobs ?? 0) - (b[k1]?.total ?? b[k1]?.jobs ?? 0)));
    }
    return keys;
  }
  function getMetric(section, key, metric){
    return section[key] ? (section[key][metric] || 0) : 0;
  }

  // ---------- USER REGISTRATIONS ----------
  const R = window.__REG__;
  if (R){
    const sCur = R.summary.current, sPrev = R.summary.previous;
    const dTot = sCur.total - sPrev.total;
    const pTot = sPrev.total ? (dTot / sPrev.total) * 100 : 0;
    const cls = Math.abs(pTot) < 0.05 ? 'flat' : (pTot >= 0 ? 'up' : 'down');
    const arrow = cls==='up'?'▲':cls==='down'?'▼':'■';
    document.getElementById('regKpis').innerHTML = `
      <div class="card kpi">
        <div class="label">Current period</div>
        <div class="value num">${fmtInt(sCur.total)}</div>
        <div class="prev num">prev ${fmtInt(sPrev.total)}</div>
        <span class="delta ${cls}">${arrow} ${(pTot>=0?'+':'')+pTot.toFixed(1)}% (${dTot>=0?'+':''}${fmtInt(dTot)})</span>
      </div>
      <div class="card kpi">
        <div class="label">Combined (both periods)</div>
        <div class="value num">${fmtInt(sCur.total + sPrev.total)}</div>
        <div class="prev num muted">across both files</div>
      </div>`;

    function statusChips(label, m){
      const parts = Object.entries(m).map(([k,v])=>`<strong>${k}</strong> ${fmtInt(v)}`).join(' · ');
      return `<span class="chip">${label}: ${parts}</span>`;
    }
    document.getElementById('regStatus').innerHTML =
      statusChips('Current status', sCur.by_status) + statusChips('Previous status', sPrev.by_status);

    const curDates  = Object.keys(sCur.daily).sort();
    const prevDates = Object.keys(sPrev.daily).sort();
    const maxLen = Math.max(curDates.length, prevDates.length);
    const labels = Array.from({length:maxLen}, (_,i)=>`Day ${i+1}`);

    new Chart(document.getElementById('regChart'), {
      type:'bar',
      data:{
        labels,
        datasets:[
          {label:'Current',  data:curDates.map(d=>sCur.daily[d]),   backgroundColor:'#7c9cff', borderRadius:4},
          {label:'Previous', data:prevDates.map(d=>sPrev.daily[d]), backgroundColor:'#ffb86b', borderRadius:4},
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          legend:{labels:{color:TEXT_COLOR}},
          tooltip:{callbacks:{
            title:(items)=>{
              const i = items[0].dataIndex;
              const cd = curDates[i] || '—';
              const pd = prevDates[i] || '—';
              return `${items[0].label} (cur ${cd} / prev ${pd})`;
            },
            label:(ctx)=>`${ctx.dataset.label}: ${fmtInt(ctx.raw)}`
          }}
        },
        scales:{
          x:{ticks:{color:MUTED_COLOR}, grid:{color:GRID_COLOR}},
          y:{ticks:{color:MUTED_COLOR}, grid:{color:GRID_COLOR}, beginAtZero:true}
        }
      }
    });

    const f = R.files.map(x=>`${x.file}: ${x.rows} rows, ${x.min.slice(0,10)} → ${x.max.slice(0,10)}`).join('  •  ');
    document.getElementById('regNote').textContent =
      `Source files — ${f}.`;
  }

  // ---------- DONUTS ----------
  function makeDonut(canvasId, section, metric='total'){
    const entries = Object.entries(section)
      .map(([k,v])=>[k, v[metric]||0])
      .filter(([_,v])=>v>0)
      .sort((a,b)=>b[1]-a[1]);
    const labels = entries.map(e=>e[0]);
    const values = entries.map(e=>e[1]);
    new Chart(document.getElementById(canvasId), {
      type:'doughnut',
      data:{labels, datasets:[{data:values, backgroundColor:labels.map((_,i)=>COLOURS[i%COLOURS.length]), borderColor:PANEL_BG, borderWidth:2}]},
      options:{
        plugins:{
          legend:{position:'right', labels:{color:TEXT_COLOR, boxWidth:10, padding:8, font:{size:11}}},
          tooltip:{callbacks:{label:(ctx)=>{
            const tot = values.reduce((s,v)=>s+v,0);
            const pct = tot? (ctx.raw/tot*100).toFixed(1):0;
            return `${ctx.label}: ${fmtMoney(ctx.raw)} (${pct}%)`;
          }}}
        },
        cutout:'58%',
        responsive:true, maintainAspectRatio:false
      }
    });
  }

  // ---------- GROUPED BARS + TABLE ----------
  function makeBarsAndTable(canvasId, tableId, curSection, prevSection, metric='total', metricLabel='Total RON', tableFmt=fmtMoney, withJobs=true){
    const keys = unionKeys(curSection, prevSection);
    const curVals  = keys.map(k=>getMetric(curSection, k, metric));
    const prevVals = keys.map(k=>getMetric(prevSection, k, metric));
    const curJobs  = keys.map(k=>getMetric(curSection, k, 'jobs'));
    const prevJobs = keys.map(k=>getMetric(prevSection, k, 'jobs'));
    const showJobs = withJobs && metric !== 'jobs';

    new Chart(document.getElementById(canvasId), {
      type:'bar',
      data:{
        labels:keys,
        datasets:[
          {label:'Current', data:curVals,  backgroundColor:'#7c9cff', borderRadius:4},
          {label:'Previous',data:prevVals, backgroundColor:'#ffb86b', borderRadius:4},
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          legend:{labels:{color:TEXT_COLOR}},
          tooltip:{callbacks:{
            label:(ctx)=>`${ctx.dataset.label}: ${tableFmt(ctx.raw)}`,
            afterLabel:(ctx)=>{
              if (!showJobs) return '';
              const j = ctx.datasetIndex===0 ? curJobs[ctx.dataIndex] : prevJobs[ctx.dataIndex];
              return `Jobs: ${fmtInt(j)}`;
            }
          }}
        },
        scales:{
          x:{ticks:{color:MUTED_COLOR, autoSkip:false, maxRotation:55, minRotation:35}, grid:{color:GRID_COLOR}},
          y:{ticks:{color:MUTED_COLOR, callback:v=>v>=1000?(v/1000).toFixed(0)+'k':v}, grid:{color:GRID_COLOR}}
        }
      }
    });

    const table = document.getElementById(tableId);
    const headExtra = showJobs ? `<th>Cur jobs</th><th>Prev jobs</th><th>Δ jobs %</th>` : ``;
    let html = `<thead><tr>
      <th>Item</th>
      ${headExtra}
      <th>Current ${metricLabel}</th>
      <th>Previous ${metricLabel}</th>
      <th>Δ abs</th>
      <th>Δ %</th>
      <th>Share now</th>
    </tr></thead><tbody>`;
    const totCur = curVals.reduce((s,v)=>s+v,0);
    const totCurJobs  = curJobs.reduce((s,v)=>s+v,0);
    const totPrevJobs = prevJobs.reduce((s,v)=>s+v,0);
    keys.forEach((k,i)=>{
      const c = curVals[i], p = prevVals[i];
      const dAbs = c - p;
      const dPct = p? (dAbs/p)*100 : (c?100:0);
      const share = totCur? (c/totCur)*100 : 0;
      const dCls = Math.abs(dAbs) < 0.005 ? 'muted' : (dAbs>=0?'pos':'neg');

      let jobsCells = '';
      if (showJobs){
        const cj = curJobs[i], pj = prevJobs[i];
        const dj  = cj - pj;
        const djPct = pj ? (dj/pj)*100 : (cj?100:0);
        const djCls = Math.abs(dj) < 0.5 ? 'muted' : (dj>=0?'pos':'neg');
        jobsCells = `
          <td class="num">${fmtInt(cj)}</td>
          <td class="num muted">${fmtInt(pj)}</td>
          <td class="num ${djCls}">${pj? (dj>=0?'+':'')+djPct.toFixed(1)+'%' : (cj?'new':'—')}</td>`;
      }

      html += `<tr>
        <td>${k}</td>
        ${jobsCells}
        <td class="num">${tableFmt(c)}</td>
        <td class="num muted">${tableFmt(p)}</td>
        <td class="num ${dCls}">${dAbs>=0?'+':''}${tableFmt(dAbs)}</td>
        <td class="num ${dCls}">${p? (dAbs>=0?'+':'')+dPct.toFixed(1)+'%' : (c?'new':'—')}</td>
        <td class="num">${share.toFixed(1)}%</td>
      </tr>`;
    });
    const totPrev = prevVals.reduce((s,v)=>s+v,0);
    const dAbs = totCur - totPrev;
    const dPct = totPrev? (dAbs/totPrev)*100 : 0;
    let totJobsCells = '';
    if (showJobs){
      const dj = totCurJobs - totPrevJobs;
      const djPct = totPrevJobs ? (dj/totPrevJobs)*100 : 0;
      const djCls = dj>=0?'pos':'neg';
      totJobsCells = `
        <td class="num">${fmtInt(totCurJobs)}</td>
        <td class="num">${fmtInt(totPrevJobs)}</td>
        <td class="num ${djCls}">${(dj>=0?'+':'')+djPct.toFixed(1)+'%'}</td>`;
    }
    html += `<tr style="font-weight:700">
      <td>Total</td>
      ${totJobsCells}
      <td class="num">${tableFmt(totCur)}</td>
      <td class="num">${tableFmt(totPrev)}</td>
      <td class="num ${dAbs>=0?'pos':'neg'}">${dAbs>=0?'+':''}${tableFmt(dAbs)}</td>
      <td class="num ${dAbs>=0?'pos':'neg'}">${(dAbs>=0?'+':'')}${dPct.toFixed(1)}%</td>
      <td class="num">100%</td>
    </tr></tbody>`;
    table.innerHTML = html;
  }

  makeDonut('donutPayment',  cur.sections.payment_type);
  makeDonut('donutCustomer', cur.sections.customer_grade);
  makeDonut('donutService',  cur.sections.service);
  makeDonut('donutFleet',    cur.sections.fleet);

  makeBarsAndTable('barPayment',  'tblPayment',  cur.sections.payment_type,   prev.sections.payment_type);
  makeBarsAndTable('barCustomer', 'tblCustomer', cur.sections.customer_grade, prev.sections.customer_grade);
  makeBarsAndTable('barService',  'tblService',  cur.sections.service,        prev.sections.service);
  makeBarsAndTable('barFleet',    'tblFleet',    cur.sections.fleet,          prev.sections.fleet);
  makeBarsAndTable('barHours',    'tblHours',    cur.sections.driver_hours,   prev.sections.driver_hours, 'jobs', 'hours', fmtInt);

  // ---------- HOURS PER JOB BY FLEET ----------
  function hoursPerJobByFleet(week){
    const hours = week.sections.driver_hours;
    const fleet = week.sections.fleet;
    const keys = new Set([...Object.keys(hours||{}), ...Object.keys(fleet||{})]);
    const rows = [];
    keys.forEach(k=>{
      const h = hours[k]?.jobs ?? 0;
      const j = fleet[k]?.jobs ?? 0;
      rows.push({fleet:k, hours:h, jobs:j, hpj: j>0 ? h/j : null});
    });
    return rows;
  }
  const hpjCur  = hoursPerJobByFleet(cur);
  const hpjPrev = hoursPerJobByFleet(prev);
  const hpjAll = new Map();
  [...hpjCur, ...hpjPrev].forEach(r=>{ if (!hpjAll.has(r.fleet)) hpjAll.set(r.fleet, true); });
  const fleetOrder = [...hpjAll.keys()].sort((a,b)=>{
    const ja = (hpjCur.find(r=>r.fleet===a)?.jobs || 0);
    const jb = (hpjCur.find(r=>r.fleet===b)?.jobs || 0);
    return jb - ja;
  });
  const curMap  = Object.fromEntries(hpjCur.map(r=>[r.fleet,r]));
  const prevMap = Object.fromEntries(hpjPrev.map(r=>[r.fleet,r]));
  const curHpjVals  = fleetOrder.map(f => curMap[f]?.hpj ?? null);
  const prevHpjVals = fleetOrder.map(f => prevMap[f]?.hpj ?? null);

  new Chart(document.getElementById('barHoursPerJob'), {
    type:'bar',
    data:{
      labels: fleetOrder,
      datasets:[
        {label:'Current', data:curHpjVals,  backgroundColor:'#7c9cff', borderRadius:4},
        {label:'Previous',data:prevHpjVals, backgroundColor:'#ffb86b', borderRadius:4},
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{labels:{color:TEXT_COLOR}},
        tooltip:{callbacks:{label:(ctx)=>{
          const v = ctx.raw;
          return `${ctx.dataset.label}: ${v==null?'n/a':v.toFixed(2)+' h/job'}`;
        }}}
      },
      scales:{
        x:{ticks:{color:MUTED_COLOR, autoSkip:false, maxRotation:55, minRotation:35}, grid:{color:GRID_COLOR}},
        y:{ticks:{color:MUTED_COLOR, callback:v=>v.toFixed(1)}, grid:{color:GRID_COLOR}, title:{display:true,text:'Hours per job',color:MUTED_COLOR}}
      }
    }
  });

  let hpjHtml = `<thead><tr>
    <th>Fleet</th><th>Cur hours</th><th>Prev hours</th>
    <th>Cur jobs</th><th>Prev jobs</th>
    <th>Cur h/job</th><th>Prev h/job</th><th>Δ %</th>
  </tr></thead><tbody>`;
  let curHTot=0, curJTot=0, prevHTot=0, prevJTot=0;
  fleetOrder.forEach(f=>{
    const c = curMap[f]  || {hours:0, jobs:0, hpj:null};
    const p = prevMap[f] || {hours:0, jobs:0, hpj:null};
    curHTot += c.hours; curJTot += c.jobs;
    prevHTot += p.hours; prevJTot += p.jobs;
    const d    = (c.hpj!=null && p.hpj!=null) ? (c.hpj - p.hpj) : null;
    const dPct = (d!=null && p.hpj>0) ? (d / p.hpj) * 100 : null;
    const dCls = d==null ? 'muted' : (Math.abs(d)<0.005?'muted' : (d<=0?'pos':'neg'));
    hpjHtml += `<tr>
      <td>${f}</td>
      <td class="num">${fmtInt(c.hours)}</td>
      <td class="num muted">${fmtInt(p.hours)}</td>
      <td class="num">${fmtInt(c.jobs)}</td>
      <td class="num muted">${fmtInt(p.jobs)}</td>
      <td class="num">${c.hpj==null?'<span class="muted">—</span>':c.hpj.toFixed(2)}</td>
      <td class="num muted">${p.hpj==null?'—':p.hpj.toFixed(2)}</td>
      <td class="num ${dCls}">${dPct==null?'—':(dPct>=0?'+':'')+dPct.toFixed(1)+'%'}</td>
    </tr>`;
  });
  const curOverall  = curJTot>0  ? curHTot/curJTot   : null;
  const prevOverall = prevJTot>0 ? prevHTot/prevJTot : null;
  const dOverall    = (curOverall!=null && prevOverall!=null) ? curOverall - prevOverall : null;
  const dOverallPct = (dOverall!=null && prevOverall>0) ? (dOverall / prevOverall) * 100 : null;
  const dOverallCls = dOverall==null ? 'muted' : (dOverall<=0?'pos':'neg');
  hpjHtml += `<tr style="font-weight:700">
    <td>Overall</td>
    <td class="num">${fmtInt(curHTot)}</td>
    <td class="num">${fmtInt(prevHTot)}</td>
    <td class="num">${fmtInt(curJTot)}</td>
    <td class="num">${fmtInt(prevJTot)}</td>
    <td class="num">${curOverall==null?'—':curOverall.toFixed(2)}</td>
    <td class="num">${prevOverall==null?'—':prevOverall.toFixed(2)}</td>
    <td class="num ${dOverallCls}">${dOverallPct==null?'—':(dOverallPct>=0?'+':'')+dOverallPct.toFixed(1)+'%'}</td>
  </tr></tbody>`;
  document.getElementById('tblHoursPerJob').innerHTML = hpjHtml;

  // ---------- TOP 25 CLIENTS ----------
  const TC = window.__TOPCLIENTS__;
  if (TC){
    function renderTopClients(box, table, payload, labelFn){
      const top = payload.top, ctx = payload.context;
      if (!top || !top.length){
        box.innerHTML = '';
        table.innerHTML = '<tbody><tr><td class="empty-state">Niciun client în această perioadă. Alege un interval mai larg sau verifică datele.</td></tr></tbody>';
        return;
      }
      let tcj=0, tpj=0, tct=0, tpt=0, tce=0, tpe=0;
      top.forEach(r=>{ tcj+=r.cur_jobs; tpj+=r.prev_jobs;
        tct+=r.cur_total; tpt+=r.prev_total;
        tce+=r.cur_earnings; tpe+=r.prev_earnings; });
      function chip(label, val){ return `<span class="chip">${label}: <strong>${val}</strong></span>`; }
      function chipD(label, c, p, fmt){
        const d = c-p; const pct = p? ((c-p)/p)*100 : 0;
        const cls = Math.abs(d)<0.005?'muted':(d>=0?'pos':'neg');
        return `<span class="chip">${label}: <strong>${fmt(c)}</strong> vs <strong>${fmt(p)}</strong> <span class="${cls}">${pct>=0?'+':''}${pct.toFixed(1)}%</span></span>`;
      }
      box.innerHTML =
        chip('Cur active clients (total)', fmtInt(ctx.cur_clients)) +
        chip('Prev active clients',        fmtInt(ctx.prev_clients)) +
        chipD('Top 25 Σ Total', tct, tpt, fmtMoney) +
        chipD('Top 25 Σ Earnings', tce, tpe, fmtMoney) +
        `<span class="chip">Share of segment: <strong>${(tct/ctx.cur_total*100).toFixed(1)}%</strong> cur · <strong>${(tpt/ctx.prev_total*100).toFixed(1)}%</strong> prev</span>`;

      let html = `<thead><tr>
        <th>Client</th>
        <th>Cur jobs</th><th>Cur Σ Total</th><th>Cur Earnings</th>
        <th>Prev jobs</th><th>Prev Σ Total</th><th>Prev Earnings</th>
        <th>Σ jobs</th><th>Σ Total</th><th>Σ Earnings</th>
      </tr></thead><tbody>`;
      top.forEach(r=>{
        html += `<tr>
          <td>${labelFn(r)}</td>
          <td class="num">${fmtInt(r.cur_jobs)}</td>
          <td class="num">${fmtMoney(r.cur_total)}</td>
          <td class="num">${fmtMoney(r.cur_earnings)}</td>
          <td class="num muted">${fmtInt(r.prev_jobs)}</td>
          <td class="num muted">${fmtMoney(r.prev_total)}</td>
          <td class="num muted">${fmtMoney(r.prev_earnings)}</td>
          <td class="num">${fmtInt(r.combined_jobs)}</td>
          <td class="num">${fmtMoney(r.combined_total)}</td>
          <td class="num">${fmtMoney(r.combined_earnings)}</td>
        </tr>`;
      });
      html += `<tr style="font-weight:700">
        <td>Total (top 25)</td>
        <td class="num">${fmtInt(tcj)}</td>
        <td class="num">${fmtMoney(tct)}</td>
        <td class="num">${fmtMoney(tce)}</td>
        <td class="num">${fmtInt(tpj)}</td>
        <td class="num">${fmtMoney(tpt)}</td>
        <td class="num">${fmtMoney(tpe)}</td>
        <td class="num">${fmtInt(tcj+tpj)}</td>
        <td class="num">${fmtMoney(tct+tpt)}</td>
        <td class="num">${fmtMoney(tce+tpe)}</td>
      </tr></tbody>`;
      table.innerHTML = html;
    }

    renderTopClients(
      document.getElementById('topRetailSummary'),
      document.getElementById('topRetailTable'),
      TC.retail,
      r => r.client_id
    );
    renderTopClients(
      document.getElementById('topCorpSummary'),
      document.getElementById('topCorpTable'),
      TC.corporate,
      // Anonymise corporate accounts unless the user explicitly enabled
      // "Show client names" in the header toggle. Default: numbers only.
      r => (window.BC_showNames && r.account_name)
            ? `${r.account_no} — ${r.account_name}`
            : String(r.account_no)
    );
  }

  // ---------- CLIENT LTV ----------
  // Fetch + render the Client LTV tab content. Independent of the
  // jobs / income data the rest of renderDashboard wired up.
  renderClientLTV().catch(e => console.error('LTV render failed:', e));

  async function renderClientLTV(){
    const kpiBox = document.getElementById('ltvKpis');
    const tbl    = document.getElementById('ltvTable');
    const pill   = document.getElementById('ltvMatchPill');
    const note   = document.getElementById('ltvTableNote');
    const canvas = document.getElementById('ltvCohortChart');
    if (!kpiBox || !tbl) return;

    let body;
    try {
      const r = await fetch('/api/clients/ltv?limit=50&order_by=ltv_180d', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      body = await r.json();
    } catch (e) {
      kpiBox.innerHTML = `<div class="card empty-state">Could not load LTV data: ${e.message}</div>`;
      return;
    }
    const s = body.summary;
    const fmtRon = v => (v || 0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' RON';
    const fmtPct = v => ((v || 0) * 100).toFixed(1) + '%';

    function card(label, value, sub){
      return `<div class="card kpi">
        <div class="label">${label}</div>
        <div class="value num">${value}</div>
        <div class="prev num muted">${sub || ''}</div>
      </div>`;
    }
    kpiBox.innerHTML =
      card('Avg LTV 30 days',  fmtRon(s.avg_ltv_30d),  `${s.mature_180d_clients ? s.mature_180d_clients.toLocaleString() : 0} mature clients`) +
      card('Avg LTV 90 days',  fmtRon(s.avg_ltv_90d),  `median ${fmtRon(s.median_ltv_180d)} (180d)`) +
      card('Avg LTV 180 days', fmtRon(s.avg_ltv_180d), `top decile ${fmtRon(s.top_decile_ltv_180d)}`) +
      card('Top LTV 180d',     fmtRon(s.max_ltv_180d), 'highest single client') +
      card('Total matched',    (s.clients_with_any_match || 0).toLocaleString(), `${(s.registrations_total || 0).toLocaleString()} registrations total`) +
      card('Match rate',       fmtPct(s.match_rate),   'registrations with ≥1 ride');

    if (pill){
      pill.textContent = `${body.total_clients_in_filter.toLocaleString()} clients`;
    }
    if (note){
      note.textContent = `Sorted by LTV 180d (descending). Grey rows = not yet mature for that window (registered recently).`;
    }

    // Table rendering
    if (!body.clients.length){
      tbl.innerHTML = '<tbody><tr><td class="empty-state">No clients yet. The cohort table will fill in as the nightly LTV refresh runs.</td></tr></tbody>';
    } else {
      const fmtNum  = v => (v == null ? '—' : fmtRon(v));
      const fmtRds  = v => (v == null || v === 0 ? '—' : String(v));
      const tag = (mature, value, rides) => {
        const cell = `${fmtNum(value)} <span class="muted">(${fmtRds(rides)})</span>`;
        return mature ? cell : `<span class="muted" title="Registered too recently">${cell}</span>`;
      };
      let html = `<thead><tr>
        <th>Client (hash)</th>
        <th>Registered</th>
        <th>LTV 30d (rides)</th>
        <th>LTV 90d (rides)</th>
        <th>LTV 180d (rides)</th>
        <th>All-time rides</th>
        <th>All-time earn</th>
        <th>Last ride</th>
      </tr></thead><tbody>`;
      for (const c of body.clients){
        html += `<tr>
          <td><code style="font-size:11px">${c.client_id}…</code></td>
          <td class="num">${c.registered_at || '—'}</td>
          <td class="num">${tag(c.mature_30d,  c.ltv_30d,  c.rides_30d)}</td>
          <td class="num">${tag(c.mature_90d,  c.ltv_90d,  c.rides_90d)}</td>
          <td class="num">${tag(c.mature_180d, c.ltv_180d, c.rides_180d)}</td>
          <td class="num">${c.total_rides_all || 0}</td>
          <td class="num">${fmtRon(c.total_earn_all || 0)}</td>
          <td class="num muted">${c.last_ride_at || '—'}</td>
        </tr>`;
      }
      html += '</tbody>';
      tbl.innerHTML = html;
    }

    // Cohort table (the explicit, exact-numbers view) — sits below the chart.
    const cohortTable = document.getElementById('ltvCohortTable');
    if (cohortTable && body.by_cohort_month){
      const fmtCell = v => v == null ? '<span class="muted">—</span>' : fmtRon(v);
      let html = `<thead><tr>
        <th>Cohort</th>
        <th class="num">Signups</th>
        <th class="num">Matched</th>
        <th class="num">Match %</th>
        <th class="num">Avg LTV 30d</th>
        <th class="num">Avg LTV 90d</th>
        <th class="num">Avg LTV 180d</th>
      </tr></thead><tbody>`;
      for (const m of body.by_cohort_month){
        const matchPct = m.signups ? ((m.matched / m.signups) * 100).toFixed(1) + '%' : '—';
        html += `<tr>
          <td><strong>${m.month}</strong></td>
          <td class="num">${(m.signups || 0).toLocaleString()}</td>
          <td class="num">${(m.matched || 0).toLocaleString()}</td>
          <td class="num muted">${matchPct}</td>
          <td class="num">${fmtCell(m.avg_ltv_30d)}</td>
          <td class="num">${fmtCell(m.avg_ltv_90d)}</td>
          <td class="num">${fmtCell(m.avg_ltv_180d)}</td>
        </tr>`;
      }
      html += '</tbody>';
      cohortTable.innerHTML = html;
    }

    // Cohort chart: 3 lines (avg LTV 30d / 90d / 180d) per month.
    // Faded markers when avg is null (cohort too recent for that window).
    if (canvas && body.by_cohort_month && body.by_cohort_month.length){
      const months = body.by_cohort_month;
      const labels = months.map(m => m.month);
      const series = (key, color) => ({
        label: key.replace('avg_ltv_', 'LTV ').replace('d', ' days'),
        data: months.map(m => m[key]),
        spanGaps: true,
        borderColor: color,
        backgroundColor: color + '20',
        tension: 0.25,
        pointRadius: 3,
      });
      if (canvas._chart) canvas._chart.destroy();
      canvas._chart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            series('avg_ltv_30d',  '#7c9cff'),
            series('avg_ltv_90d',  '#f5cc1e'),
            series('avg_ltv_180d', '#3ddc97'),
          ],
        },
        options: {
          responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{ labels:{ color: TEXT_COLOR } },
                    tooltip:{ callbacks:{
                      afterLabel: (ctx) => {
                        const m = months[ctx.dataIndex];
                        return `signups: ${m.signups.toLocaleString()} · matched: ${m.matched.toLocaleString()}`;
                      }
                    }}},
          scales:{
            x:{ ticks:{ color: TEXT_COLOR }, grid:{ color: GRID_COLOR } },
            y:{ ticks:{ color: TEXT_COLOR, callback: v => v + ' RON' }, grid:{ color: GRID_COLOR } },
          },
        }
      });
    }
  }

  // ---------- OTP ----------
  const OTP = window.__OTP__;
  if (OTP){
    function totals(side){
      const cur = OTP.current[side]  || {};
      const prev= OTP.previous[side] || {};
      const cj = Object.values(cur).reduce((s,v)=>s+v.jobs,0);
      const pj = Object.values(prev).reduce((s,v)=>s+v.jobs,0);
      const ct = Object.values(cur).reduce((s,v)=>s+v.total,0);
      const pt = Object.values(prev).reduce((s,v)=>s+v.total,0);
      return {cj, pj, ct, pt};
    }
    function chip(label, c, p, fmt){
      const d = c-p;
      const pct = p? ((c-p)/p)*100 : 0;
      const cls = Math.abs(d) < 0.005 ? 'muted' : (d>=0?'pos':'neg');
      const sign = d>=0?'+':'';
      return `<span class="chip">${label}: <strong>${fmt(c)}</strong> vs <strong>${fmt(p)}</strong> <span class="${cls}">${sign}${pct.toFixed(1)}%</span></span>`;
    }
    const tp = totals('pickup'), td = totals('dropoff');
    document.getElementById('otpSummary').innerHTML =
      `<span class="chip"><strong style="color:var(--accent)">PICKUP</strong></span>` +
      chip('Jobs',     tp.cj, tp.pj, fmtInt) +
      chip('Σ Total',  tp.ct, tp.pt, fmtMoney) +
      `<span class="chip" style="margin-left:14px"><strong style="color:var(--prev)">DESTINATION</strong></span>` +
      chip('Jobs',     td.cj, td.pj, fmtInt) +
      chip('Σ Total',  td.ct, td.pt, fmtMoney);

    function renderOtp(side, canvasId, tableId){
      const cur  = OTP.current[side]  || {};
      const prev = OTP.previous[side] || {};
      const services = [...new Set([...Object.keys(cur), ...Object.keys(prev)])]
        .sort((a,b)=>(cur[b]?.jobs ?? 0) - (cur[a]?.jobs ?? 0));

      new Chart(document.getElementById(canvasId), {
        type:'bar',
        data:{
          labels: services,
          datasets:[
            {label:'Current jobs',  data: services.map(s=>cur[s]?.jobs  ?? 0), backgroundColor:'#7c9cff', borderRadius:4},
            {label:'Previous jobs', data: services.map(s=>prev[s]?.jobs ?? 0), backgroundColor:'#ffb86b', borderRadius:4},
          ]
        },
        options:{
          responsive:true, maintainAspectRatio:false,
          plugins:{
            legend:{labels:{color:TEXT_COLOR}},
            tooltip:{callbacks:{
              label:(ctx)=>`${ctx.dataset.label}: ${fmtInt(ctx.raw)}`,
              afterLabel:(ctx)=>{
                const s = services[ctx.dataIndex];
                const t = ctx.datasetIndex===0 ? cur[s]?.total : prev[s]?.total;
                return `Σ Total: ${fmtMoney(t || 0)}`;
              }
            }}
          },
          scales:{
            x:{ticks:{color:MUTED_COLOR, autoSkip:false, maxRotation:35, minRotation:0}, grid:{color:GRID_COLOR}},
            y:{ticks:{color:MUTED_COLOR}, grid:{color:GRID_COLOR}, beginAtZero:true}
          }
        }
      });

      let html = `<thead><tr>
        <th>Service</th>
        <th>Cur jobs</th><th>Prev jobs</th><th>Δ %</th>
        <th>Cur Σ Total</th><th>Prev Σ Total</th><th>Δ %</th>
      </tr></thead><tbody>`;
      let tcj=0, tpj=0, tct=0, tpt=0;
      services.forEach(s=>{
        const cj = cur[s]?.jobs ?? 0,  pj = prev[s]?.jobs ?? 0;
        const ct = cur[s]?.total ?? 0, pt = prev[s]?.total ?? 0;
        tcj+=cj; tpj+=pj; tct+=ct; tpt+=pt;
        const dj = cj-pj, dt = ct-pt;
        const djPct = pj ? (dj/pj)*100 : (cj?100:0);
        const dtPct = pt ? (dt/pt)*100 : (ct?100:0);
        const djCls = Math.abs(dj)<0.5 ? 'muted' : (dj>=0?'pos':'neg');
        const dtCls = Math.abs(dt)<0.005 ? 'muted' : (dt>=0?'pos':'neg');
        html += `<tr>
          <td>${s}</td>
          <td class="num">${fmtInt(cj)}</td>
          <td class="num muted">${fmtInt(pj)}</td>
          <td class="num ${djCls}">${pj? (dj>=0?'+':'')+djPct.toFixed(1)+'%' : (cj?'new':'—')}</td>
          <td class="num">${fmtMoney(ct)}</td>
          <td class="num muted">${fmtMoney(pt)}</td>
          <td class="num ${dtCls}">${pt? (dt>=0?'+':'')+dtPct.toFixed(1)+'%' : (ct?'new':'—')}</td>
        </tr>`;
      });
      const dj = tcj-tpj, dt = tct-tpt;
      const djPct = tpj ? (dj/tpj)*100 : 0;
      const dtPct = tpt ? (dt/tpt)*100 : 0;
      html += `<tr style="font-weight:700">
        <td>Total</td>
        <td class="num">${fmtInt(tcj)}</td>
        <td class="num">${fmtInt(tpj)}</td>
        <td class="num ${dj>=0?'pos':'neg'}">${(dj>=0?'+':'')+djPct.toFixed(1)+'%'}</td>
        <td class="num">${fmtMoney(tct)}</td>
        <td class="num">${fmtMoney(tpt)}</td>
        <td class="num ${dt>=0?'pos':'neg'}">${(dt>=0?'+':'')+dtPct.toFixed(1)+'%'}</td>
      </tr></tbody>`;
      document.getElementById(tableId).innerHTML = html;
    }
    renderOtp('pickup',  'otpPickupChart',  'otpPickupTable');
    renderOtp('dropoff', 'otpDropoffChart', 'otpDropoffTable');
  }

  // ---------- HOUR STATISTICS ----------
  const H = window.__HOURS__;
  if (H){
    const hCur = H.current, hPrev = H.previous;
    document.getElementById('hourCurPeriod').textContent  = hCur.period;
    document.getElementById('hourPrevPeriod').textContent = hPrev.period;

    const hKpiDefs = [
      {label:'Peak available vehicles', get:d=>d.derived.peak_available, fmt:fmtInt},
      {label:'Peak vehicles on job',    get:d=>d.derived.peak_busy,      fmt:fmtInt},
      {label:'Avg utilisation',         get:d=>d.derived.util_avg*100,   fmt:v=>v.toFixed(1)+'%'},
      {label:'Σ Online vehicle-hours',  get:d=>d.derived.online_total,   fmt:fmtInt},
      {label:'Σ On-break vehicle-hours',get:d=>d.derived.on_break_total, fmt:fmtInt},
    ];
    const hGrid = document.getElementById('hourKpis');
    hKpiDefs.forEach(def=>{
      const c = def.get(hCur), p = def.get(hPrev);
      const delta = p? ((c-p)/p)*100 : 0;
      const cls = Math.abs(delta) < 0.05 ? 'flat' : (delta>=0?'up':'down');
      const arrow = cls==='up'?'▲':cls==='down'?'▼':'■';
      hGrid.insertAdjacentHTML('beforeend', `
        <div class="card kpi">
          <div class="label">${def.label}</div>
          <div class="value num">${def.fmt(c)}</div>
          <div class="prev num">prev ${def.fmt(p)}</div>
          <span class="delta ${cls}">${arrow} ${(delta>=0?'+':'')+delta.toFixed(1)}%</span>
        </div>`);
    });

    const hourLabels = Array.from({length:24}, (_,h)=>String(h).padStart(2,'0')+':00');
    const availCur  = hCur.by_hour_of_day.online.map((o,i)=>o - hCur.by_hour_of_day.on_break[i]);
    const availPrev = hPrev.by_hour_of_day.online.map((o,i)=>o - hPrev.by_hour_of_day.on_break[i]);
    const busyCur   = hCur.by_hour_of_day.doing_job;
    const busyPrev  = hPrev.by_hour_of_day.doing_job;

    new Chart(document.getElementById('hourAvgChart'), {
      type:'line',
      data:{
        labels: hourLabels,
        datasets:[
          {label:'Available — current',  data:availCur,  borderColor:'#7c9cff', backgroundColor:'rgba(124,156,255,.18)', fill:true,  tension:.3, borderWidth:2.5, pointRadius:2},
          {label:'Busy — current',       data:busyCur,   borderColor:'#3ddc97', backgroundColor:'rgba(61,220,151,.18)',  fill:true,  tension:.3, borderWidth:2.5, pointRadius:2},
          {label:'Available — previous', data:availPrev, borderColor:'#ffb86b', borderDash:[6,4], fill:false, tension:.3, borderWidth:2, pointRadius:0},
          {label:'Busy — previous',      data:busyPrev,  borderColor:'#ff6b8a', borderDash:[6,4], fill:false, tension:.3, borderWidth:2, pointRadius:0},
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        interaction:{mode:'index', intersect:false},
        plugins:{
          legend:{labels:{color:TEXT_COLOR}},
          tooltip:{callbacks:{label:(ctx)=>`${ctx.dataset.label}: ${ctx.raw.toFixed(1)}`}}
        },
        scales:{
          x:{ticks:{color:MUTED_COLOR}, grid:{color:GRID_COLOR}},
          y:{ticks:{color:MUTED_COLOR}, grid:{color:GRID_COLOR}, title:{display:true,text:'Vehicles (avg)',color:MUTED_COLOR}}
        }
      }
    });

    function timelineChart(canvasId, week){
      const ts = week.timestamps.map(s => {
        const d = new Date(s);
        return d.toLocaleString('en-GB',{weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false});
      });
      const online   = week.hourly.online;
      const onBreak  = week.hourly.on_break;
      const busy     = week.hourly.doing_job;
      const available= online.map((o,i)=>Math.max(0, o - onBreak[i]));
      const idle     = available.map((a,i)=>Math.max(0, a - busy[i]));

      new Chart(document.getElementById(canvasId), {
        type:'line',
        data:{
          labels: ts,
          datasets:[
            {label:'Busy (doing job)', data:busy, borderColor:'#3ddc97', backgroundColor:'rgba(61,220,151,.55)', fill:'origin', tension:.25, borderWidth:1.5, pointRadius:0, stack:'a'},
            {label:'Idle available',    data:idle, borderColor:'#7c9cff', backgroundColor:'rgba(124,156,255,.35)', fill:'-1',     tension:.25, borderWidth:1,   pointRadius:0, stack:'a'},
            {label:'On break',          data:onBreak, borderColor:'#ffb86b', backgroundColor:'rgba(255,184,107,.20)', fill:'-1', tension:.25, borderWidth:1,  pointRadius:0, stack:'a'},
            {label:'Online (total)',    data:online, borderColor:TEXT_COLOR, backgroundColor:'transparent', fill:false, tension:.25, borderWidth:1.5, pointRadius:0, borderDash:[3,3]},
          ]
        },
        options:{
          responsive:true, maintainAspectRatio:false,
          interaction:{mode:'index', intersect:false},
          plugins:{
            legend:{labels:{color:TEXT_COLOR, boxWidth:12, font:{size:11}}},
            tooltip:{callbacks:{title:(items)=>items[0].label, label:(ctx)=>`${ctx.dataset.label}: ${Math.round(ctx.raw)}`}}
          },
          scales:{
            x:{ticks:{color:MUTED_COLOR, autoSkip:true, maxTicksLimit:14}, grid:{color:GRID_COLOR}},
            y:{stacked:false, ticks:{color:MUTED_COLOR}, grid:{color:GRID_COLOR}, title:{display:true,text:'Vehicles',color:MUTED_COLOR}}
          }
        }
      });
    }
    timelineChart('hourCurChart',  hCur);
    timelineChart('hourPrevChart', hPrev);
  }

  // ---------- PIVOT ----------
  const J = window.__JOBS__;
  if (J){
    document.getElementById('pivotPeriodCur').textContent  = `${cur.period_from} → ${cur.period_to}`;
    document.getElementById('pivotPeriodPrev').textContent = `${prev.period_from} → ${prev.period_to}`;

    const allRows = [...J.current.map(r=>({...r,_w:'current'})), ...J.previous.map(r=>({...r,_w:'previous'}))];

    function distinct(field){
      const set = new Set(allRows.map(r=>r[field]));
      let arr = [...set].filter(v => v !== '' && v !== null && v !== undefined);
      arr.sort();
      return arr;
    }
    const accountMap = {};
    allRows.forEach(r=>{
      if (!r.account_no) return;
      if (!accountMap[r.account_no]) accountMap[r.account_no] = r.account_name || '';
    });
    const accountOpts = Object.keys(accountMap).sort((a,b)=>(accountMap[a]||a).localeCompare(accountMap[b]||b));
    const urgencyOpts = distinct('urgency');
    const statusOpts  = distinct('status');
    const hourOpts    = [...new Set(allRows.map(r=>r.hour))]
                          .filter(h=>h!==null && h!==undefined)
                          .sort((a,b)=>a-b);

    const sel = {
      account: new Set(accountOpts),
      urgency: new Set(urgencyOpts),
      status:  new Set(statusOpts),
      hour:    new Set(hourOpts),
    };

    function buildFilter(elId, key, opts, labelFn){
      const root = document.getElementById(elId);
      const optBox = root.querySelector('[data-options]');
      const search = root.querySelector('[data-search]');
      const countEl = root.querySelector('[data-count]');

      function render(filterText=''){
        const t = filterText.trim().toLowerCase();
        optBox.innerHTML = '';
        const visible = opts.filter(v => !t || labelFn(v).toLowerCase().includes(t));
        visible.forEach(v=>{
          const id = `${key}-${String(v).replace(/[^\w]/g,'_')}`;
          const div = document.createElement('label');
          div.className = 'opt';
          const checked = sel[key].has(v) ? 'checked' : '';
          div.innerHTML = `<input type="checkbox" id="${id}" ${checked} /> <span class="lbl">${labelFn(v)}</span>`;
          div.querySelector('input').addEventListener('change', e=>{
            if (e.target.checked) sel[key].add(v); else sel[key].delete(v);
            updateCount();
            recompute();
          });
          optBox.appendChild(div);
        });
        updateCount();
      }
      function updateCount(){ countEl.textContent = `${sel[key].size}/${opts.length}`; }

      root.querySelector('[data-all]').addEventListener('click', ()=>{
        sel[key] = new Set(opts); render(search ? search.value : ''); recompute();
      });
      root.querySelector('[data-none]').addEventListener('click', ()=>{
        sel[key].clear(); render(search ? search.value : ''); recompute();
      });
      if (search){
        search.addEventListener('input', e => render(e.target.value));
      }
      if (key === 'hour'){
        root.querySelector('[data-business]').addEventListener('click', ()=>{
          sel.hour = new Set(opts.filter(h=>h>=7 && h<=19)); render(); recompute();
        });
        root.querySelector('[data-night]').addEventListener('click', ()=>{
          sel.hour = new Set(opts.filter(h=>h<7 || h>19)); render(); recompute();
        });
      }
      render();
    }

    buildFilter('f-account', 'account', accountOpts, v => {
      const showName = window.BC_showNames && accountMap[v];
      return showName ? `${v} — ${accountMap[v]}` : String(v);
    });
    buildFilter('f-urgency', 'urgency', urgencyOpts, v => v);
    buildFilter('f-status',  'status',  statusOpts,  v => v);
    buildFilter('f-hour',    'hour',    hourOpts,    v => String(v).padStart(2,'0')+':00');

    function aggregate(rows){
      const bySvc = {};
      let n=0, total=0, drv=0;
      for (const r of rows){
        if (!sel.account.has(r.account_no)) continue;
        if (!sel.urgency.has(r.urgency)) continue;
        if (!sel.status.has(r.status)) continue;
        if (!sel.hour.has(r.hour)) continue;
        const svc = r.service || '(blank)';
        if (!bySvc[svc]) bySvc[svc] = {jobs:0, total:0, driver:0};
        bySvc[svc].jobs += 1;
        bySvc[svc].total += r.total||0;
        bySvc[svc].driver += r.driver_total||0;
        n += 1; total += r.total||0; drv += r.driver_total||0;
      }
      return {bySvc, totals:{jobs:n, total, driver:drv}};
    }

    function renderPivot(elId, agg){
      const services = Object.keys(agg.bySvc).sort((a,b)=>agg.bySvc[b].jobs - agg.bySvc[a].jobs);
      let html = `<thead><tr>
        <th>Service</th><th>Jobs</th><th>Σ Total Price</th>
        <th>Σ Driver Total</th><th>Avg / job</th>
      </tr></thead><tbody>`;
      services.forEach(s=>{
        const v = agg.bySvc[s];
        html += `<tr>
          <td>${s}</td>
          <td class="num">${fmtInt(v.jobs)}</td>
          <td class="num">${fmtMoney(v.total)}</td>
          <td class="num">${fmtMoney(v.driver)}</td>
          <td class="num muted">${fmtMoney(v.jobs?v.total/v.jobs:0)}</td>
        </tr>`;
      });
      const t = agg.totals;
      html += `<tr style="font-weight:700">
        <td>Total</td>
        <td class="num">${fmtInt(t.jobs)}</td>
        <td class="num">${fmtMoney(t.total)}</td>
        <td class="num">${fmtMoney(t.driver)}</td>
        <td class="num">${fmtMoney(t.jobs?t.total/t.jobs:0)}</td>
      </tr></tbody>`;
      document.getElementById(elId).innerHTML = html;
      return t;
    }

    function recompute(){
      const aCur  = aggregate(J.current);
      const aPrev = aggregate(J.previous);
      const tCur  = renderPivot('pivotCur',  aCur);
      const tPrev = renderPivot('pivotPrev', aPrev);

      const pct = (a,b)=> b? ((a-b)/b)*100 : 0;
      function chip(label, c, p, fmt){
        const d = c-p;
        const cls = Math.abs(d) < 0.005 ? 'muted' : (d>=0?'pos':'neg');
        const sign = d>=0?'+':'';
        return `<span class="chip">${label}: <strong>${fmt(c)}</strong> vs <strong>${fmt(p)}</strong> <span class="${cls}">${sign}${fmt(d)} (${sign}${pct(c,p).toFixed(1)}%)</span></span>`;
      }
      document.getElementById('pivotSummary').innerHTML =
        chip('Jobs', tCur.jobs, tPrev.jobs, fmtInt) +
        chip('Σ Total', tCur.total, tPrev.total, fmtMoney) +
        chip('Σ Driver Total', tCur.driver, tPrev.driver, fmtMoney);
    }

    recompute();
  }

  // ---------- OPERATIONAL KPIs ----------
  const K = window.__KPIS__;
  if (K){
    const kCur = K.current, kPrev = K.previous;
    const opsGrid = document.getElementById('opsKpis');

    function fmt1(v){ return (v||0).toFixed(1); }
    function fmt2(v){ return (v||0).toFixed(2); }
    function fmtPctV(v){ return fmt1(v) + '%'; }
    function fmtMin(v){ return fmt1(v) + ' min'; }

    const defs = [
      ['#1  Total login hours',           d=>d.total_login_hours,        fmtInt, 'higher'],
      ['#2  Login h / car / day',         d=>d.login_h_per_car_per_day,  fmt2,   'higher'],
      ['#3  Unique active vehicles',      d=>d.unique_active_vehicles,   fmtInt, 'higher'],
      ['#4  Fleet utilisation %',         d=>d.fleet_utilisation_pct,    fmtPctV, 'higher'],
      ['#5  Jobs per online hour',        d=>d.jobs_per_online_hour,     fmt2,   'higher'],
      ['#6  Cancelled rides (all)',       d=>d.cancelled_jobs,            fmtInt, 'lower'],
      ['#7  Avg time to pickup (ASAP)',   d=>d.avg_time_to_pickup_min,   fmtMin, 'lower'],
      ['#8  Fulfilment rate',             d=>d.fulfilment_rate_pct,      fmtPctV, 'higher'],
      ['#9  Request→paid conversion',     d=>d.request_to_paid_pct,      fmtPctV, 'higher'],
      ['#10 Total commission (RON)',      d=>d.gross_commission,         fmtMoney, 'higher'],
    ];

    defs.forEach(([label, get, fmt, semantics])=>{
      const c = get(kCur), p = get(kPrev);
      const delta = p? ((c-p)/p)*100 : 0;
      let cls;
      if (Math.abs(delta) < 0.05) cls = 'flat';
      else if (semantics === 'lower') cls = delta <= 0 ? 'up' : 'down';
      else                            cls = delta >= 0 ? 'up' : 'down';
      const arrow = cls==='up'?'▲':cls==='down'?'▼':'■';
      opsGrid.insertAdjacentHTML('beforeend', `
        <div class="card kpi">
          <div class="label">${label}</div>
          <div class="value num">${fmt(c)}</div>
          <div class="prev num">prev ${fmt(p)}</div>
          <span class="delta ${cls}">${arrow} ${fmtPct(delta)}</span>
        </div>`);
    });
  }

  // ---------- FLEETS TAB (Bucharest BlackCab + Select) ----------
  // Two calls in parallel — one per period — then render side-by-side cards
  // with KPI rows comparing the same fleet's current vs previous values.
  (async function renderFleets(){
    const host = document.getElementById('fleetCards');
    if (!host) return;
    function fmtRange(p){ return p ? `${p.period_from} → ${p.period_to}` : '—'; }
    const curRange  = { from: cur.period_from,  to: cur.period_to  };
    const prevRange = { from: prev.period_from, to: prev.period_to };
    let curBundle, prevBundle;
    try {
      const [a, b] = await Promise.all([
        fetch(`/api/fleet-bundle?from=${curRange.from}&to=${curRange.to}`,   { credentials:'same-origin' }),
        fetch(`/api/fleet-bundle?from=${prevRange.from}&to=${prevRange.to}`, { credentials:'same-origin' }),
      ]);
      if (!a.ok) throw new Error('current ' + a.status);
      if (!b.ok) throw new Error('previous ' + b.status);
      curBundle  = await a.json();
      prevBundle = await b.json();
    } catch (e) {
      host.innerHTML = `<div class="card empty-state">Could not load fleet data: ${e.message}</div>`;
      return;
    }
    const fleets = Object.keys(curBundle.fleets);
    if (!fleets.length){
      document.getElementById('fleetEmpty').style.display = '';
      return;
    }
    function fmtNum(v){ return v == null ? '—' : Number(v).toLocaleString('en-US'); }
    function fmtRon(v){ return v == null ? '—' : Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
    function deltaCell(c, p, fmt){
      if (p == null && c == null) return '<td class="num muted">—</td>';
      const diff = (c || 0) - (p || 0);
      const pct  = p ? (diff / p) * 100 : 0;
      const cls  = Math.abs(diff) < 0.005 ? 'muted' : (diff >= 0 ? 'pos' : 'neg');
      const arrow = diff >= 0 ? '▲' : '▼';
      return `<td class="num ${cls}">${arrow} ${(diff>=0?'+':'')}${pct.toFixed(1)}%</td>`;
    }
    function rideRatio(hours, jobs){
      if (!jobs) return null;
      return hours / jobs;
    }
    host.innerHTML = '';
    function proxyTooltip(c){
      if (c.proxy_services) return `Proxy: distinct vehicle plates with service ∈ {${c.proxy_services.join(', ')}}`;
      if (c.proxy_cities && c.proxy_cities.length){
        const sample = c.proxy_cities.slice(0, 6).join(', ');
        const more = c.proxy_cities.length > 6 ? ` +${c.proxy_cities.length - 6} more` : '';
        return `Proxy: distinct vehicle plates with pick-up city ∈ {${sample}${more}}`;
      }
      if (c.proxy_city) return `Proxy: distinct vehicle plates with pick-up city LIKE "${c.proxy_city}"`;
      return 'Proxy count';
    }
    function fmtMin(v){ return v == null ? '—' : `${Number(v).toFixed(1)} min`; }
    function fmtPct1(v){ return v == null ? '—' : `${(Number(v)*100).toFixed(1)}%`; }
    function fmtFloat(v, d=2){ return v == null ? '—' : Number(v).toFixed(d); }
    // jobs / unique_vehicles / days in the period
    const periodDays = (() => {
      const f = cur.period_from, t = cur.period_to;
      if (!f || !t) return 0;
      return Math.max(1, Math.round((new Date(t+'T12:00:00Z') - new Date(f+'T12:00:00Z'))/86400000) + 1);
    })();
    const prevPeriodDays = (() => {
      const f = prev.period_from, t = prev.period_to;
      if (!f || !t) return periodDays;
      return Math.max(1, Math.round((new Date(t+'T12:00:00Z') - new Date(f+'T12:00:00Z'))/86400000) + 1);
    })();
    function ridesPerVehiclePerDay(jobs, veh, days){
      if (!veh || !days) return null;
      return jobs / veh / days;
    }
    // Render one "Avg response — …" row for ASAP or Prebook.
    function rtRow(label, cur, prev){
      const cAvg = cur?.avg_min, pAvg = prev?.avg_min;
      const cN   = cur?.n ?? 0,  pN   = prev?.n ?? 0;
      const sub = (cN || pN) ? `<span class="muted">(${cN.toLocaleString()} / ${pN.toLocaleString()} done)</span>` : '';
      const kind = label.includes('ASAP') ? 'ASAP' : 'PREBOOK';
      const tip = `Lower is better — avg on_way_time (driver-acceptance → pickup arrival) for ${kind} jobs in this fleet`;
      return `<tr>
        <td>${label} <span class="muted" title="${tip}">${sub}</span></td>
        <td class="num">${fmtMin(cAvg)}</td>
        <td class="num muted">${fmtMin(pAvg)}</td>
        ${deltaCellSwapped(cAvg, pAvg)}
      </tr>`;
    }
    // Same shape as deltaCell but green when DOWN (faster = better).
    function deltaCellSwapped(c, p){
      if (p == null && c == null) return '<td class="num muted">—</td>';
      const diff = (c || 0) - (p || 0);
      const pct  = p ? (diff / p) * 100 : 0;
      const cls  = Math.abs(diff) < 0.005 ? 'muted' : (diff <= 0 ? 'pos' : 'neg');
      const arrow = diff <= 0 ? '▼' : '▲';
      return `<td class="num ${cls}">${arrow} ${(diff>=0?'+':'')}${pct.toFixed(1)}%</td>`;
    }
    // Build a single .card.kpi tile in the same shape as the Overview tab's
    // KPIs: label, current value, "prev …", coloured delta arrow.
    function fleetKpiCard(label, cv, pv, fmt, lowerBetter=false){
      let cls;
      if (cv == null || pv == null || pv === 0){
        cls = 'flat';
      } else {
        const delta = ((cv - pv) / pv) * 100;
        if (Math.abs(delta) < 0.05)   cls = 'flat';
        else if (lowerBetter)         cls = delta <= 0 ? 'up' : 'down';
        else                          cls = delta >= 0 ? 'up' : 'down';
      }
      const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '■';
      const deltaTxt = (cv == null || pv == null || pv === 0)
        ? '—'
        : `${(((cv - pv) / pv) * 100) >= 0 ? '+' : ''}${(((cv - pv) / pv) * 100).toFixed(1)}%`;
      return `<div class="card kpi">
        <div class="label">${label}</div>
        <div class="value num">${fmt(cv)}</div>
        <div class="prev num">prev ${fmt(pv)}</div>
        <span class="delta ${cls}">${arrow} ${deltaTxt}</span>
      </div>`;
    }

    for (const name of fleets){
      const c = curBundle.fleets[name]  || {};
      const p = prevBundle.fleets[name] || {};
      const cHpr = c.hours_per_ride ?? rideRatio(c.hours, c.jobs);
      const pHpr = p.hours_per_ride ?? rideRatio(p.hours, p.jobs);

      // TOTAL fleet → render as a grid of KPI tiles (Overview style),
      // spanning both columns of the .grid.panels container.
      if (c.is_total){
        const avgPriceCur  = c.jobs > 0 ? c.sales / c.jobs : null;
        const avgPricePrev = p.jobs > 0 ? p.sales / p.jobs : null;
        const hpvCur  = c.unique_vehicles ? c.hours / c.unique_vehicles : null;
        const hpvPrev = p.unique_vehicles ? p.hours / p.unique_vehicles : null;
        const fmt2 = v => v == null ? '—' : Number(v).toFixed(2);

        const tiles = [
          fleetKpiCard('Service rides',      c.jobs, p.jobs, fmtNum),
          fleetKpiCard('Sales (RON)',        c.sales, p.sales, fmtRon),
          fleetKpiCard('Earnings (RON)',     c.earnings, p.earnings, fmtRon),
          fleetKpiCard('Avg price / ride',   avgPriceCur, avgPricePrev, fmtRon),
          fleetKpiCard('Unique vehicles',    c.unique_vehicles, p.unique_vehicles, fmtNum),
          fleetKpiCard('Online hours',       c.hours, p.hours, fmtNum),
          fleetKpiCard('Hours / vehicle',    hpvCur, hpvPrev, fmt2),
          fleetKpiCard('Hours / ride',       cHpr,   pHpr,   fmt2),
          fleetKpiCard('ASAP on-way (min)',
                       c.response_time?.asap?.avg_min,
                       p.response_time?.asap?.avg_min, fmtMin, /*lowerBetter*/ true),
          fleetKpiCard('Prebook on-way (min)',
                       c.response_time?.prebook?.avg_min,
                       p.response_time?.prebook?.avg_min, fmtMin, true),
          fleetKpiCard('Cancellation rate',  c.cancellation_rate, p.cancellation_rate, fmtPct1, true),
        ].join('');

        host.insertAdjacentHTML('beforeend', `
          <div class="fleet-total-section" style="grid-column: 1 / -1; margin-top:8px">
            <div class="row-head">
              <div><strong>${name}</strong>
                <span class="pill">${fmtRange(cur)}</span>
                <span class="pill" style="background:transparent">vs ${fmtRange(prev)}</span>
                <span class="pill" style="background:var(--accent);color:#0b1020">TOTAL</span>
              </div>
            </div>
            <div class="grid kpis">${tiles}</div>
          </div>`);
        continue;
      }

      const cardClass = 'card';
      host.insertAdjacentHTML('beforeend', `
        <div class="${cardClass}">
          <div class="row-head">
            <div><strong>${name}</strong>
              <span class="pill">${fmtRange(cur)}</span>
              <span class="pill" style="background:transparent">vs ${fmtRange(prev)}</span>
              ${c.is_total ? '<span class="pill" style="background:var(--accent);color:#0b1020">TOTAL</span>' : ''}
            </div>
          </div>
          <table>
            <thead><tr>
              <th>Metric</th><th>Current</th><th>Previous</th><th>Δ %</th>
            </tr></thead>
            <tbody>
              <tr class="group-head"><td colspan="4">Capacity</td></tr>
              <tr><td>Online hours</td>
                  <td class="num">${fmtNum(c.hours)}</td>
                  <td class="num muted">${fmtNum(p.hours)}</td>
                  ${deltaCell(c.hours, p.hours, fmtNum)}</tr>
              <tr><td>Hours / vehicle</td>
                  <td class="num">${fmtFloat(c.unique_vehicles ? c.hours/c.unique_vehicles : null)}</td>
                  <td class="num muted">${fmtFloat(p.unique_vehicles ? p.hours/p.unique_vehicles : null)}</td>
                  ${deltaCell(
                    c.unique_vehicles ? c.hours/c.unique_vehicles : null,
                    p.unique_vehicles ? p.hours/p.unique_vehicles : null,
                    v => v.toFixed(2))}</tr>
              <tr><td>Hours / ride</td>
                  <td class="num">${cHpr == null ? '—' : cHpr.toFixed(2)}</td>
                  <td class="num muted">${pHpr == null ? '—' : pHpr.toFixed(2)}</td>
                  ${deltaCell(cHpr, pHpr, v => v.toFixed(2))}</tr>

              <tr class="group-head"><td colspan="4">Volume &amp; Revenue</td></tr>
              <tr><td>Service rides
                      <span class="muted" title="Mașinile din flota BlackCab deservesc și serviciul Select, nu și vice versa.">(?)</span></td>
                  <td class="num"><strong>${fmtNum(c.jobs)}</strong></td>
                  <td class="num muted">${fmtNum(p.jobs)}</td>
                  ${deltaCell(c.jobs, p.jobs, fmtNum)}</tr>
              ${(c.cross_fleet_vehicles || p.cross_fleet_vehicles) ? `
              <tr><td>Cross-fleet rides
                      <span class="muted" title="DONE rides those fleet vehicles did on OTHER services (or — for the city-based total card — outside the city list).">(?)</span></td>
                  <td class="num">${fmtNum(c.cross_fleet_rides)}
                      <span class="muted" style="font-size:11px"> (${fmtNum(c.cross_fleet_vehicles)} vehicles)</span></td>
                  <td class="num muted">${fmtNum(p.cross_fleet_rides)}
                      <span style="font-size:11px"> (${fmtNum(p.cross_fleet_vehicles)})</span></td>
                  ${deltaCell(c.cross_fleet_rides, p.cross_fleet_rides, fmtNum)}</tr>
              ` : ''}
              <tr><td>Sales (RON)</td>
                  <td class="num">${fmtRon(c.sales)}</td>
                  <td class="num muted">${fmtRon(p.sales)}</td>
                  ${deltaCell(c.sales, p.sales, fmtRon)}</tr>
              <tr><td>Earnings (RON)</td>
                  <td class="num">${fmtRon(c.earnings)}</td>
                  <td class="num muted">${fmtRon(p.earnings)}</td>
                  ${deltaCell(c.earnings, p.earnings, fmtRon)}</tr>
              <tr><td>Avg price / ride (RON)</td>
                  <td class="num">${c.jobs > 0 ? fmtRon(c.sales / c.jobs) : '—'}</td>
                  <td class="num muted">${p.jobs > 0 ? fmtRon(p.sales / p.jobs) : '—'}</td>
                  ${deltaCell(
                    c.jobs > 0 ? c.sales / c.jobs : null,
                    p.jobs > 0 ? p.sales / p.jobs : null,
                    fmtRon)}</tr>

              <tr class="group-head"><td colspan="4">Service quality</td></tr>
              ${rtRow('Avg on-way time — ASAP',
                       c.response_time?.asap,    p.response_time?.asap)}
              ${rtRow('Avg on-way time — Prebook',
                       c.response_time?.prebook, p.response_time?.prebook)}
              <tr><td>Cancellation rate
                      <span class="muted" title="CANCELLED / total bookings (every reservation in the period, regardless of status)">(?)</span></td>
                  <td class="num"><strong>${fmtPct1(c.cancellation_rate)}</strong></td>
                  <td class="num muted">${fmtPct1(p.cancellation_rate)}</td>
                  ${deltaCellSwapped(c.cancellation_rate, p.cancellation_rate)}</tr>
            </tbody>
          </table>
        </div>`);
    }
  })();
};
