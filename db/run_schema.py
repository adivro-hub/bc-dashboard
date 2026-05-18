"""One-shot helper: connect to Supabase Postgres and run schema.sql.

Reads connection details from env vars so they don't end up in git history:

    BC_DB_HOST     (default db.<project-ref>.supabase.co)
    BC_DB_PORT     (default 5432)
    BC_DB_NAME     (default postgres)
    BC_DB_USER     (default postgres)
    BC_DB_PASSWORD (required)

Run:  python db/run_schema.py
"""
import os
import sys
from pathlib import Path

import pg8000

SCHEMA = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")

host = os.environ.get("BC_DB_HOST")
port = int(os.environ.get("BC_DB_PORT", "5432"))
db   = os.environ.get("BC_DB_NAME", "postgres")
user = os.environ.get("BC_DB_USER", "postgres")
pw   = os.environ.get("BC_DB_PASSWORD")
if not host or not pw:
    sys.exit("Set BC_DB_HOST and BC_DB_PASSWORD env vars")

print(f"Connecting to {host}:{port}/{db} as {user}…")
import ssl
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
conn = pg8000.connect(user=user, password=pw, host=host, port=port, database=db, ssl_context=ctx)
conn.autocommit = True
cur = conn.cursor()
print("Running schema (length:", len(SCHEMA), "chars)…")
try:
    cur.execute(SCHEMA)
    print("OK — schema applied.")
except Exception as e:
    print("ERROR:", e)
    raise
finally:
    cur.close()
    conn.close()
