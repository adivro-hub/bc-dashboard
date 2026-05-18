"""Parse every Excel report in <folder>, anonymise it, and bulk-insert into
the Supabase Postgres tables (via the connection pooler).

This bypasses the browser entirely — useful for the initial bulk load.

Usage:
  python db/push_all.py <folder>
Env:
  BC_DB_HOST, BC_DB_PORT, BC_DB_USER, BC_DB_PASSWORD, [BC_UPLOADER]
"""
import sys, os, ssl, json, hashlib, re
from pathlib import Path
from datetime import datetime, date

import pg8000
import pandas as pd

FOLDER = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\Adrian\Desktop\dashboard\new reports")
UPLOADER = os.environ.get("BC_UPLOADER", "adivro1985@gmail.com")

ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
conn = pg8000.connect(
    user=os.environ['BC_DB_USER'], password=os.environ['BC_DB_PASSWORD'],
    host=os.environ['BC_DB_HOST'], port=int(os.environ.get('BC_DB_PORT', '5432')),
    database='postgres', ssl_context=ctx)
conn.autocommit = True
cur = conn.cursor()

# Use pg8000's adapter so dicts go to jsonb cleanly
def jsondumps(v): return json.dumps(v, default=str, ensure_ascii=False)
def sha256(b): return hashlib.sha256(b).hexdigest()
def sha256_str(s): return hashlib.sha256(s.encode('utf-8')).hexdigest()
def iso(d):
    if d is None: return None
    if isinstance(d, str): return d
    if isinstance(d, (datetime, date)): return d.strftime('%Y-%m-%d')
    return str(d)

def to_num(v):
    if v is None or pd.isna(v): return 0
    try: return float(v)
    except: return 0
def to_str(v):
    if v is None or (isinstance(v, float) and pd.isna(v)): return ""
    return str(v).strip()
def to_int_or_none(v):
    if v is None or (isinstance(v, float) and pd.isna(v)): return None
    try: n = int(float(v))
    except: return None
    return n

# ---------- file-type detection ----------
def detect(path: Path):
    name = path.name
    suffix = path.suffix.lower()
    try:
        if suffix == '.xlsx':
            xl = pd.ExcelFile(path, engine='openpyxl')
            if "Average" in xl.sheet_names: return 'hours'
        else:
            xl = pd.ExcelFile(path, engine='xlrd')
    except Exception:
        return 'unknown'
    df = pd.read_excel(path, sheet_name=xl.sheet_names[0], engine='openpyxl' if suffix=='.xlsx' else 'xlrd', header=None, nrows=4)
    r0 = [to_str(c) for c in df.iloc[0].tolist()] if len(df) else []
    if r0 and 'Miiles Report' in r0[0]: return 'income'
    if 'Email' in r0 and 'Created At' in r0: return 'registrations'
    if r0 and r0[0].startswith('From:'):
        for probe in (2, 3):
            if len(df) > probe:
                r = [to_str(c) for c in df.iloc[probe].tolist()]
                if 'Account Number' in r and 'Job Number' in r: return 'jobs'
    return 'unknown'

