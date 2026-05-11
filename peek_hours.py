import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
import pandas as pd
from pathlib import Path

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")
files = [
    ROOT / "Hour Statistics (23).xlsx",
    ROOT / "Hour Statistics (24).xlsx",
]

for f in files:
    print("=" * 80)
    print(f.name)
    print("=" * 80)
    xl = pd.ExcelFile(f)
    print("sheets:", xl.sheet_names)
    for sn in xl.sheet_names:
        df = pd.read_excel(f, sheet_name=sn, header=None)
        print(f"--- {sn} | shape: {df.shape}")
        print(df.head(40).to_string())
        if len(df) > 40:
            print("...")
            print(df.tail(10).to_string())
        print()
