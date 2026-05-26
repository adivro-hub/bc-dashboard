"""
Schema-discovery for the income_structure_* views in the data_access schema.

For each of the six known views, prints:
  - column list (name, data type, nullable)
  - row count
  - min/max of the "Date" column
  - one sample row for a recent date

Usage:
  PGPASSWORD='...' python3 inspect_income_views.py
  # or set PGURI to override:
  PGURI='postgresql://user:pw@host:5432/db' python3 inspect_income_views.py

Reads connection params from env vars (with sane defaults matching what the
DB admin gave us):
  PGHOST     default 62.212.86.214
  PGPORT     default 5432
  PGUSER     default job_analogue_access
  PGDATABASE default taxi_miiles
  PGPASSWORD (no default — must be set)
  PGURI      full URI; overrides everything above
"""
import json
import os
import sys
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    sys.stderr.write(
        "psycopg2 not installed. Install with:\n"
        "  python3 -m pip install --user --break-system-packages psycopg2-binary\n"
    )
    sys.exit(1)


VIEWS = [
    "income_structure_vat",
    "income_structure_payment_type",
    "income_structure_grade",
    "income_structure_service",
    "income_structure_fleet",
    "income_structure_login_time",
]
SCHEMA = "data_access"
SAMPLE_DATE = "2026-05-19"   # a date the admin confirmed has data


def connect():
    uri = os.environ.get("PGURI")
    if uri:
        return psycopg2.connect(uri, connect_timeout=10)
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "62.212.86.214"),
        port=int(os.environ.get("PGPORT", "5432")),
        user=os.environ.get("PGUSER", "job_analogue_access"),
        password=os.environ["PGPASSWORD"],
        dbname=os.environ.get("PGDATABASE", "taxi_miiles"),
        connect_timeout=10,
    )


def describe(cur, view):
    cur.execute(
        """
        SELECT column_name, data_type, is_nullable, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
        """,
        (SCHEMA, view),
    )
    return cur.fetchall()


def stats(cur, view):
    full = f'"{SCHEMA}"."{view}"'
    cur.execute(f'SELECT COUNT(*) AS n, MIN("Date") AS dmin, MAX("Date") AS dmax FROM {full}')
    return cur.fetchone()


def sample(cur, view):
    full = f'"{SCHEMA}"."{view}"'
    cur.execute(f'SELECT * FROM {full} WHERE "Date" = %s LIMIT 1', (SAMPLE_DATE,))
    return cur.fetchone()


def main():
    if "PGPASSWORD" not in os.environ and "PGURI" not in os.environ:
        sys.stderr.write("Set PGPASSWORD (or PGURI) before running.\n")
        sys.exit(2)

    report = {"views": {}}
    try:
        conn = connect()
    except Exception as e:
        sys.stderr.write(f"Connection failed: {e}\n")
        sys.exit(3)

    with conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        for v in VIEWS:
            entry = {}
            try:
                entry["columns"] = describe(cur, v)
                entry["stats"] = stats(cur, v)
                entry["sample_row"] = sample(cur, v)
            except Exception as e:
                entry["error"] = str(e)
                conn.rollback()
            report["views"][v] = entry

    # Pretty print to stdout, also dump JSON next to the script
    print("=" * 78)
    for v, e in report["views"].items():
        print(f"\n## {SCHEMA}.{v}")
        if "error" in e:
            print(f"  ERROR: {e['error']}")
            continue
        print("  columns:")
        for c in e["columns"]:
            print(f"    - {c['column_name']:30s} {c['data_type']:20s} nullable={c['is_nullable']}")
        s = e["stats"] or {}
        print(f"  rows: {s.get('n')}   date range: {s.get('dmin')} .. {s.get('dmax')}")
        print(f"  sample row ({SAMPLE_DATE}):")
        row = e["sample_row"]
        if row:
            for k, val in row.items():
                print(f"    {k} = {val!r}")
        else:
            print("    (no row for sample date)")

    out = Path(__file__).with_suffix(".json")
    out.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(f"\nFull JSON report: {out}")


if __name__ == "__main__":
    main()