# ---------- Income ----------
INCOME_SECTION_HEADERS = {
    "Sales": "sales",
    "Sales By Payment Type": "payment_type",
    "Sales by Customer Grade": "customer_grade",
    "Sales by Service": "service",
    "Sales by Fleet": "fleet",
    "Driver Login Time by Fleet (hours)": "driver_hours",
}
def parse_income(path):
    df = pd.read_excel(path, sheet_name=0, engine='xlrd', header=None)
    period_from = period_to = None
    for i in range(min(10, len(df))):
        for j in range(min(6, df.shape[1] - 1)):
            tag = to_str(df.iloc[i, j])
            if tag == 'From:': period_from = iso(pd.to_datetime(df.iloc[i, j+1], errors='coerce').to_pydatetime() if pd.notna(df.iloc[i, j+1]) else None)
            if tag == 'To:':   period_to   = iso(pd.to_datetime(df.iloc[i, j+1], errors='coerce').to_pydatetime() if pd.notna(df.iloc[i, j+1]) else None)
    sections = {k: {} for k in INCOME_SECTION_HEADERS.values()}
    current = None
    for i in range(len(df)):
        label = to_str(df.iloc[i, 0])
        if not label: continue
        if label in INCOME_SECTION_HEADERS:
            current = INCOME_SECTION_HEADERS[label]; continue
        if current is None: continue
        if label.lower().startswith('total'): continue
        sections[current][label] = {
            'jobs':        to_num(df.iloc[i, 1]),
            'without_vat': to_num(df.iloc[i, 2]),
            'vat':         to_num(df.iloc[i, 3]),
            'total':       to_num(df.iloc[i, 4]),
            'earnings':    to_num(df.iloc[i, 5]),
        }
    wv = sections['sales'].get('Sales with VAT')   or {'jobs':0,'without_vat':0,'vat':0,'total':0,'earnings':0}
    nv = sections['sales'].get('Sales with No VAT') or {'jobs':0,'without_vat':0,'vat':0,'total':0,'earnings':0}
    kpis = {
        'jobs': wv['jobs']+nv['jobs'],
        'without_vat': wv['without_vat']+nv['without_vat'],
        'vat': wv['vat']+nv['vat'],
        'total': wv['total']+nv['total'],
        'earnings': wv['earnings']+nv['earnings'],
        'avg_per_job': (wv['total']+nv['total'])/(wv['jobs']+nv['jobs']) if (wv['jobs']+nv['jobs']) else 0,
    }
    return {'period_from': period_from, 'period_to': period_to, 'sections': sections, 'kpis': kpis}

# ---------- Hours ----------
HOURS_METRIC_KEY = {
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
}
HOURLY_RE = re.compile(r'^(\d{2}/\d{2}/\d{2}) (\d{2}):00$')

def parse_hours(path):
    df = pd.read_excel(path, sheet_name='Average', engine='openpyxl', header=None)
    headers = [to_str(c) for c in df.iloc[0].tolist()]
    hourly_cols = []
    for i, h in enumerate(headers):
        m = HOURLY_RE.match(h)
        if m:
            d = datetime.strptime(m.group(1), '%d/%m/%y')
            ts = d.replace(hour=int(m.group(2)))
            hourly_cols.append((i, ts))
    label_to_row = {}
    for r in range(1, len(df)):
        lbl = to_str(df.iloc[r, 0])
        if lbl: label_to_row[lbl] = r
    series = {key: [] for key in HOURS_METRIC_KEY.values()}
    for nice, key in HOURS_METRIC_KEY.items():
        ri = label_to_row.get(nice)
        if ri is None: series[key] = [0]*len(hourly_cols)
        else: series[key] = [to_num(df.iloc[ri, ci]) for ci, _ in hourly_cols]
    period = headers[0] if headers else ''
    timestamps = [ts.strftime('%Y-%m-%dT%H:00') for _, ts in hourly_cols]
    period_start = timestamps[0][:10] if timestamps else None
    period_end   = timestamps[-1][:10] if timestamps else None
    return {'period': period, 'period_start': period_start, 'period_end': period_end,
            'timestamps': timestamps, 'hourly': series}

# ---------- Job Analogue ----------
SUPPLY_RE = re.compile(r'no cars available|serviciul .*indisponibil|nicio ma[sș]in[aă]|nu vrea sa astepte|sofer de la bv', re.IGNORECASE)
OTP_RE = re.compile(r'OTP/LROP|OTOPENI\s*Airport', re.IGNORECASE)
def hour_of(v):
    if v is None or (isinstance(v, float) and pd.isna(v)): return None
    if hasattr(v, 'hour'): return v.hour
    try: return pd.to_datetime(v).hour
    except: return None
def time_to_min(v):
    if v is None or (isinstance(v, float) and pd.isna(v)): return None
    if hasattr(v, 'hour'): return v.hour*60 + v.minute + v.second/60
    s = str(v).strip().split('.')[0]
    parts = s.split(':')
    try:
        if len(parts) == 3: return int(parts[0])*60 + int(parts[1]) + int(parts[2])/60
        if len(parts) == 2: return int(parts[0])*60 + int(parts[1])
    except: return None
def normalise_phone(v):
    if v is None or (isinstance(v, float) and pd.isna(v)): return ""
    s = str(v).strip()
    digits = re.sub(r'\D', '', s)
    if not digits or set(digits) == {'0'}: return ""
    return digits

