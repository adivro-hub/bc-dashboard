"""
Pull the six data_access.income_structure_* views from the source DB
into the matching mirror tables in Neon. Idempotent (TRUNCATE+INSERT
per view, one transaction each).

Bypasses the node-pg SSL/self-signed-cert problem by using psycopg2
(libpq under the hood, same as psql).

Env:
  SOURCE_PGURI  full URI for the source DB
                e.g. postgresql://job_analogue_access:PASS@62.212.86.214:5432/taxi_miiles
  NEON_PGURI    Neon connection string
                e.g. postgresql://neondb_owner:PASS@...neon.tech/neondb?sslmode=require

Usage:
  SOURCE_PGURI='...' NEON_PGURI='...' python3 sync_income_to_neon.py
"""
import os
import sys
import time

import psycopg2
from psycopg2.extras import execute_values

VIEWS = [
    {
        "section": "vat",
        "source": 'data_access.income_structure_vat',
        "target": "income_structure_vat",
        "pk":     ['"Date"', '"Sales"'],
        "columns": [
            ('"Date"',       "date"),
            ('"Sales"',      "text"),
            ('"Jobs"',       "numeric"),
            ('"WithoutTax"', "numeric"),
            ('"Tax"',        "numeric"),
            ('"Total"',      "numeric"),
            ('"Earnings"',   "numeric"),
        ],
    },
    {
        "section": "payment_type",
        "source": 'data_access.income_structure_payment_type',
        "target": "income_structure_payment_type",
        "pk":     ['"Date"', '"PaymentType"'],
        "columns": [
            ('"Date"',        "date"),
            ('"PaymentType"', "text"),
            ('"Jobs"',        "numeric"),
            ('"WithoutTax"',  "numeric"),
            ('"Tax"',         "numeric"),
            ('"Total"',       "numeric"),
            ('"Earnings"',    "numeric"),
        ],
    },
    {
        "section": "grade",
        "source": 'data_access.income_structure_grade',
        "target": "income_structure_grade",
        "pk":     ['"Date"', '"Grade"'],
        "columns": [
            ('"Date"',       "date"),
            ('"Grade"',      "text"),
            ('"Jobs"',       "numeric"),
            ('"WithoutTax"', "numeric"),
            ('"Tax"',        "numeric"),
            ('"Total"',      "numeric"),
            ('"Earnings"',   "numeric"),
        ],
    },
    {
        "section": "service",
        "source": 'data_access.income_structure_service',
        "target": "income_structure_service",
        "pk":     ['"Date"', '"Service"'],
        "columns": [
            ('"Date"',       "date"),
            ('"Service"',    "text"),
            ('"Jobs"',       "numeric"),
            ('"WithoutTax"', "numeric"),
            ('"Tax"',        "numeric"),
            ('"Total"',      "numeric"),
            ('"Earnings"',   "numeric"),
        ],
    },
    {
        "section": "fleet",
        "source": 'data_access.income_structure_fleet',
        "target": "income_structure_fleet",
        "pk":     ['"Date"', '"Fleet"'],
        "columns": [
            ('"Date"',       "date"),
            ('"Fleet"',      "text"),
            ('"Jobs"',       "numeric"),
            ('"WithoutTax"', "numeric"),
            ('"Tax"',        "numeric"),
            ('"Total"',      "numeric"),
            ('"Earnings"',   "numeric"),
        ],
    },
    {
        "section": "login_time",
        "source": 'data_access.income_structure_login_time',
        "target": "income_structure_login_time",
        "pk":     ['"Date"', '"Fleet"'],
        "columns": [
            ('"Date"',  "date"),
            ('"Fleet"', "text"),
            ('"Hours"', "numeric"),
        ],
    },
]


def ensure_table(neon_cur, v):
    cols_sql = ", ".join(f"{name} {ty}" for name, ty in v["columns"])
    pk_sql = ", ".join(v["pk"])
    neon_cur.execute(
        f'CREATE TABLE IF NOT EXISTS {v["target"]} ('
        f'{cols_sql}, '
        f'synced_at TIMESTAMPTZ DEFAULT NOW(), '
        f'PRIMARY KEY ({pk_sql}))'
    )
    neon_cur.execute(
        f'CREATE INDEX IF NOT EXISTS idx_{v["target"]}_date '
        f'ON {v["target"]} ("Date")'
    )


def sync_one(src_conn, neon_conn, v):
    t0 = time.time()
    cols_sql_q = ", ".join(name for name, _ in v["columns"])

    # Read from source. Each view is at most ~11k rows so a client-side
    # cursor is fine and lets us stay autocommit/readonly on this conn.
    with src_conn.cursor() as src_cur:
        src_cur.execute(f'SELECT {cols_sql_q} FROM {v["source"]}')
        rows = src_cur.fetchall()

    # Write to Neon: TRUNCATE + INSERT in one tx
    with neon_conn:  # transaction
        with neon_conn.cursor() as cur:
            ensure_table(cur, v)
            cur.execute(f'TRUNCATE TABLE {v["target"]}')
            if rows:
                # Build column list including synced_at NOW() default — we
                # only insert the data columns; synced_at uses its DEFAULT.
                placeholders = "(" + ", ".join(["%s"] * len(v["columns"])) + ")"
                execute_values(
                    cur,
                    f'INSERT INTO {v["target"]} ({cols_sql_q}) VALUES %s',
                    rows,
                    template=placeholders,
                    page_size=5000,
                )
    dt = time.time() - t0
    return len(rows), dt


def main():
    if not (os.environ.get("SOURCE_PGURI") and os.environ.get("NEON_PGURI")):
        sys.stderr.write("Set both SOURCE_PGURI and NEON_PGURI.\n")
        sys.exit(2)

    print("Connecting to source DB…")
    src = psycopg2.connect(os.environ["SOURCE_PGURI"], connect_timeout=15)
    src.set_session(readonly=True, autocommit=True)

    print("Connecting to Neon…")
    neon = psycopg2.connect(os.environ["NEON_PGURI"], connect_timeout=15)
    neon.autocommit = False

    total_rows = 0
    print()
    for v in VIEWS:
        print(f"  syncing {v['section']:14s}", end=" ", flush=True)
        try:
            n, dt = sync_one(src, neon, v)
            print(f"rows={n:>6}   {dt:5.1f}s")
            total_rows += n
        except Exception as e:
            print(f"FAIL: {e}")
            neon.rollback()

    # Verify
    print()
    print("Final counts in Neon:")
    with neon.cursor() as cur:
        for v in VIEWS:
            cur.execute(
                f'SELECT COUNT(*)::int, MIN("Date")::text, MAX("Date")::text, '
                f'MAX(synced_at)::text FROM {v["target"]}'
            )
            n, dmin, dmax, synced = cur.fetchone()
            print(f"  {v['target']:33s} rows={n:>6}  {dmin} .. {dmax}  synced={synced}")

    src.close()
    neon.close()
    print(f"\nDone. Total source rows pulled: {total_rows}")


if __name__ == "__main__":
    main()
