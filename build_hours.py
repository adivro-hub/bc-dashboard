"""
Parse Hour Statistics xlsx files and emit hours.json.

For each week we extract a 168-point timeline (Mon 00 .. Sun 23) for these metrics:
  online, doing_job, on_break, in_rank, empty, going_home, logged_off,
  jobs_asap, jobs_prebook, jobs_cancelled, jobs_completed.

Plus an hour-of-day rollup (0..23) averaged across the 7 days.

Highlighted derived metrics:
  available = online - on_break
  busy      = doing_job
  util      = busy / available  (when available > 0)
"""
import sys, io, json, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import pandas as pd
from pathlib import Path
from datetime import datetime

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")
FILES = {
    "current":  ROOT / "Hour Statistics (23).xlsx",
    "previous": ROOT / "Hour Statistics (24).xlsx",
}

METRIC_KEY = {
    "Number of jobs booked ASAP": "jobs_asap",
    "Number of jobs booked Preebook": "jobs_prebook",
    "Number of cancelled jobs": "jobs_cancelled",
    "Number of completed jobs": "jobs_completed",
    "Number of vehicles online": "online",
    "Number of vehicles doing job": "doing_job",
    "Number of vehicles in rank": "in_rank",
    "Number of vehicles empty": "empty",
    "Number of vehicles on break": "on_break",
    "Number of vehicles going home": "going_home",
    "Number of vehicles logged off": "logged_off",
    "Number of vehicles with status unknown": "unknown",
}

HOURLY_HEADER_RE = re.compile(r"^(\d{2}/\d{2}/\d{2}) (\d{2}):00$")
DAILY_HEADER_RE  = re.compile(r"^(\d{2}/\d{2}/\d{2})$")


def to_num(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 0.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def parse(path: Path):
    df = pd.read_excel(path, sheet_name="Average", header=None)
    # Row 0: header row containing "DD/MM/YYYY - DD/MM/YYYY" then per-hour timestamps
    headers = [str(x) if not pd.isna(x) else "" for x in df.iloc[0].tolist()]
    # Build list of (col_idx, dt) for hourly columns
    hourly_cols = []
    for i, h in enumerate(headers):
        m = HOURLY_HEADER_RE.match(h.strip())
        if m:
            d = datetime.strptime(m.group(1), "%d/%m/%y")
            hour = int(m.group(2))
            ts = d.replace(hour=hour)
            hourly_cols.append((i, ts))

    # Row labels in column 0
    label_to_row = {}
    for r in range(1, len(df)):
        lbl = df.iloc[r, 0]
        if isinstance(lbl, str):
            label_to_row[lbl.strip()] = r

    # Period from first header
    period = headers[0]
    series = {key: [] for key in METRIC_KEY.values()}
    timestamps = [ts.isoformat() for _, ts in hourly_cols]

    for nice, key in METRIC_KEY.items():
        row_idx = label_to_row.get(nice)
        if row_idx is None:
            print(f"WARN missing row '{nice}' in {path.name}")
            series[key] = [0.0] * len(hourly_cols)
            continue
        series[key] = [to_num(df.iloc[row_idx, ci]) for ci, _ in hourly_cols]

    # Hour-of-day rollup (sum across 7 days, then divide by 7 for an average)
    hour_of_day = {key: [0.0] * 24 for key in METRIC_KEY.values()}
    counts = [0] * 24
    for idx, (_, ts) in enumerate(hourly_cols):
        h = ts.hour
        counts[h] += 1
        for key in METRIC_KEY.values():
            hour_of_day[key][h] += series[key][idx]
    for key in METRIC_KEY.values():
        hour_of_day[key] = [hour_of_day[key][h] / counts[h] if counts[h] else 0 for h in range(24)]

    # Convenience derived totals
    derived = {
        "available_total": sum(series["online"]) - sum(series["on_break"]),
        "busy_total": sum(series["doing_job"]),
        "online_total": sum(series["online"]),
        "on_break_total": sum(series["on_break"]),
    }
    derived["util_avg"] = (derived["busy_total"] / derived["available_total"]) if derived["available_total"] else 0
    derived["peak_available"] = max(o - b for o, b in zip(series["online"], series["on_break"]))
    derived["peak_busy"] = max(series["doing_job"])

    return {
        "period": period,
        "timestamps": timestamps,
        "hourly": series,
        "by_hour_of_day": hour_of_day,
        "derived": derived,
    }


out = {}
for label, path in FILES.items():
    out[label] = parse(path)
    d = out[label]["derived"]
    print(f"{label}: {out[label]['period']}  "
          f"peak_avail={d['peak_available']}  peak_busy={d['peak_busy']}  "
          f"avg_util={d['util_avg']*100:.1f}%")

(ROOT / "hours.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
print("Wrote hours.json,", (ROOT / 'hours.json').stat().st_size, "bytes")