def parse_jobs(path):
    df = pd.read_excel(path, sheet_name=0, engine='xlrd', header=0, skiprows=3)
    df.columns = [to_str(c) for c in df.columns]
    cols = {c: df.columns.get_loc(c) if c in df.columns else None for c in
            ['Account Number','Account Name','Job Number','Urgency','Status','Service',
             'Job Date','Job Time','Pick Up','Drop Off','Vehicle Reg Number','Cancel Reason',
             'Response Time','Passenger Telephone','Total Price','Driver Total Price']}
    rows = []
    name_map = {}
    for _, r in df.iterrows():
        acc = r.get('Account Number')
        jn  = r.get('Job Number')
        if pd.isna(acc) and pd.isna(jn): continue
        acc_int = to_int_or_none(acc)
        acc_name = to_str(r.get('Account Name'))
        if acc_int is not None and acc_name and acc_int not in name_map:
            name_map[acc_int] = acc_name
        jd = pd.to_datetime(r.get('Job Date'), errors='coerce')
        rows.append({
            'date':        iso(jd.to_pydatetime()) if pd.notna(jd) else None,
            'account_no':  acc_int,
            'phone_hash':  sha256_str(normalise_phone(r.get('Passenger Telephone'))) if normalise_phone(r.get('Passenger Telephone')) else None,
            'urgency':     to_str(r.get('Urgency')) or None,
            'status':      to_str(r.get('Status')) or None,
            'service':     to_str(r.get('Service')) or None,
            'hour':        hour_of(r.get('Job Time')),
            'total':       to_num(r.get('Total Price')),
            'driver_total':to_num(r.get('Driver Total Price')),
            'response_min':time_to_min(r.get('Response Time')),
            'vehicle_hash':sha256_str(to_str(r.get('Vehicle Reg Number'))) if to_str(r.get('Vehicle Reg Number')) else None,
            'is_otp_pickup':  bool(OTP_RE.search(to_str(r.get('Pick Up')))),
            'is_otp_dropoff': bool(OTP_RE.search(to_str(r.get('Drop Off')))),
            'is_no_supply_cancel': bool(SUPPLY_RE.search(to_str(r.get('Cancel Reason')))),
        })
    return rows, name_map

# ---------- Registrations ----------
def parse_regs(path):
    df = pd.read_excel(path, sheet_name=0, engine='xlrd', header=0)
    df.columns = [to_str(c) for c in df.columns]
    out = []
    for _, r in df.iterrows():
        ts = pd.to_datetime(r.get('Created At'), errors='coerce')
        if pd.isna(ts): continue
        email = to_str(r.get('Email'))
        out.append({
            'created_at': ts.to_pydatetime(),
            'status':     to_str(r.get('Status')) or None,
            'email_hash': sha256_str(email.lower()) if email else None,
        })
    return out

# ============================================================
# Run!
# ============================================================
def file_seen(table, file_hash):
    cur.execute(f"SELECT id FROM public.{table} WHERE file_hash = %s", (file_hash,))
    row = cur.fetchone()
    print(f"    file_seen({table}, {file_hash[:8]}) -> {row!r}")
    return row[0] if row else None

paths = sorted(FOLDER.iterdir())
print(f"Scanning {len(paths)} entries in {FOLDER}…")

pushed = {'income':0, 'hours':0, 'jobs':0, 'regs':0, 'skipped':0, 'unknown':0}
job_row_count = 0
reg_row_count = 0
account_names = {}

