"""
Parse Registration Info xls files and emit registrations.json.
Each file is a list of new registrations; we infer which week from the
'Created At' date range so the user does not have to label them.
"""
import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import pandas as pd
from pathlib import Path
from datetime import datetime

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")
FILES = [
    ROOT / "Registration Info (48).xls",
    ROOT / "Registration Info (49).xls",
]

# The two periods we already work with
PERIODS = {
    "current":  (datetime(2026, 5, 3),  datetime(2026, 5, 10)),   # 03..09 May (end exclusive)
    "previous": (datetime(2026, 4, 26), datetime(2026, 5, 3)),    # 26 Apr..02 May (end exclusive)
}


def parse(path):
    df = pd.read_excel(path, sheet_name="Export", engine="xlrd", header=0)
    df.columns = [str(c).strip() for c in df.columns]
    if "Created At" not in df.columns:
        raise RuntimeError(f"'Created At' column missing in {path.name}: {df.columns.tolist()}")
    df["Created At"] = pd.to_datetime(df["Created At"], errors="coerce")
    df = df.dropna(subset=["Created At"])
    return df


def assign_period(ts):
    for key, (start, end) in PERIODS.items():
        if start <= ts < end:
            return key
    return None


def main():
    all_rows = []
    per_file = []
    for f in FILES:
        df = parse(f)
        per_file.append({
            "file": f.name,
            "rows": len(df),
            "min": str(df["Created At"].min()),
            "max": str(df["Created At"].max()),
        })
        all_rows.append(df.assign(_src=f.name))
    big = pd.concat(all_rows, ignore_index=True)

    # Drop exact duplicate (Email, Created At) across the two source files just in case
    before = len(big)
    big = big.drop_duplicates(subset=["Email", "Created At"])
    deduped = before - len(big)

    big["_period"] = big["Created At"].apply(assign_period)
    summary = {}
    for key in ("current", "previous"):
        sub = big[big["_period"] == key]
        # By status (New / Current)
        status_counts = sub["Status"].fillna("(unknown)").value_counts().to_dict()
        # Daily breakdown
        daily = (sub.assign(d=sub["Created At"].dt.date)
                    .groupby("d").size()
                    .sort_index().to_dict())
        summary[key] = {
            "total": int(len(sub)),
            "by_status": {str(k): int(v) for k, v in status_counts.items()},
            "daily":     {str(k): int(v) for k, v in daily.items()},
        }
    out_of_range = int((big["_period"].isna()).sum())

    payload = {
        "summary": summary,
        "files": per_file,
        "deduped_rows_dropped": int(deduped),
        "rows_outside_either_week": out_of_range,
    }
    print(json.dumps(payload, indent=2))
    (ROOT / "registrations.json").write_text(json.dumps(payload), encoding="utf-8")
    print("Wrote registrations.json")


if __name__ == "__main__":
    main()
