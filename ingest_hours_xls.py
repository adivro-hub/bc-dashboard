"""
Ingest a Hour Statistics XLS file into Neon's hour_statistics table.
The XLS is wide-format: one row per metric, one column per hour. We
transpose to one row per (date, hour) with the 8 vehicle-state metrics
as columns and UPSERT.

Job-count metrics in the XLS (jobs_asap / jobs_prebook / jobs_completed
/ jobs_cancelled) are NOT stored — they're computed on the fly from
job_analogue in /api/hours-bundle so the XLS values would be
double-counted. Same with the totals/averages rows at the bottom.

Daily-summary columns ("DD/MM/YY" without HH:MM) are skipped — we keep
only true hourly buckets and recompute aggregates server-side.

Usage:
  NEON_PGURI='...' python3 ingest_hours_xls.py file.xlsx [file2.xls ...]
"""
import os
import re
import sys
from pathlib import Path

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values


# XLS row label -> hour_statistics column. Only vehicle-state metrics
# are mapped; job counts are intentionally skipped (computed elsewhere).
METRIC_TO_COL = {
    "Number of vehicles online":             "online",
    "Number of vehicles doing job":          "doing_job",
    "Number of vehicles in rank":            "in_rank",
    "Number of vehicles empty":              "empty",
    "Number of vehicles on break":           "on_break",
    "Number of vehicles going home":         "going_home",
    "Number of vehicles logged off":         "logged_off",
    "Number of vehicles with status unknown":"unknown",
}
HOUR_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{2})\s+(\d{2}):\d{2}$")


def to_num(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 0
    if isinstance(v, str) and not v.strip():
        return 0
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return 0


def parse_file(path: Path):
    """Returns a list of (date, hour, online, doing_job, in_rank, empty,
       on_break, going_home, logged_off, unknown) tuples."""
    engine = "openpyxl" if path.suffix.lower() == ".xlsx" else "xlrd"
    df = pd.read_excel(path, sheet_name="Average", header=None, dtype=object, engine=engine)

    # Header row 0 col 1+ has "DD/MM/YY HH:00" timestamps (and trailing
    # "DD/MM/YY" daily-summary columns we skip).
    bucket_cols = []  # list of (col_index, date_iso, hour_int)
    for ci in range(1, df.shape[1]):
        cell = df.iloc[0, ci]
        if not isinstance(cell, str):
            continue
        m = HOUR_RE.match(cell.strip())
        if not m:
            continue   # daily-summary col or empty
        dd, mm, yy, hh = m.groups()
        date_iso = f"20{yy}-{mm}-{dd}"
        bucket_cols.append((ci, date_iso, int(hh)))

    # Map metric label -> row index for the metrics we care about.
    label_to_row = {}
    for ri in range(1, df.shape[0]):
        raw = df.iloc[ri, 0]
        if not isinstance(raw, str):
            continue
        label = raw.strip()
        if label in METRIC_TO_COL:
            label_to_row[label] = ri

    missing = set(METRIC_TO_COL) - set(label_to_row)
    if missing:
        sys.stderr.write(f"WARN: missing metric rows in {path.name}: {missing}\n")

    out = []
    for ci, date_iso, hour in bucket_cols:
        row = [date_iso, hour]
        for label, _col in METRIC_TO_COL.items():
            ri = label_to_row.get(label)
            row.append(to_num(df.iloc[ri, ci]) if ri is not None else 0)
        out.append(tuple(row))
    return out


UPSERT_SQL = """
INSERT INTO hour_statistics
  (date, hour, online, doing_job, in_rank, empty, on_break, going_home, logged_off, unknown)
VALUES %s
ON CONFLICT (date, hour) DO UPDATE SET
  online     = EXCLUDED.online,
  doing_job  = EXCLUDED.doing_job,
  in_rank    = EXCLUDED.in_rank,
  empty      = EXCLUDED.empty,
  on_break   = EXCLUDED.on_break,
  going_home = EXCLUDED.going_home,
  logged_off = EXCLUDED.logged_off,
  unknown    = EXCLUDED.unknown,
  synced_at  = NOW()
"""


def main():
    if "NEON_PGURI" not in os.environ:
        sys.stderr.write("Set NEON_PGURI\n"); sys.exit(2)
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: ingest_hours_xls.py <file.xlsx> [more files...]\n"); sys.exit(2)

    files = []
    for arg in sys.argv[1:]:
        p = Path(arg)
        if p.is_dir():
            for f in sorted(p.iterdir()):
                if f.name.lower().startswith("hour statistics") and \
                   f.suffix.lower() in (".xls", ".xlsx"):
                    files.append(f)
        elif p.is_file():
            files.append(p)

    if not files:
        sys.stderr.write("No matching files\n"); sys.exit(2)

    print(f"Files to ingest: {len(files)}")
    conn = psycopg2.connect(os.environ["NEON_PGURI"], connect_timeout=15)

    total = 0
    for path in files:
        rows = parse_file(path)
        with conn, conn.cursor() as cur:
            execute_values(cur, UPSERT_SQL, rows, page_size=500)
        print(f"  {path.name:40s} hours={len(rows)}")
        total += len(rows)

    print(f"\nUpserted {total} hour buckets.")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*)::int, COUNT(DISTINCT date) AS days, "
            "MIN(date)::text, MAX(date)::text FROM hour_statistics"
        )
        n, days, dmin, dmax = cur.fetchone()
        print(f"hour_statistics: rows={n}, days={days}, range={dmin} .. {dmax}")
    conn.close()


if __name__ == "__main__":
    main()
