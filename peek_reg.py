import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
import pandas as pd
from pathlib import Path

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")
files = [
    ROOT / "Registration Info (48).xls",
    ROOT / "Registration Info (49).xls",
]
for f in files:
    print("=" * 80); print(f.name); print("=" * 80)
    xl = pd.ExcelFile(f, engine="xlrd")
    print("sheets:", xl.sheet_names)
    for sn in xl.sheet_names:
        df = pd.read_excel(f, sheet_name=sn, engine="xlrd", header=None)
        print(f"--- {sn} | shape: {df.shape}")
        print(df.head(15).to_string())
        if len(df) > 15:
            print("...")
            print(df.tail(5).to_string())
        print()
