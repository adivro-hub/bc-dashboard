"""
Top clients leaderboards from Job Analogue.

Two views:
  * Retail   - rows where Account Number = 110000 (Public Account).
               Clients identified by Passenger Telephone.
               Phones that are empty or all-zero are dropped.
               Anonymised as Client #1 .. #N.
  * Corporate - rows where Account Number != 110000.
                Clients identified by Account Number itself (kept visible).
                Account Name is captured but will be stripped in --public build.

Metric per client (per week and combined):
  jobs     = count of Job Number
  total    = Σ Total Price
  earnings = Σ (Total Price - Driver Total Price)

Ranking: combined Σ Total Price desc.
Output: top_clients.json embedded by embed_data.py.
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
PUBLIC_ACCOUNT = 110000
TOP_N = 25
NEEDED = ["Account Number", "Account Name", "Job Number",
          "Passenger Telephone", "Total Price", "Driver Total Price"]


def normalise_phone(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    s = str(v).strip()
    if not s or s.lower() == "nan":
        return ""
    digits = re.sub(r"\D", "", s)
    if not digits or set(digits) == {"0"}:
        return ""
    return digits


def parse(path):
    df = pd.read_excel(path, sheet_name="Sheet1", engine="xlrd",
                       header=0, skiprows=3)
    df.columns = [str(c).strip() for c in df.columns]
    df = df[[c for c in NEEDED if c in df.columns]].dropna(how="all")
    df["_acc_n"] = pd.to_numeric(df["Account Number"], errors="coerce")
    df["Total Price"]        = pd.to_numeric(df["Total Price"], errors="coerce").fillna(0)
    df["Driver Total Price"] = pd.to_numeric(df["Driver Total Price"], errors="coerce").fillna(0)
    df["Account Name"] = df["Account Name"].fillna("").astype(str)
    df["phone"] = df["Passenger Telephone"].apply(normalise_phone)
    return df


def agg(df, key):
    g = df.groupby(key).agg(
        jobs=("Job Number", "count"),
        total=("Total Price", "sum"),
        driver=("Driver Total Price", "sum"),
    )
    return g.to_dict("index")


def build_leaderboard(cur_df, prev_df, key_field, value_to_label, base_label_field=None):
    """
    key_field: column to group by (e.g. 'phone' or '_acc_n').
    value_to_label: callable(key, info) -> dict of extra fields to include
                    in each output row (e.g. anonymised id or account info).
    """
    cur  = agg(cur_df,  key_field)
    prev = agg(prev_df, key_field)
    keys = set(cur) | set(prev)
    rows = []
    for k in keys:
        c = cur.get(k,  {"jobs":0,"total":0,"driver":0})
        p = prev.get(k, {"jobs":0,"total":0,"driver":0})
        rows.append({
            "_key": k,
            "cur_jobs":  int(c["jobs"]),
            "cur_total": float(c["total"]),
            "cur_earnings": float(c["total"]) - float(c["driver"]),
            "prev_jobs": int(p["jobs"]),
            "prev_total":float(p["total"]),
            "prev_earnings": float(p["total"]) - float(p["driver"]),
            "combined_jobs":  int(c["jobs"]) + int(p["jobs"]),
            "combined_total": float(c["total"]) + float(p["total"]),
            "combined_earnings": (float(c["total"]) - float(c["driver"]))
                                 + (float(p["total"]) - float(p["driver"])),
        })
    rows.sort(key=lambda r: r["combined_total"], reverse=True)
    top = rows[:TOP_N]
    for r in top:
        extra = value_to_label(r["_key"], r)
        r.update(extra)
        del r["_key"]
    return top, rows


# ------------------------------------------------------------------------
# Parse both weeks
# ------------------------------------------------------------------------
cur_df  = parse(FILES["current"])
prev_df = parse(FILES["previous"])

# ------------------------------------------------------------------------
# RETAIL — Public Account only, group by phone, anonymise
# ------------------------------------------------------------------------
cur_retail  = cur_df [(cur_df ["_acc_n"] == PUBLIC_ACCOUNT) & (cur_df ["phone"] != "")]
prev_retail = prev_df[(prev_df["_acc_n"] == PUBLIC_ACCOUNT) & (prev_df["phone"] != "")]

retail_top, retail_all = build_leaderboard(
    cur_retail, prev_retail,
    key_field="phone",
    value_to_label=lambda k, r: {"client_id": ""},   # filled by rank below
)
for i, r in enumerate(retail_top, start=1):
    r["client_id"] = f"Client #{i}"

# Context for retail
def total_revenue(df):
    return float(df["Total Price"].sum())

retail_ctx = {
    "cur_clients":  int(cur_retail ["phone"].nunique()),
    "prev_clients": int(prev_retail["phone"].nunique()),
    "cur_total":    total_revenue(cur_retail),
    "prev_total":   total_revenue(prev_retail),
}

# ------------------------------------------------------------------------
# CORPORATE — everything except Public Account, group by Account Number
# ------------------------------------------------------------------------
cur_corp  = cur_df [(cur_df ["_acc_n"].notna()) & (cur_df ["_acc_n"] != PUBLIC_ACCOUNT)]
prev_corp = prev_df[(prev_df["_acc_n"].notna()) & (prev_df["_acc_n"] != PUBLIC_ACCOUNT)]

# Build a name map: account number -> most-common Account Name across both weeks
name_map = {}
for df in (cur_corp, prev_corp):
    for accn, grp in df.groupby("_acc_n"):
        if accn not in name_map:
            names = [n for n in grp["Account Name"].tolist() if n and str(n).strip()]
            if names:
                # take the most common occurrence
                name_map[accn] = max(set(names), key=names.count)

corp_top, corp_all = build_leaderboard(
    cur_corp, prev_corp,
    key_field="_acc_n",
    value_to_label=lambda k, r: {
        "account_no":   int(k) if pd.notna(k) else "",
        "account_name": name_map.get(k, ""),
    },
)
corp_ctx = {
    "cur_clients":  int(cur_corp ["_acc_n"].nunique()),
    "prev_clients": int(prev_corp["_acc_n"].nunique()),
    "cur_total":    total_revenue(cur_corp),
    "prev_total":   total_revenue(prev_corp),
}

# ------------------------------------------------------------------------
# Output
# ------------------------------------------------------------------------
payload = {
    "retail":    {"top": retail_top, "context": retail_ctx},
    "corporate": {"top": corp_top,   "context": corp_ctx},
}
(ROOT / "top_clients.json").write_text(json.dumps(payload, ensure_ascii=False),
                                       encoding="utf-8")


def fm(v): return f"{v:,.2f}"
def fi(v): return f"{int(v):,}"

def print_top(title, top, ctx, label_field):
    print(f"\n{title}")
    hdr = f"{'Client':<32} | {'Cur jobs':>8} {'Cur Σ Total':>13} {'Cur Earn':>11} | " \
          f"{'Prev jobs':>9} {'Prev Σ Total':>14} {'Prev Earn':>11} | " \
          f"{'Σ jobs':>7} {'Σ Total':>11} {'Σ Earn':>11}"
    print(hdr); print("-" * len(hdr))
    tot_cj=tot_pj=0; tot_ct=tot_pt=tot_ce=tot_pe=0.0
    for r in top:
        lbl = label_field(r)[:32]
        print(f"{lbl:<32} | {fi(r['cur_jobs']):>8} {fm(r['cur_total']):>13} {fm(r['cur_earnings']):>11} | "
              f"{fi(r['prev_jobs']):>9} {fm(r['prev_total']):>14} {fm(r['prev_earnings']):>11} | "
              f"{fi(r['combined_jobs']):>7} {fm(r['combined_total']):>11} {fm(r['combined_earnings']):>11}")
        tot_cj+=r['cur_jobs']; tot_pj+=r['prev_jobs']
        tot_ct+=r['cur_total']; tot_pt+=r['prev_total']
        tot_ce+=r['cur_earnings']; tot_pe+=r['prev_earnings']
    print("-" * len(hdr))
    print(f"{'TOTAL Top 25':<32} | {fi(tot_cj):>8} {fm(tot_ct):>13} {fm(tot_ce):>11} | "
          f"{fi(tot_pj):>9} {fm(tot_pt):>14} {fm(tot_pe):>11} | "
          f"{fi(tot_cj+tot_pj):>7} {fm(tot_ct+tot_pt):>11} {fm(tot_ce+tot_pe):>11}")
    print(f"\nContext: cur {ctx['cur_clients']} clients / {fm(ctx['cur_total'])} RON   "
          f"prev {ctx['prev_clients']} / {fm(ctx['prev_total'])} RON   "
          f"Top 25 share: {tot_ct/ctx['cur_total']*100:.1f}% cur / {tot_pt/ctx['prev_total']*100:.1f}% prev")


print_top("TOP 25 RETAIL CLIENTS (Account 110000, by phone, anonymised)",
          retail_top, retail_ctx, lambda r: r["client_id"])
print_top("TOP 25 CORPORATE CLIENTS (all accounts except 110000)",
          corp_top, corp_ctx,
          lambda r: f"{r['account_no']} — {r['account_name']}" if r['account_name'] else str(r['account_no']))

print("\nWrote top_clients.json (retail anonymised; corporate keeps account number)")
