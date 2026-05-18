"""
Operational KPIs for the dashboard's second sheet.

Computes the indicators from the screenshot that we have data for:
  #1  Total login hours
  #2  Login hours / active car / day
  #4  Fleet utilisation %
  #5  Jobs per online hour
  #6  Unfilled rides - no supply (explicit cancel reasons only)
  #7  Average real time to pickup (ASAP urgency, DONE jobs)
  #8  Fulfilment rate (DONE / (DONE + CANCELLED))
  #9  Request-to-paid-ride conversion (== #8 for now)
 #10  Gross commission per week + monthly run-rate

Skipped (need extra data):
  #3  Active cars % - we have no total registered fleet size.
      Surfaced instead as 'Unique active vehicles' count.
"""
import sys, io, json, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import pandas as pd
from pathlib import Path

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")
JOB_FILES = {
    "current":  ROOT / "Job Analogue 03.05.26 - 09.05.26.xls",
    "previous": ROOT / "Job Analogue 26.04.26 - 02.05.26.xls",
}
HOURS = json.loads((ROOT / "hours.json").read_text(encoding="utf-8"))
INCOME = json.loads((ROOT / "data.json").read_text(encoding="utf-8"))

DAYS_PER_WEEK = 7
WEEKS_PER_MONTH = 4.345

# Supply-related cancel reasons. Match case-insensitively, partial.
SUPPLY_PATTERNS = [
    r"no cars available",
    r"serviciul .*indisponibil",
    r"nicio ma[sș]in[aă]",                # nicio masina ... disponibila
    r"nu vrea sa astepte",                # client doesn't want to wait (driver too far)
    r"sofer de la bv",                    # driver coming from Brasov etc.
]
SUPPLY_RE = re.compile("|".join(SUPPLY_PATTERNS), re.IGNORECASE)


def parse_jobs(path):
    df = pd.read_excel(path, sheet_name="Sheet1", engine="xlrd",
                       header=0, skiprows=3)
    df.columns = [str(c).strip() for c in df.columns]
    return df


