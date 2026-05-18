"""Insert a member into public.members. Usage:
   python db/add_member.py email@example.com [uploader|viewer]
"""
import os, sys, ssl, pg8000

email = sys.argv[1] if len(sys.argv) > 1 else None
role  = sys.argv[2] if len(sys.argv) > 2 else "uploader"
if not email:
    sys.exit("usage: add_member.py email role")

ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
conn = pg8000.connect(
    user=os.environ["BC_DB_USER"], password=os.environ["BC_DB_PASSWORD"],
    host=os.environ["BC_DB_HOST"], port=int(os.environ.get("BC_DB_PORT","5432")),
    database="postgres", ssl_context=ctx,
)
conn.autocommit = True
cur = conn.cursor()
cur.execute("INSERT INTO public.members (email, role) VALUES (%s, %s) "
            "ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role", (email, role))
print(f"Upserted {email} as {role}")
cur.execute("SELECT email, role FROM public.members ORDER BY added_at")
for row in cur.fetchall():
    print(" ", row[0], row[1])
cur.close()
conn.close()
