"""
Backfill / refresh data_access.hour_statistics() into Neon.

The source is a per-day function call returning 25 rows per day (24 hourly
rows + 1 daily-total row). We store only the 24 hourly rows; daily totals
can be recomputed with SUM() if/when needed.

Env:
  SOURCE_PGURI   source DB connection string
  NEON_PGURI     Neon connection string

Usage:
  # full backfill 2025-01-01 -> today
  SOURCE_PGURI=... NEON_PGURI=... python3 sync_hours_to_neon.py

  # only the last N days (useful for nightly refresh)
  SOURCE_PGURI=... NEON_PGURI=... python3 sync_hours_to_neon.py --days 7

  # explicit range
  SOURCE_PGURI=... NEON_PGURI=... python3 sync_hours_to_neon.py \
      --from 2026-05-01 --to 2026-05-26
"""
import argparse
import os
import re
import sys
import time
from datetime import date, timedelta

import psycopg2
from psycopg2.extras import execute_values


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS hour_statistics (
  date        DATE     NOT NULL,
  hour        SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  unknown     BIGINT,
  logged_off  BIGINT,
  online      BIGINT,
  empty       BIGINT,
  in_rank     BIGINT,
  on_break    BIGINT,
  going_home  BIGINT,
  doing_job   BIGINT,
  synced_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (date, hour)
);
CREATE INDEX IF NOT EXISTS idx_hour_statistics_date ON hour_statistics(date);
"""

# Source returns e.g. "18/05/26 14:00" or "18/05/26" (total row).
HOUR_RE = re.compile(r"^\d{2}/\d{2}/\d{2}\s+(\d{2}):\d{2}$")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="from_date",
                   help="start date (YYYY-MM-DD); default 2025-01-01")
    p.add_argument("--to", dest="to_date",
                   help="end date (YYYY-MM-DD); default today")
    p.add_argument("--days", type=int,
                   help="shorthand: sync the last N days (overrides --from/--to)")
    return p.parse_args()


def date_range(start: date, end: date):
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def fetch_day(src_cur, d: date):
    src_cur.execute(
        'SELECT "time", unknown, logged_off, online, empty, in_rank, '
        '       on_break, going_home, doing_job '
        'FROM data_access.hour_statistics(%s::date)',
        (d,)
    )
    rows = []
    for r in src_cur.fetchall():
        t = (r[0] or "").strip()
        m = HOUR_RE.match(t)
        if not m:
            # Daily-total row (no HH:MM) — skip.
            continue
        hour = int(m.group(1))
        rows.append((d, hour, *r[1:]))
    return rows


def upsert_day(neon_cur, rows):
    if not rows:
        return 0
    execute_values(
        neon_cur,
        """
        INSERT INTO hour_statistics
          (date, hour, unknown, logged_off, online, empty,
           in_rank, on_break, going_home, doing_job)
        VALUES %s
        ON CONFLICT (date, hour) DO UPDATE SET
          unknown    = EXCLUDED.unknown,
          logged_off = EXCLUDED.logged_off,
          online     = EXCLUDED.online,
          empty      = EXCLUDED.empty,
          in_rank    = EXCLUDED.in_rank,
          on_break   = EXCLUDED.on_break,
          going_home = EXCLUDED.going_home,
          doing_job  = EXCLUDED.doing_job,
          synced_at  = NOW()
        """,
        rows,
        page_size=500,
    )
    return len(rows)


def main():
    args = parse_args()
    if not (os.environ.get("SOURCE_PGURI") and os.environ.get("NEON_PGURI")):
        sys.stderr.write("Set both SOURCE_PGURI and NEON_PGURI.\n")
        sys.exit(2)

    today = date.today()
    if args.days:
        start = today - timedelta(days=args.days - 1)
        end = today
    else:
        start = date.fromisoformat(args.from_date) if args.from_date else date(2025, 1, 1)
        end   = date.fromisoformat(args.to_date)   if args.to_date   else today
    if start > end:
        sys.stderr.write("from > to\n")
        sys.exit(2)

    n_days = (end - start).days + 1
    print(f"Range: {start} .. {end}  ({n_days} days)")

    print("Connecting to source DB…")
    src = psycopg2.connect(os.environ["SOURCE_PGURI"], connect_timeout=15)
    src.set_session(readonly=True, autocommit=True)

    print("Connecting to Neon…")
    neon = psycopg2.connect(os.environ["NEON_PGURI"], connect_timeout=15)
    neon.autocommit = False

    with neon, neon.cursor() as cur:
        cur.execute(SCHEMA_SQL)

    total_rows = 0
    t0 = time.time()
    with src.cursor() as src_cur:
        for i, d in enumerate(date_range(start, end), start=1):
            try:
                rows = fetch_day(src_cur, d)
            except Exception as e:
                print(f"  {d}  FETCH-FAIL: {e}")
                continue
            try:
                with neon, neon.cursor() as cur:
                    n = upsert_day(cur, rows)
            except Exception as e:
                neon.rollback()
                print(f"  {d}  UPSERT-FAIL: {e}")
                continue
            total_rows += n
            # Print a heartbeat every 25 days, plus the last day.
            if i % 25 == 0 or d == end:
                dt = time.time() - t0
                rate = i / max(dt, 0.001)
                eta = (n_days - i) / max(rate, 0.001)
                print(f"  [{i:>4}/{n_days}] {d}  rows+={n}  total={total_rows}  "
                      f"({rate:.1f}d/s, eta ~{eta:.0f}s)", flush=True)

    print()
    with neon.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*)::int, MIN(date)::text, MAX(date)::text, "
            "MAX(synced_at)::text FROM hour_statistics"
        )
        n, dmin, dmax, synced = cur.fetchone()
    print(f"hour_statistics  rows={n}  range={dmin} .. {dmax}  synced={synced}")
    src.close()
    neon.close()


if __name__ == "__main__":
    main()
