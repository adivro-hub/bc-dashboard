"""Inject data.json + jobs.json + hours.json + registrations.json into
dashboard.html as inline <script> blocks.

Usage:
  python embed_data.py            # full build → dashboard.html
  python embed_data.py --public   # anonymised build → dashboard.public.html
                                  # (account names stripped; account numbers kept)
"""
import json
import sys
from pathlib import Path

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")

PUBLIC_MODE = "--public" in sys.argv

income = json.loads((ROOT / "data.json").read_text(encoding="utf-8"))
jobs   = json.loads((ROOT / "jobs.json").read_text(encoding="utf-8"))
hours  = json.loads((ROOT / "hours.json").read_text(encoding="utf-8"))
reg    = json.loads((ROOT / "registrations.json").read_text(encoding="utf-8"))
otp    = json.loads((ROOT / "otp.json").read_text(encoding="utf-8"))
template = (ROOT / "dashboard.template.html").read_text(encoding="utf-8")

if PUBLIC_MODE:
    # Anonymisation level (a):
    #   - strip the customer-facing Account Name from every job row
    #   - keep the account number so the pivot still works
    #   - everything else (services, fleets, payment types, customer grades,
    #     all aggregates) is non-personal and stays as-is
    for week_key in ("current", "previous"):
        for row in jobs.get(week_key, []):
            row["account_name"] = ""
    # Public build is named index.html so GitHub Pages serves it at the repo root
    out_name = "index.html"
else:
    out_name = "dashboard.html"

income_inline = f"<script>window.__DATA__ = {json.dumps(income)};</script>"
jobs_inline   = f"<script>window.__JOBS__ = {json.dumps(jobs, ensure_ascii=False)};</script>"
hours_inline  = f"<script>window.__HOURS__ = {json.dumps(hours, ensure_ascii=False)};</script>"
reg_inline    = f"<script>window.__REG__ = {json.dumps(reg, ensure_ascii=False)};</script>"
otp_inline    = f"<script>window.__OTP__ = {json.dumps(otp, ensure_ascii=False)};</script>"

out = template.replace("<!--DATA_PLACEHOLDER-->", income_inline)
out = out.replace("<!--JOBS_PLACEHOLDER-->", jobs_inline)
out = out.replace("<!--HOURS_PLACEHOLDER-->", hours_inline)
out = out.replace("<!--REG_PLACEHOLDER-->", reg_inline)
out = out.replace("<!--OTP_PLACEHOLDER-->", otp_inline)

if PUBLIC_MODE:
    # Add a small banner so it's obvious which build is being viewed
    banner = (
        '<div style="background:#3ddc97;color:#0b1020;text-align:center;'
        'padding:6px 12px;font:600 12px system-ui;letter-spacing:.4px">'
        'PUBLIC BUILD — customer names removed</div>'
    )
    out = out.replace("<body>", "<body>" + banner)

(ROOT / out_name).write_text(out, encoding="utf-8")
size = (ROOT / out_name).stat().st_size
print(f"Wrote {ROOT / out_name}  ({size:,} bytes)  mode={'public' if PUBLIC_MODE else 'full'}")
