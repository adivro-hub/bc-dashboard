"""Snapshot of what's in the shared store right now."""
import os, ssl, pg8000
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
conn = pg8000.connect(user=os.environ['BC_DB_USER'], password=os.environ['BC_DB_PASSWORD'],
                       host=os.environ['BC_DB_HOST'], port=int(os.environ['BC_DB_PORT']),
                       database='postgres', ssl_context=ctx)
cur = conn.cursor()

def count(t):
    cur.execute(f"SELECT count(*) FROM public.{t}")
    return cur.fetchone()[0]

print(f"{'table':16s} {'rows':>10s}")
print("-" * 28)
for t in ('members','account_names','income_files','hours_files','job_files','job_rows','reg_files','reg_rows'):
    print(f"{t:16s} {count(t):>10d}")

print("\nIncome files:")
cur.execute("SELECT source_name, period_from, period_to, uploaded_at FROM public.income_files ORDER BY period_from")
for r in cur.fetchall():
    print(f"  {r[1]} -> {r[2]}  {r[0][:40]:40s}  at {r[3]}")

print("\nJob files:")
cur.execute("SELECT source_name, period_start, period_end, row_count, uploaded_at FROM public.job_files ORDER BY period_start")
for r in cur.fetchall():
    print(f"  {r[1]} -> {r[2]}  {r[3]:>6,} rows  {r[0][:40]:40s}  at {r[4]}")

print("\nHours files:")
cur.execute("SELECT source_name, period_start, period_end, uploaded_at FROM public.hours_files ORDER BY period_start")
for r in cur.fetchall():
    print(f"  {r[1]} -> {r[2]}  {r[0][:30]:30s}  at {r[3]}")

print("\nReg files:")
cur.execute("SELECT source_name, uploaded_at FROM public.reg_files ORDER BY uploaded_at")
for r in cur.fetchall():
    print(f"  {r[0][:40]:40s}  at {r[1]}")

print("\nAccount names sample (5):")
cur.execute("SELECT account_no, name FROM public.account_names ORDER BY account_no LIMIT 5")
for r in cur.fetchall():
    print(f"  {r[0]}: {r[1]}")

# Date coverage of job_rows
cur.execute("SELECT min(date), max(date), count(DISTINCT date) FROM public.job_rows")
mn, mx, dd = cur.fetchone()
print(f"\nJob rows date coverage: {mn} -> {mx}  ({dd} unique dates)")

cur.close(); conn.close()
