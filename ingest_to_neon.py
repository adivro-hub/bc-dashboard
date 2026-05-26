"""
Ingest the XLS files in rapoarte/ into Neon Postgres.

Usage:
  PGURI='postgresql://...' python3 ingest_to_neon.py            # everything
  PGURI='...' python3 ingest_to_neon.py --only jobs             # jobs only
  PGURI='...' python3 ingest_to_neon.py --only registrations    # regs only
  PGURI='...' python3 ingest_to_neon.py --reset                 # drop+recreate first
  PGURI='...' python3 ingest_to_neon.py --files "Job Analogue 01.05.26*"

Idempotent: ON CONFLICT DO UPDATE for jobs (job_number PK) and (email, created_at)
for registrations, so rerunning is safe.
"""
import argparse
import os
import sys
import time
from datetime import datetime, time as dtime
from pathlib import Path

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values


ROOT = Path("/Users/adrianvasile/Downloads/bc-dashboard/rapoarte")
BATCH = 5000

# -----------------------------------------------------------------------------
# Schema
# -----------------------------------------------------------------------------

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS job_analogue (
  job_number              BIGINT PRIMARY KEY,
  account_number          BIGINT,
  account_name            TEXT,
  account_creation_date   TIMESTAMP,
  payment_type            TEXT,
  booking_creation        TIMESTAMP,
  urgency                 TEXT,
  job_date                DATE,
  job_time                TIME,
  booking_source          TEXT,
  status                  TEXT,
  cancel_reason           TEXT,
  cancelled_by            TEXT,
  passenger_id            TEXT,
  passenger_name          TEXT,
  passenger_telephone     TEXT,
  passenger_email         TEXT,
  driver_id               BIGINT,
  driver_callsign         TEXT,
  driver_name             TEXT,
  driver_phone            TEXT,
  driver_email            TEXT,
  vehicle_reg_number      TEXT,
  pick_up                 TEXT,
  drop_off                TEXT,
  pick_up_city            TEXT,
  destination_type        TEXT,
  service                 TEXT,
  tariff                  TEXT,
  job_reference           TEXT,
  on_way_time             INTERVAL,
  pob_time                INTERVAL,
  total_time              INTERVAL,
  effective_time          INTERVAL,
  waiting_time            DOUBLE PRECISION,
  actual_duration         INTERVAL,
  response_time           INTERVAL,
  driver_late_time        INTERVAL,
  client_late_time        INTERVAL,
  on_way_distance         DOUBLE PRECISION,
  pob_distance            DOUBLE PRECISION,
  total_distance          DOUBLE PRECISION,
  actual_distance         DOUBLE PRECISION,
  base_fare               DOUBLE PRECISION,
  stops                   INT,
  extras                  INT,
  subtotal_items          DOUBLE PRECISION,
  total_tax               DOUBLE PRECISION,
  tips                    DOUBLE PRECISION,
  total_price             DOUBLE PRECISION,
  driver_total_price      DOUBLE PRECISION,
  customer_rating         DOUBLE PRECISION,
  source_file             TEXT,
  ingested_at             TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_date    ON job_analogue (job_date);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON job_analogue (status);
CREATE INDEX IF NOT EXISTS idx_jobs_account ON job_analogue (account_number);
CREATE INDEX IF NOT EXISTS idx_jobs_service ON job_analogue (service);
CREATE INDEX IF NOT EXISTS idx_jobs_driver  ON job_analogue (driver_id);

CREATE TABLE IF NOT EXISTS registrations (
  email                   TEXT NOT NULL,
  created_at              TIMESTAMP NOT NULL,
  mobile_phone            TEXT,
  individual              TEXT,
  origin                  TEXT,
  policy_acceptance_date  TIMESTAMP,
  status                  TEXT,
  white_listed            TEXT,
  source_file             TEXT,
  ingested_at             TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (email, created_at)
);

CREATE INDEX IF NOT EXISTS idx_reg_created ON registrations (created_at);
CREATE INDEX IF NOT EXISTS idx_reg_status  ON registrations (status);
"""

RESET_SQL = "DROP TABLE IF EXISTS job_analogue; DROP TABLE IF EXISTS registrations;"

# -----------------------------------------------------------------------------
# Coercion helpers (xls dtypes -> postgres-friendly python values)
# -----------------------------------------------------------------------------

def _nan(v):
    if v is None:
        return True
    if isinstance(v, float) and pd.isna(v):
        return True
    if isinstance(v, pd.Timestamp) and pd.isna(v):
        return True
    return False


def to_int(v):
    if _nan(v):
        return None
    try:
        return int(v)
    except (ValueError, TypeError):
        return None


def to_float(v):
    if _nan(v):
        return None
    try:
        f = float(v)
        if pd.isna(f):
            return None
        return f
    except (ValueError, TypeError):
        return None


def to_text(v):
    if _nan(v):
        return None
    s = str(v).strip()
    return s or None


def to_ts(v):
    """Pandas Timestamp / datetime -> python datetime, or None."""
    if _nan(v):
        return None
    if isinstance(v, pd.Timestamp):
        return v.to_pydatetime()
    if isinstance(v, datetime):
        return v
    try:
        return pd.to_datetime(v).to_pydatetime()
    except Exception:
        return None


def to_date(v):
    ts = to_ts(v)
    return ts.date() if ts else None


def to_time(v):
    """Handles datetime.time, Timestamp(1970-01-01 HH:MM), or 'HH:MM:SS' strings."""
    if _nan(v):
        return None
    if isinstance(v, dtime):
        return v
    if isinstance(v, pd.Timestamp):
        return v.time()
    if isinstance(v, datetime):
        return v.time()
    try:
        return pd.to_datetime(v).time()
    except Exception:
        return None


def to_interval(v):
    """datetime.time / Timestamp -> postgres-compatible interval string HH:MM:SS.ffffff."""
    if _nan(v):
        return None
    if isinstance(v, dtime):
        t = v
    elif isinstance(v, pd.Timestamp):
        t = v.time()
    elif isinstance(v, datetime):
        t = v.time()
    else:
        try:
            t = pd.to_datetime(v).time()
        except Exception:
            return None
    micros = f".{t.microsecond:06d}" if t.microsecond else ""
    return f"{t.hour:02d}:{t.minute:02d}:{t.second:02d}{micros}"


# -----------------------------------------------------------------------------
# Job Analogue
# -----------------------------------------------------------------------------

JOB_COLS_IN_ORDER = [
    ("job_number",            "Job Number",                                            to_int),
    ("account_number",        "Account Number",                                        to_int),
    ("account_name",          "Account Name",                                          to_text),
    ("account_creation_date", "Account Creation Date",                                 to_ts),
    ("payment_type",          "Payment Type",                                          to_text),
    ("booking_creation",      "Booking Creation",                                      to_ts),
    ("urgency",               "Urgency",                                               to_text),
    ("job_date",              "Job Date",                                              to_date),
    ("job_time",              "Job Time",                                              to_time),
    ("booking_source",        "Booking Source",                                        to_text),
    ("status",                "Status",                                                to_text),
    ("cancel_reason",         "Cancel Reason",                                         to_text),
    ("cancelled_by",          "Cancelled By",                                          to_text),
    ("passenger_id",          "Passenger ID",                                          to_text),
    ("passenger_name",        "Passenger Name",                                        to_text),
    ("passenger_telephone",   "Passenger Telephone",                                   to_text),
    ("passenger_email",       "Passenger Email",                                       to_text),
    ("driver_id",             "Driver ID",                                             to_int),
    ("driver_callsign",       "Driver Callsign",                                       to_text),
    ("driver_name",           "Driver Name",                                           to_text),
    ("driver_phone",          "Driver Phone",                                          to_text),
    ("driver_email",          "Driver Email",                                          to_text),
    ("vehicle_reg_number",    "Vehicle Reg Number",                                    to_text),
    ("pick_up",               "Pick Up",                                               to_text),
    ("drop_off",              "Drop Off",                                              to_text),
    ("pick_up_city",          "Pick up City",                                          to_text),
    ("destination_type",      "Destination Type",                                      to_text),
    ("service",               "Service",                                               to_text),
    ("tariff",                "Tariff",                                                to_text),
    ("job_reference",         "Job Reference",                                         to_text),
    ("on_way_time",           "On Way Time",                                           to_interval),
    ("pob_time",              "POB Time",                                              to_interval),
    ("total_time",            "Total Time = On way time+ Waiiting time + POB Time",   to_interval),
    ("effective_time",        "Effective time= At Pickup time+ POB Time",             to_interval),
    ("waiting_time",          "Waiting Time",                                          to_float),
    ("actual_duration",       "Actual Duration",                                       to_interval),
    ("response_time",         "Response Time",                                         to_interval),
    ("driver_late_time",      "Driver Late Time",                                      to_interval),
    ("client_late_time",      "Client Late Time",                                      to_interval),
    ("on_way_distance",       "On Way Distance",                                       to_float),
    ("pob_distance",          "POB Distance",                                          to_float),
    ("total_distance",        "Total Distance= On Way Distance/ Total Distance",      to_float),
    ("actual_distance",       "Actual Distance",                                       to_float),
    ("base_fare",             "Base Fare",                                             to_float),
    ("stops",                 "Stops",                                                 to_int),
    ("extras",                "Extras",                                                to_int),
    ("subtotal_items",        "Subtotal items",                                        to_float),
    ("total_tax",             "Total Tax",                                             to_float),
    ("tips",                  "Tips",                                                  to_float),
    ("total_price",           "Total Price",                                           to_float),
    ("driver_total_price",    "Driver Total Price",                                    to_float),
    ("customer_rating",       "Customer Rating",                                       to_float),
]

JOB_DB_COLS = [c[0] for c in JOB_COLS_IN_ORDER] + ["source_file"]


def parse_job_file(path: Path):
    df = pd.read_excel(path, sheet_name="Sheet1", engine="xlrd",
                       header=0, skiprows=3)
    df.columns = [str(c).strip() for c in df.columns]

    # Drop fully empty rows
    df = df.dropna(how="all")
    # Need at least job_number to be meaningful
    if "Job Number" in df.columns:
        df = df[df["Job Number"].notna()]

    missing = [src for (_, src, _) in JOB_COLS_IN_ORDER if src not in df.columns]
    if missing:
        print(f"  WARN missing cols in {path.name}: {missing}")

    rows = []
    for _, r in df.iterrows():
        row = []
        for _, src, coerce in JOB_COLS_IN_ORDER:
            row.append(coerce(r.get(src)) if src in df.columns else None)
        row.append(path.name)
        rows.append(tuple(row))
    return rows


# -----------------------------------------------------------------------------
# Registrations
# -----------------------------------------------------------------------------

REG_COLS_IN_ORDER = [
    ("email",                  "Email",                  to_text),
    ("created_at",             "Created At",             to_ts),
    ("mobile_phone",           "Mobile Phone",           to_text),
    ("individual",             "Individual",             to_text),
    ("origin",                 "Origin",                 to_text),
    ("policy_acceptance_date", "Policy Acceptance Date", to_ts),
    ("status",                 "Status",                 to_text),
    ("white_listed",           "White listed",           to_text),
]
REG_DB_COLS = [c[0] for c in REG_COLS_IN_ORDER] + ["source_file"]


def parse_reg_file(path: Path):
    df = pd.read_excel(path, sheet_name="Export", engine="xlrd", header=0)
    df.columns = [str(c).strip() for c in df.columns]
    df = df.dropna(how="all")
    # Drop rows missing the PK
    df = df[df["Email"].notna() & df["Created At"].notna()]
    rows = []
    for _, r in df.iterrows():
        row = []
        for _, src, coerce in REG_COLS_IN_ORDER:
            row.append(coerce(r.get(src)) if src in df.columns else None)
        row.append(path.name)
        rows.append(tuple(row))
    return rows


# -----------------------------------------------------------------------------
# Bulk upsert
# -----------------------------------------------------------------------------

def _dedupe(rows, key_idx):
    """Keep the last occurrence per key (job_number for jobs;
    (email, created_at) for registrations). Postgres rejects ON CONFLICT
    DO UPDATE when the same row is targeted twice in one statement."""
    seen = {}
    if isinstance(key_idx, tuple):
        for r in rows:
            seen[tuple(r[i] for i in key_idx)] = r
    else:
        for r in rows:
            seen[r[key_idx]] = r
    return list(seen.values())


def upsert_jobs(cur, rows):
    if not rows:
        return 0, 0
    before = len(rows)
    rows = _dedupe(rows, key_idx=0)  # job_number is first col
    cols_sql = ",".join(JOB_DB_COLS)
    update_set = ",".join(
        f"{c}=EXCLUDED.{c}"
        for c in JOB_DB_COLS
        if c != "job_number"
    )
    sql = f"""
        INSERT INTO job_analogue ({cols_sql}) VALUES %s
        ON CONFLICT (job_number) DO UPDATE SET {update_set}
    """
    execute_values(cur, sql, rows, page_size=BATCH)
    return len(rows), before - len(rows)


def upsert_regs(cur, rows):
    if not rows:
        return 0, 0
    before = len(rows)
    rows = _dedupe(rows, key_idx=(0, 1))  # (email, created_at)
    cols_sql = ",".join(REG_DB_COLS)
    update_set = ",".join(
        f"{c}=EXCLUDED.{c}"
        for c in REG_DB_COLS
        if c not in ("email", "created_at")
    )
    sql = f"""
        INSERT INTO registrations ({cols_sql}) VALUES %s
        ON CONFLICT (email, created_at) DO UPDATE SET {update_set}
    """
    execute_values(cur, sql, rows, page_size=BATCH)
    return len(rows), before - len(rows)


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

def list_files(prefix, glob_filter=None):
    out = []
    for p in sorted(ROOT.iterdir()):
        if p.suffix.lower() != ".xls":
            continue
        if not p.name.lower().startswith(prefix.lower()):
            continue
        if glob_filter and not p.match(glob_filter):
            continue
        out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["jobs", "registrations", "all"], default="all")
    ap.add_argument("--reset", action="store_true",
                    help="DROP both tables then recreate before ingest")
    ap.add_argument("--files", default=None,
                    help="Glob filter (matched against filename) — e.g. 'Job Analogue 01.05.26*'")
    args = ap.parse_args()

    if "PGURI" not in os.environ:
        sys.stderr.write("Set PGURI to the Neon connection string.\n")
        sys.exit(2)

    print(f"Connecting to Neon…")
    conn = psycopg2.connect(os.environ["PGURI"], connect_timeout=15)
    conn.autocommit = False
    print(f"Connected. Postgres server reports: ", end="")
    with conn.cursor() as cur:
        cur.execute("SELECT version()")
        print(cur.fetchone()[0].split(",")[0])

        if args.reset:
            print("--reset: dropping existing tables")
            cur.execute(RESET_SQL)

        print("Ensuring schema…")
        cur.execute(SCHEMA_SQL)
        conn.commit()

    total_jobs = 0
    total_regs = 0

    if args.only in ("jobs", "all"):
        files = list_files("Job Analogue", args.files)
        print(f"\nJob Analogue files: {len(files)}")
        for p in files:
            t0 = time.time()
            rows = parse_job_file(p)
            with conn.cursor() as cur:
                n, dup = upsert_jobs(cur, rows)
            conn.commit()
            total_jobs += n
            dt = time.time() - t0
            dup_s = f" (deduped {dup})" if dup else ""
            print(f"  {p.name:55s} rows={n:>6}  ({dt:5.1f}s){dup_s}")

    if args.only in ("registrations", "all"):
        files = list_files("Registration Info", args.files)
        print(f"\nRegistration files: {len(files)}")
        for p in files:
            t0 = time.time()
            rows = parse_reg_file(p)
            with conn.cursor() as cur:
                n, dup = upsert_regs(cur, rows)
            conn.commit()
            total_regs += n
            dt = time.time() - t0
            dup_s = f" (deduped {dup})" if dup else ""
            print(f"  {p.name:35s} rows={n:>5}  ({dt:5.1f}s){dup_s}")

    # Summary
    print("\nSummary so far:")
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*), MIN(job_date), MAX(job_date) FROM job_analogue")
        n, dmin, dmax = cur.fetchone()
        print(f"  job_analogue:  {n} rows   {dmin} .. {dmax}")
        cur.execute("SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM registrations")
        n, cmin, cmax = cur.fetchone()
        print(f"  registrations: {n} rows   {cmin} .. {cmax}")

    conn.close()
    print(f"\nDone. Upserted jobs={total_jobs}, registrations={total_regs}")


if __name__ == "__main__":
    main()
