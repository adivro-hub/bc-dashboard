"""
Parse the two Income Structure xls files and emit a self-contained HTML dashboard
comparing the past week vs the week before.
"""
import json
import pandas as pd
from pathlib import Path

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")
CURRENT_FILE = ROOT / "Income Structure - 2026-05-11T110207.794.xls"   # 03.05 - 09.05
PREVIOUS_FILE = ROOT / "Income Structure - 2026-05-11T110214.270.xls"  # 26.04 - 02.05

SECTION_HEADERS = {
    "Sales": "sales",
    "Sales By Payment Type": "payment_type",
    "Sales by Customer Grade": "customer_grade",
    "Sales by Service": "service",
    "Sales by Fleet": "fleet",
    "Driver Login Time by Fleet (hours)": "driver_hours",
}

NUMERIC_COLS = ["No of Jobs", "Without VAT", "VAT", "Total", "Earnings"]


def to_num(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 0.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def parse_file(path: Path):
    df = pd.read_excel(path, sheet_name="Sheet1", engine="xlrd", header=None)

    # Period
    period_from = df.iloc[1, 2]
    period_to = df.iloc[2, 2]

    sections = {key: {} for key in SECTION_HEADERS.values()}
    current = None

    for i in range(5, len(df)):
        label = df.iloc[i, 0]
        if pd.isna(label):
            continue
        label = str(label).strip()

        if label in SECTION_HEADERS:
            current = SECTION_HEADERS[label]
            continue

        if current is None:
            continue

        # Skip total rows in itemised sections; we'll compute on the fly
        if label.lower().startswith("total"):
            continue

        row = {
            "jobs": to_num(df.iloc[i, 1]),
            "without_vat": to_num(df.iloc[i, 2]),
            "vat": to_num(df.iloc[i, 3]),
            "total": to_num(df.iloc[i, 4]),
            "earnings": to_num(df.iloc[i, 5]),
        }
        sections[current][label] = row

    return {
        "period_from": str(pd.Timestamp(period_from).date()),
        "period_to": str(pd.Timestamp(period_to).date()),
        "sections": sections,
    }


def compute_kpis(section_sales):
    sales_with_vat = section_sales.get("Sales with VAT", {})
    sales_no_vat = section_sales.get("Sales with No VAT", {})
    total_jobs = sales_with_vat.get("jobs", 0) + sales_no_vat.get("jobs", 0)
    total_without_vat = sales_with_vat.get("without_vat", 0) + sales_no_vat.get("without_vat", 0)
    total_vat = sales_with_vat.get("vat", 0) + sales_no_vat.get("vat", 0)
    total_total = sales_with_vat.get("total", 0) + sales_no_vat.get("total", 0)
    total_earnings = sales_with_vat.get("earnings", 0) + sales_no_vat.get("earnings", 0)
    avg_per_job = (total_total / total_jobs) if total_jobs else 0
    return {
        "jobs": total_jobs,
        "without_vat": total_without_vat,
        "vat": total_vat,
        "total": total_total,
        "earnings": total_earnings,
        "avg_per_job": avg_per_job,
    }


def main():
    current = parse_file(CURRENT_FILE)
    previous = parse_file(PREVIOUS_FILE)

    current["kpis"] = compute_kpis(current["sections"]["sales"])
    previous["kpis"] = compute_kpis(previous["sections"]["sales"])

    payload = {"current": current, "previous": previous}
    out_json = ROOT / "data.json"
    out_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {out_json}")
    print("Current week KPIs:", current["kpis"])
    print("Previous week KPIs:", previous["kpis"])


if __name__ == "__main__":
    main()
