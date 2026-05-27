"""
Ingest daily Income Structure XLS files into Neon's income_structure_*
mirror tables. Each file represents one day; the date comes from the
"From:" cell in row 1.

Section -> target table mapping mirrors the legacy build_dashboard.py:
  Sales                              -> income_structure_vat          (Sales col)
  Sales By Payment Type              -> income_structure_payment_type
  Sales by Customer Grade            -> income_structure_grade
  Sales by Service                   -> income_structure_service
  Sales by Fleet                     -> income_structure_fleet
  Driver Login Time by Fleet (hours) -> income_structure_login_time   (Hours from col 1)

Total rows ("Total:" / "TOTAL" / "Total Sales:") are skipped to match
the cron sync's behaviour (it filters out the source DB's Total rollups).

Idempotent via UPSERT on the table's natural PK. Re-runs are safe.

Usage:
  NEON_PGURI='...' python3 ingest_income_xls.py /path/to/folder
  NEON_PGURI='...' python3 ingest_income_xls.py file1.xls file2.xls ...
"""
import os
import re
import sys
from pathlib import Path

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values


# Section header text in the XLS -> (table, category column name)
SECTION_MAP = {
    "Sales":                              ("income_structure_vat",          "Sales"),
    "Sales By Payment Type":              ("income_structure_payment_type", "PaymentType"),
    "Sales by Customer Grade":            ("income_structure_grade",        "Grade"),
    "Sales by Service":                   ("income_structure_service",      "Service"),
    "Sales by Fleet":                     ("income_structure_fleet",        "Fleet"),
    "Driver Login Time by Fleet (hours)": ("income_structure_login_time",   "Fleet"),
}


def to_num(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, str) and not v.strip():
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def parse_file(path: Path):
    engine = "openpyxl" if path.suffix.lower() == ".xlsx" else "xlrd"
    df = pd.read_excel(path, sheet_name=0, header=None, dtype=object, engine=engine)

    period_from = None
    for i in range(min(6, len(df))):
        cell = df.iloc[i, 1]
        if isinstance(cell, str) and cell.strip().lower() == "from:":
            v = df.iloc[i, 2]
            if isinstance(v, pd.Timestamp):
                period_from = v.date().isoformat()
            else:
                period_from = pd.to_datetime(str(v)).date().isoformat()
            break
    if not period_from:
        raise ValueError(f"No From: date in {path.name}")

    sections = {tab: [] for tab, _ in SECTION_MAP.values()}
    current_table = None

    for i in range(len(df)):
        raw = df.iloc[i, 0]
        label = "" if pd.isna(raw) else str(raw).strip()
        if not label:
            continue
        if label in SECTION_MAP:
            current_table, _ = SECTION_MAP[label]
            continue
        if current_table is None:
            continue
        # Skip rollup rows: "Total:", "TOTAL", "Total Sales:" etc.
        if label.lower().startswith("total"):
            continue

        if current_table == "income_structure_login_time":
            hours = to_num(df.iloc[i, 1])
            sections[current_table].append((period_from, label, hours))
        else:
            sections[current_table].append((
                period_from,
                label,
                to_num(df.iloc[i, 1]),  # Jobs
                to_num(df.iloc[i, 2]),  # WithoutTax
                to_num(df.iloc[i, 3]),  # Tax
                to_num(df.iloc[i, 4]),  # Total
                to_num(df.iloc[i, 5]),  # Earnings
            ))

    return {"date": period_from, "sections": sections}


# Per-table UPSERT statement.
def upsert_sql(table, category_col):
    if table == "income_structure_login_time":
        cols = f'"Date", "{category_col}", "Hours"'
        non_pk = '"Hours" = EXCLUDED."Hours", synced_at = NOW()'
    else:
        cols = f'"Date", "{category_col}", "Jobs", "WithoutTax", "Tax", "Total", "Earnings"'
        non_pk = (
            '"Jobs" = EXCLUDED."Jobs", '
            '"WithoutTax" = EXCLUDED."WithoutTax", '
            '"Tax" = EXCLUDED."Tax", '
            '"Total" = EXCLUDED."Total", '
            '"Earnings" = EXCLUDED."Earnings", '
            'synced_at = NOW()'
        )
    return (
        f'INSERT INTO {table} ({cols}) VALUES %s '
        f'ON CONFLICT ("Date", "{category_col}") DO UPDATE SET {non_pk}'
    )


def collect_files(args):
    out = []
    for arg in args:
        p = Path(arg)
        if p.is_dir():
            for f in sorted(p.iterdir()):
                if f.name.lower().startswith("income structure") and \
                   f.suffix.lower() in (".xls", ".xlsx"):
                    out.append(f)
        elif p.is_file():
            out.append(p)
    return out


def main():
    if "NEON_PGURI" not in os.environ:
        sys.stderr.write("Set NEON_PGURI\n"); sys.exit(2)
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: ingest_income_xls.py <folder or files...>\n"); sys.exit(2)

    files = collect_files(sys.argv[1:])
    if not files:
        sys.stderr.write("No matching files found\n"); sys.exit(2)
    print(f"Files to ingest: {len(files)}")

    conn = psycopg2.connect(os.environ["NEON_PGURI"], connect_timeout=15)
    conn.autocommit = False

    totals = {tab: 0 for tab, _ in SECTION_MAP.values()}
    for path in files:
        try:
            parsed = parse_file(path)
        except Exception as e:
            print(f"  {path.name:35s} PARSE-FAIL: {e}")
            continue
        with conn, conn.cursor() as cur:
            for table, cat in SECTION_MAP.values():
                rows = parsed["sections"][table]
                if not rows:
                    continue
                execute_values(cur, upsert_sql(table, cat), rows, page_size=500)
                totals[table] += len(rows)
        print(f"  {path.name:35s} date={parsed['date']}  ok")

    print("\nUpserted per table:")
    for tab in totals:
        print(f"  {tab:33s} +{totals[tab]} rows")

    # Final verify
    print("\nFinal counts in Neon:")
    with conn.cursor() as cur:
        for tab, _ in SECTION_MAP.values():
            cur.execute(
                f'SELECT COUNT(*)::int, MIN("Date")::text, MAX("Date")::text FROM {tab}'
            )
            n, dmin, dmax = cur.fetchone()
            print(f"  {tab:33s} rows={n}  {dmin} .. {dmax}")
    conn.close()


if __name__ == "__main__":
    main()
