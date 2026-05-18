import os, ssl, pg8000
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
conn = pg8000.connect(user=os.environ['BC_DB_USER'], password=os.environ['BC_DB_PASSWORD'],
                       host=os.environ['BC_DB_HOST'], port=int(os.environ['BC_DB_PORT']),
                       database='postgres', ssl_context=ctx)
cur = conn.cursor()
cur.execute("SELECT email, role, added_at FROM public.members ORDER BY added_at")
print("Members:")
for row in cur.fetchall(): print(" ", row)
cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")
print("Tables:", [r[0] for r in cur.fetchall()])
cur.close(); conn.close()
