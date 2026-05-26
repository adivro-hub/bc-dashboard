/* test_api.js — smoke-test the API handlers against Neon directly.
 *
 * Usage:
 *   DATABASE_URL='postgresql://...' node test_api.js
 *
 * Imports each handler and invokes it with a mock req/res. Prints a short
 * summary of each response so we can see the queries actually work.
 */
import { pool } from './api/_db.js';
import coverage     from './api/coverage.js';
import kpis         from './api/kpis.js';
import jobs         from './api/jobs.js';
import registrations from './api/registrations.js';
import topClients   from './api/top-clients.js';

function mockRes() {
  const r = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
    json() { return JSON.parse(this.body); },
  };
  return r;
}

function mockReq(path) {
  const headers = { host: 'localhost' };
  if (process.env.API_TOKEN) {
    headers.authorization = `Bearer ${process.env.API_TOKEN}`;
  }
  return { method: 'GET', url: path, headers };
}

async function hit(handler, path, label) {
  const req = mockReq(path);
  const res = mockRes();
  await handler(req, res);
  const tag = res.statusCode === 200 ? 'OK ' : 'ERR';
  console.log(`\n[${tag} ${res.statusCode}] ${label}  ${path}`);
  try {
    const body = res.json();
    if (res.statusCode !== 200) {
      console.log('  ', body);
    } else {
      summarise(label, body);
    }
  } catch (e) {
    console.log('  (non-JSON body):', res.body.slice(0, 200));
  }
}

function summarise(label, body) {
  if (label === 'coverage') {
    console.log(`   jobs:          rows=${body.jobs.rows}  ${body.jobs.date_min} .. ${body.jobs.date_max}`);
    console.log(`   registrations: rows=${body.registrations.rows}  ${body.registrations.created_min} .. ${body.registrations.created_max}`);
    for (const [v, s] of Object.entries(body.income_structure)) {
      console.log(`   ${v}: ${s.error ? '(' + s.error + ')' : `rows=${s.rows} ${s.date_min}..${s.date_max}`}`);
    }
  } else if (label === 'kpis') {
    const b = body.bookings, r = body.revenue;
    console.log(`   bookings: total=${b.total} done=${b.done} cancelled=${b.cancelled} fulfilment=${b.fulfilment_rate_pct.toFixed(1)}%`);
    console.log(`   revenue:  total=${r.total_price.toFixed(2)} driver=${r.driver_price.toFixed(2)} commission=${r.gross_commission.toFixed(2)}`);
    console.log(`   pickup ASAP n=${body.pickup_time.asap_done_jobs}  avg=${(body.pickup_time.avg_min || 0).toFixed(1)}min`);
  } else if (label === 'jobs' || label === 'jobs-by-service') {
    console.log(`   group_by=${body.group_by}, rows=${body.rows.length}`);
    body.rows.slice(0, 5).forEach(r => {
      console.log(`     ${r.key}: jobs=${r.jobs} done=${r.done} total=${r.total_price.toFixed(0)}`);
    });
    if (body.rows.length > 5) console.log(`     … and ${body.rows.length - 5} more`);
  } else if (label === 'registrations') {
    console.log(`   total=${body.total}, group_by=${body.group_by}, rows=${body.rows.length}`);
    body.rows.slice(0, 5).forEach(r => console.log(`     ${r.key}: ${r.count}`));
    if (body.rows.length > 5) console.log(`     … and ${body.rows.length - 5} more`);
  } else if (label === 'top-clients') {
    console.log(`   segment=${body.segment}, total_revenue=${body.total_revenue.toFixed(0)}, returned=${body.rows.length}`);
    body.rows.slice(0, 5).forEach(r => {
      console.log(`     ${r.account_number} ${r.account_name?.slice(0,30)}: jobs=${r.jobs} earn=${r.earnings.toFixed(0)}`);
    });
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL (Neon connection string)');
    process.exit(2);
  }
  await hit(coverage, '/api/coverage', 'coverage');
  // Pick a range we know has data
  await hit(kpis, '/api/kpis?from=2026-05-01&to=2026-05-21', 'kpis');
  await hit(jobs, '/api/jobs?from=2026-05-01&to=2026-05-21&group_by=day', 'jobs');
  await hit(jobs, '/api/jobs?from=2026-05-01&to=2026-05-21&group_by=service', 'jobs-by-service');
  await hit(registrations, '/api/registrations?from=2026-05-01&to=2026-05-21&group_by=day', 'registrations');
  await hit(topClients, '/api/top-clients?from=2026-05-01&to=2026-05-21&segment=all&limit=10', 'top-clients');
  await pool().end();
}

main().catch(e => { console.error(e); process.exit(1); });