def to_minutes(v):
    """Convert a time-like value ('HH:MM:SS' or datetime.time) to minutes."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if hasattr(v, "hour"):  # datetime.time or Timestamp
        return v.hour * 60 + v.minute + v.second / 60
    s = str(v).strip()
    if not s or s.lower() == "nan":
        return None
    # split on ":" then ignore subseconds
    parts = s.split(".")[0].split(":")
    try:
        if len(parts) == 3:
            h, m, sec = int(parts[0]), int(parts[1]), int(parts[2])
            return h * 60 + m + sec / 60
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
    except ValueError:
        return None
    return None


def compute_week(jobs_df, hours_block, income_kpis):
    online_hours = hours_block["derived"]["online_total"]
    util_avg     = hours_block["derived"]["util_avg"]

    # Universe filters
    done      = jobs_df[jobs_df["Status"] == "DONE"]
    cancelled = jobs_df[jobs_df["Status"] == "CANCELLED"]
    all_bookings = len(jobs_df)

    # #2 Login hours / active car / day
    # 'Active car' = unique Vehicle Reg Number that did at least one DONE job
    active_vehicles = done["Vehicle Reg Number"].dropna().astype(str).str.strip()
    active_vehicles = active_vehicles[active_vehicles != ""]
    unique_vehicles = active_vehicles.nunique()
    login_per_car_per_day = (online_hours / unique_vehicles / DAYS_PER_WEEK
                             if unique_vehicles else 0.0)

    # #5 Jobs per online hour
    jobs_per_online_hour = (len(done) / online_hours) if online_hours else 0.0

    # #6 Unfilled - no supply (explicit reasons only)
    reasons = cancelled["Cancel Reason"].fillna("").astype(str)
    supply_mask = reasons.str.contains(SUPPLY_RE, na=False)
    no_supply = int(supply_mask.sum())
    no_supply_pct_of_cancel = (no_supply / len(cancelled) * 100
                               if len(cancelled) else 0.0)

    # #7 Avg time to pickup (ASAP)
    asap_done = done[done["Urgency"].astype(str).str.upper() == "ASAP"]
    resp_minutes = asap_done["Response Time"].apply(to_minutes).dropna()
    avg_time_pickup_min = float(resp_minutes.mean()) if len(resp_minutes) else 0.0
    median_time_pickup_min = float(resp_minutes.median()) if len(resp_minutes) else 0.0

    # #8 Fulfilment rate
    fulfilment = (len(done) / (len(done) + len(cancelled)) * 100
                  if (len(done) + len(cancelled)) else 0.0)

    # #10 Gross commission
    total_price  = pd.to_numeric(done["Total Price"],        errors="coerce").fillna(0).sum()
    driver_price = pd.to_numeric(done["Driver Total Price"], errors="coerce").fillna(0).sum()
    commission   = float(total_price - driver_price)
    weekly_run_rate  = commission                # gross commission this week
    monthly_run_rate = commission * WEEKS_PER_MONTH

    return {
        "total_login_hours":       float(online_hours),
        "login_h_per_car_per_day": float(login_per_car_per_day),
        "unique_active_vehicles":  int(unique_vehicles),
        "fleet_utilisation_pct":   float(util_avg * 100),
        "jobs_per_online_hour":    float(jobs_per_online_hour),
        "no_supply_cancels":       no_supply,
        "no_supply_pct_of_cancel": float(no_supply_pct_of_cancel),
        "avg_time_to_pickup_min":  avg_time_pickup_min,
        "median_time_to_pickup_min": median_time_pickup_min,
        "asap_done_jobs":          int(len(asap_done)),
        "fulfilment_rate_pct":     float(fulfilment),
        "request_to_paid_pct":     float(fulfilment),  # same proxy until "paid" flag exists
        "done_jobs":               int(len(done)),
        "cancelled_jobs":          int(len(cancelled)),
        "total_bookings":          int(all_bookings),
        "total_price":             float(total_price),
        "driver_price":            float(driver_price),
        "gross_commission":        commission,
        "monthly_run_rate":        monthly_run_rate,
    }


out = {}
for label, path in JOB_FILES.items():
    df = parse_jobs(path)
    out[label] = compute_week(df, HOURS[label], INCOME[label]["kpis"])
    k = out[label]
    print(f"\n=== {label} ===")
    print(f"  #1 Total login hours       : {k['total_login_hours']:.0f}")
    print(f"  #2 Login h / car / day     : {k['login_h_per_car_per_day']:.2f}   "
          f"(unique active vehicles: {k['unique_active_vehicles']})")
    print(f"  #4 Fleet utilisation       : {k['fleet_utilisation_pct']:.1f}%")
    print(f"  #5 Jobs per online hour    : {k['jobs_per_online_hour']:.2f}")
    print(f"  #6 No-supply cancels       : {k['no_supply_cancels']}  "
          f"({k['no_supply_pct_of_cancel']:.1f}% of cancellations; "
          f"~92% of cancellations have no documented reason)")
    print(f"  #7 Avg time to pickup ASAP : {k['avg_time_to_pickup_min']:.1f} min  "
          f"(median {k['median_time_to_pickup_min']:.1f}; n={k['asap_done_jobs']})")
    print(f"  #8 Fulfilment rate         : {k['fulfilment_rate_pct']:.1f}%   "
          f"(DONE {k['done_jobs']} / total {k['done_jobs']+k['cancelled_jobs']})")
    print(f" #10 Gross commission        : {k['gross_commission']:,.2f} RON   "
          f"-> monthly run-rate {k['monthly_run_rate']:,.2f} RON")

(ROOT / "kpis.json").write_text(json.dumps(out), encoding="utf-8")
print("\nWrote kpis.json")