for p in paths:
    if p.is_dir(): continue
    if p.suffix.lower() not in ('.xls', '.xlsx'): continue
    kind = detect(p)
    bytes_ = p.read_bytes()
    h = sha256(bytes_)

    if kind == 'income':
        if file_seen('income_files', h): pushed['skipped'] += 1; continue
        try: parsed = parse_income(p)
        except Exception as e: print(f"  parse error {p.name}: {e}"); continue
        cur.execute("INSERT INTO public.income_files (file_hash, source_name, period_from, period_to, sections, kpis, uploaded_by) "
                    "VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)",
                    (h, p.name, parsed['period_from'], parsed['period_to'],
                     jsondumps(parsed['sections']), jsondumps(parsed['kpis']), UPLOADER))
        pushed['income'] += 1
        print(f"  income   {p.name}  ({parsed['period_from']} -> {parsed['period_to']})")

    elif kind == 'hours':
        if file_seen('hours_files', h): pushed['skipped'] += 1; continue
        try: parsed = parse_hours(p)
        except Exception as e: print(f"  parse error {p.name}: {e}"); continue
        cur.execute("INSERT INTO public.hours_files (file_hash, source_name, period, period_start, period_end, timestamps, hourly, uploaded_by) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)",
                    (h, p.name, parsed['period'], parsed['period_start'], parsed['period_end'],
                     parsed['timestamps'], jsondumps(parsed['hourly']), UPLOADER))
        pushed['hours'] += 1
        print(f"  hours    {p.name}  ({parsed['period_start']} -> {parsed['period_end']})")

    elif kind == 'jobs':
        if file_seen('job_files', h): pushed['skipped'] += 1; continue
        try: rows, name_map = parse_jobs(p)
        except Exception as e: print(f"  parse error {p.name}: {e}"); continue
        dates = [r['date'] for r in rows if r['date']]
        if not dates: continue
        ps, pe = min(dates), max(dates)
        cur.execute("INSERT INTO public.job_files (file_hash, source_name, period_start, period_end, row_count, uploaded_by) "
                    "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                    (h, p.name, ps, pe, len(rows), UPLOADER))
        file_id = cur.fetchone()[0]
        # Bulk insert via executemany
        params = [(file_id, r['date'], r['account_no'], r['phone_hash'], r['urgency'],
                   r['status'], r['service'], r['hour'], r['total'], r['driver_total'],
                   r['response_min'], r['vehicle_hash'], r['is_otp_pickup'],
                   r['is_otp_dropoff'], r['is_no_supply_cancel']) for r in rows]
        CHUNK = 500
        for i in range(0, len(params), CHUNK):
            slice_ = params[i:i+CHUNK]
            cur.executemany("INSERT INTO public.job_rows (file_id, date, account_no, phone_hash, urgency, status, service, hour, total, driver_total, response_min, vehicle_hash, is_otp_pickup, is_otp_dropoff, is_no_supply_cancel) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", slice_)
        pushed['jobs'] += 1; job_row_count += len(rows)
        for k, v in name_map.items(): account_names.setdefault(k, v)
        print(f"  jobs     {p.name}  {len(rows):>6,} rows  ({ps} -> {pe})")

    elif kind == 'registrations':
        if file_seen('reg_files', h): pushed['skipped'] += 1; continue
        try: rows = parse_regs(p)
        except Exception as e: print(f"  parse error {p.name}: {e}"); continue
        cur.execute("INSERT INTO public.reg_files (file_hash, source_name, uploaded_by) VALUES (%s, %s, %s) RETURNING id",
                    (h, p.name, UPLOADER))
        file_id = cur.fetchone()[0]
        params = [(file_id, r['created_at'], r['status'], r['email_hash']) for r in rows]
        CHUNK = 500
        for i in range(0, len(params), CHUNK):
            cur.executemany("INSERT INTO public.reg_rows (file_id, created_at, status, email_hash) VALUES (%s,%s,%s,%s)",
                            params[i:i+CHUNK])
        pushed['regs'] += 1; reg_row_count += len(rows)
        print(f"  regs     {p.name}  {len(rows):>6,} rows")
    else:
        pushed['unknown'] += 1
        print(f"  ???      {p.name}  (unknown type)")

# Upsert account names
if account_names:
    name_params = [(int(k), v) for k, v in account_names.items()]
    CHUNK = 500
    for i in range(0, len(name_params), CHUNK):
        slice_ = name_params[i:i+CHUNK]
        cur.executemany("INSERT INTO public.account_names (account_no, name) VALUES (%s, %s) "
                        "ON CONFLICT (account_no) DO UPDATE SET name = EXCLUDED.name, updated_at = now()",
                        slice_)
    print(f"\n  account names upserted: {len(name_params)}")

print(f"\n--- summary ---")
for k, v in pushed.items(): print(f"  {k:10s} {v}")
print(f"  job rows  {job_row_count:,}")
print(f"  reg rows  {reg_row_count:,}")

cur.close(); conn.close()
