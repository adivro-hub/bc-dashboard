"""Generate the dashboard HTML files from the template.

Three modes:
  python embed_data.py            # full build -> dashboard.html (inline data, with names)
  python embed_data.py --public   # anonymised build -> index.html (inline data, no names)
  python embed_data.py --upload   # data-less build -> upload.html (file-pickers + parsers.js)

dashboard.css and dashboard.js are external in all builds.
"""
import json
import sys
from pathlib import Path

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")

PUBLIC_MODE = "--public" in sys.argv
UPLOAD_MODE = "--upload" in sys.argv

template = (ROOT / "dashboard.template.html").read_text(encoding="utf-8")

PLACEHOLDERS = [
    "<!--DATA_PLACEHOLDER-->",
    "<!--JOBS_PLACEHOLDER-->",
    "<!--HOURS_PLACEHOLDER-->",
    "<!--REG_PLACEHOLDER-->",
    "<!--OTP_PLACEHOLDER-->",
    "<!--TOPCLIENTS_PLACEHOLDER-->",
    "<!--KPIS_PLACEHOLDER-->",
]

if UPLOAD_MODE:
    # Replace all data placeholders with nothing -- data will be set by upload.js
    out = template
    for p in PLACEHOLDERS:
        out = out.replace(p, "")
    # Drop the auto-invocation: upload.js will call renderDashboard() after parsing.
    out = out.replace("<script>renderDashboard();</script>", "")
    # Inject the upload UI immediately inside <body>.
    upload_ui = (ROOT / "upload_ui.html").read_text(encoding="utf-8")
    out = out.replace("<body>", "<body>" + upload_ui)
    # Pull in SheetJS, Supabase (optional), config (optional), parsers, store, upload.
    # Theme bootstrap runs *before* CSS to avoid a flash of wrong theme.
    head_extra = (
        '<script>'
        '(function(){var t=localStorage.getItem("bc-theme")||"dark";'
        'document.documentElement.setAttribute("data-theme",t);})();'
        '</script>\n'
        '<script src="https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js"></script>\n'
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>\n'
        '<script src="config.js" onerror="this.remove()"></script>\n'
        '<script src="parsers.js" defer></script>\n'
        '<script src="shared_store.js" defer></script>\n'
        '<script src="upload.js" defer></script>\n'
    )
    out = out.replace("</head>", head_extra + "</head>")
    # Hide the dashboard view container until data is parsed.
    out = out.replace('<div class="tabs" id="tabs">',
                      '<div id="dashboard-area" style="display:none">\n  <div class="tabs" id="tabs">')
    # Find the last </div><!-- /.wrap --> and add closing for dashboard-area before it.
    out = out.replace('</div><!-- /.wrap -->', '</div><!-- /#dashboard-area -->\n</div><!-- /.wrap -->')
    # Different title
    out = out.replace("<title>Income Structure — Weekly Comparison</title>",
                      "<title>BC Dashboard — Upload your reports</title>")
    out_path = ROOT / "upload.html"
    (out_path).write_text(out, encoding="utf-8")
    size = out_path.stat().st_size
    print(f"Wrote {out_path}  ({size:,} bytes)  mode=upload")
    sys.exit(0)

# ----- Embedded-data modes -----
income = json.loads((ROOT / "data.json").read_text(encoding="utf-8"))
jobs   = json.loads((ROOT / "jobs.json").read_text(encoding="utf-8"))
hours  = json.loads((ROOT / "hours.json").read_text(encoding="utf-8"))
reg    = json.loads((ROOT / "registrations.json").read_text(encoding="utf-8"))
otp    = json.loads((ROOT / "otp.json").read_text(encoding="utf-8"))
top    = json.loads((ROOT / "top_clients.json").read_text(encoding="utf-8"))
kpis_d = json.loads((ROOT / "kpis.json").read_text(encoding="utf-8"))

if PUBLIC_MODE:
    # Anonymisation level (a): strip Account Name from jobs.json and corporate top-25.
    for week_key in ("current", "previous"):
        for row in jobs.get(week_key, []):
            row["account_name"] = ""
    for row in top.get("corporate", {}).get("top", []):
        row["account_name"] = ""
    # The "public" build is now the offline demo (bundled anonymised data).
    # It is no longer the root of the site — index.html is a redirect to the
    # auth-gated live viewer (upload.html).
    out_name = "demo.html"
else:
    out_name = "dashboard.html"

income_inline = f"<script>window.__DATA__ = {json.dumps(income)};</script>"
jobs_inline   = f"<script>window.__JOBS__ = {json.dumps(jobs, ensure_ascii=False)};</script>"
hours_inline  = f"<script>window.__HOURS__ = {json.dumps(hours, ensure_ascii=False)};</script>"
reg_inline    = f"<script>window.__REG__ = {json.dumps(reg, ensure_ascii=False)};</script>"
otp_inline    = f"<script>window.__OTP__ = {json.dumps(otp, ensure_ascii=False)};</script>"
top_inline    = f"<script>window.__TOPCLIENTS__ = {json.dumps(top, ensure_ascii=False)};</script>"
kpis_inline   = f"<script>window.__KPIS__ = {json.dumps(kpis_d, ensure_ascii=False)};</script>"

out = template.replace("<!--DATA_PLACEHOLDER-->", income_inline)
out = out.replace("<!--JOBS_PLACEHOLDER-->", jobs_inline)
out = out.replace("<!--HOURS_PLACEHOLDER-->", hours_inline)
out = out.replace("<!--REG_PLACEHOLDER-->", reg_inline)
out = out.replace("<!--OTP_PLACEHOLDER-->", otp_inline)
out = out.replace("<!--TOPCLIENTS_PLACEHOLDER-->", top_inline)
out = out.replace("<!--KPIS_PLACEHOLDER-->", kpis_inline)

if PUBLIC_MODE:
    banner = (
        '<div style="background:#3ddc97;color:#0b1020;text-align:center;'
        'padding:6px 12px;font:600 12px system-ui;letter-spacing:.4px">'
        'PUBLIC BUILD — customer names removed</div>'
    )
    out = out.replace("<body>", "<body>" + banner)

(ROOT / out_name).write_text(out, encoding="utf-8")
size = (ROOT / out_name).stat().st_size
print(f"Wrote {ROOT / out_name}  ({size:,} bytes)  mode={'public' if PUBLIC_MODE else 'full'}")
