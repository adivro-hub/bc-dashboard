"""Extract corporate account names from job Excel files and upsert into
public.account_names. Run once after the initial bulk push."""
import sys, os, ssl, re
from pathlib import Path
import pg8000
import pandas as pd

FOLDER = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\Adrian\Desktop\dashboard\new reports")
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
conn = pg8000.connect(user=os.environ['BC_DB_USER'], password=os.environ['BC_DB_PASSWORD'],
                       host=os.environ['BC_DB_HOST'], port=int(os.environ['BC_DB_PORT']),
                       database='postgres', ssl_context=ctx)
conn.autocommit = True
cur = conn.cursor()

names = {}
for p in sorted(FOLDER.iterdir()):
    if not p.name.startswith('Job Analogue'): continue
    df = pd.read_excel(p, sheet_name=0, engine='xlrd', header=0, skiprows=3)
    df.columns = [str(c).strip() for c in df.columns]
    iAcc  = df.columns.get_loc('Account Number')  if 'Account Number' in df.columns else None
    iName = df.columns.get_loc('Account Name')    if 'Account Name'   in df.columns else None
    if iAcc is None or iName is None: continue
    for _, r in df.iterrows():
        acc = r.iloc[iAcc]; nm = r.iloc[iName]
        if pd.isna(acc) or pd.isna(nm): continue
        try: n = int(float(acc))
        except: continue
        nm = str(nm).strip()
        if not nm: continue
        if n not in names: names[n] = nm
    print(f"  {p.name}: now {len(names)} unique accounts")

print(f"\nTotal unique account names: {len(names)}")
params = list(names.items())
CHUNK = 500
for i in range(0, len(params), CHUNK):
    cur.executemany("INSERT INTO public.account_names (account_no, name) VALUES (%s, %s) "
                    "ON CONFLICT (account_no) DO UPDATE SET name = EXCLUDED.name, updated_at = now()",
                    params[i:i+CHUNK])
print("Done.")
cur.close(); conn.close()
