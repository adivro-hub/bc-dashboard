"""
Parse Job Analogue exports for both weeks and emit jobs.json containing the
trimmed records needed for the interactive pivot.
"""
import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import pandas as pd
from pathlib import Path
from datetime import datetime, time

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")
FILES = {
    "current":  ROOT / "Job Analogue 03.05.26 - 09.05.26.xls",
    "previous": ROOT / "Job Analogue 26.04.26 - 02.05.26.xls",
}

NEEDED = [
    "Account Number", "Account Name", "Job Number", "Urgency", "Status",
    "Service", "Job Time", "Total Price", "Driver Total Price",
]


def hour_of(v):
    """Extract hour 0..23 from a Job Time cell. Returns None if unknown."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, time):
        return v.hour
    if isinstance(v, datetime):
        return v.hour
    if isinstance(v, pd.Timestamp):
        return v.hour
    s = str(v).strip()
    if not s or s.lower() == "nan":
        return None
    # Try common patterns "HH:MM:SS" or "YYYY-MM-DD HH:MM:SS"
    try:
        return pd.to_datetime(s).hour
    except Exception:
        return None


def to_num(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 0.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def parse(path: Path):
    # Header row is row 3 (0-indexed). skiprows=3 makes row 3 become the header.
    df = pd.read_excel(path, sheet_name="Sheet1", engine="xlrd",
                       header=0, skiprows=3)
    # Keep only needed cols (some headers have trailing spaces — strip them first)
    df.columns = [str(c).strip() for c in df.columns]
    keep = [c for c in NEEDED if c in df.columns]
    missing = set(NEEDED) - set(keep)
    if missing:
        print("WARN: missing columns:", missing)
    df = df[keep].copy()

    # Drop entirely empty rows (some exports leave a trailing blank)
    df = df.dropna(how="all")

    rows = []
    for _, r in df.iterrows():
        acc_no = r.get("Account Number")
        if pd.isna(acc_no) and pd.isna(r.get("Job Number")):
            continue
        rows.append({
            "account_no":   "" if pd.isna(acc_no) else str(int(acc_no)) if isinstance(acc_no, (int, float)) and float(acc_no).is_integer() else str(acc_no).strip(),
            "account_name": "" if pd.isna(r.get("Account Name")) else str(r["Account Name"]).strip(),
            "job_no":       "" if pd.isna(r.get("Job Number")) else str(r["Job Number"]).strip(),
            "urgency":      "" if pd.isna(r.get("Urgency")) else str(r["Urgency"]).strip(),
            "status":       "" if pd.isna(r.get("Status")) else str(r["Status"]).strip(),
            "service":      "" if pd.isna(r.get("Service")) else str(r["Service"]).strip(),
            "hour":         hour_of(r.get("Job Time")),
            "total":        to_num(r.get("Total Price")),
            "driver_total": to_num(r.get("Driver Total Price")),
        })
    return rows


out = {}
for label, path in FILES.items():
    out[label] = parse(path)
    print(f"{label}: {len(out[label])} rows")

# Quick distinct-value summary so we know filter cardinalities
for label, rows in out.items():
    accs = {(r['account_no'], r['account_name']) for r in rows}
    urg = {r['urgency'] for r in rows}
    sts = {r['status'] for r in rows}
    svc = {r['service'] for r in rows}
    hrs = {r['hour'] for r in rows}
    print(f"\n[{label}] accounts:{len(accs)}, urgency:{sorted(urg)}, status:{sorted(sts)}, services:{len(svc)}, hours:{sorted(h for h in hrs if h is not None)}")

(ROOT / "jobs.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
print("\nWrote jobs.json,", (ROOT / 'jobs.json').stat().st_size, "bytes")
