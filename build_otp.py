"""
Build otp.json — strict OTP-airport pickup/destination aggregation by Service.

Filter: pickup or destination text contains 'OTP/LROP' or 'OTOPENI Airport'.
Town addresses in Otopeni are deliberately excluded.

Output is purely aggregate counts/sums by service — safe for the public build.
"""
import sys, io, json, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import pandas as pd
from pathlib import Path

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")
FILES = {
    "current":  ROOT / "Job Analogue 03.05.26 - 09.05.26.xls",
    "previous": ROOT / "Job Analogue 26.04.26 - 02.05.26.xls",
}

AIRPORT_RE = re.compile(r"OTP/LROP|OTOPENI\s*Airport", re.IGNORECASE)
NEEDED = ["Job Number", "Service", "Status", "Pick Up", "Drop Off", "Total Price"]


def parse(path):
    df = pd.read_excel(path, sheet_name="Sheet1", engine="xlrd",
                       header=0, skiprows=3)
    df.columns = [str(c).strip() for c in df.columns]
    df = df[[c for c in NEEDED if c in df.columns]].dropna(how="all")
    df["Pick Up"]  = df["Pick Up"].fillna("").astype(str)
    df["Drop Off"] = df["Drop Off"].fillna("").astype(str)
    df["Total Price"] = pd.to_numeric(df["Total Price"], errors="coerce").fillna(0)
    df["Service"] = df["Service"].fillna("(blank)").astype(str)
    return df


def aggregate_by_service(df, side):
    sub = df[df[side].str.contains(AIRPORT_RE)]
    out = {}
    for svc, grp in sub.groupby("Service"):
        out[svc] = {
            "jobs":  int(len(grp)),
            "total": float(grp["Total Price"].sum()),
        }
    return out


payload = {}
for label, path in FILES.items():
    df = parse(path)
    payload[label] = {
        "pickup":  aggregate_by_service(df, "Pick Up"),
        "dropoff": aggregate_by_service(df, "Drop Off"),
    }

(ROOT / "otp.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
print("Wrote otp.json")
for week, sides in payload.items():
    p_jobs = sum(v["jobs"] for v in sides["pickup"].values())
    d_jobs = sum(v["jobs"] for v in sides["dropoff"].values())
    p_tot  = sum(v["total"] for v in sides["pickup"].values())
    d_tot  = sum(v["total"] for v in sides["dropoff"].values())
    print(f"  {week}: pickup {p_jobs} jobs / {p_tot:,.2f} RON   "
          f"dropoff {d_jobs} jobs / {d_tot:,.2f} RON")
