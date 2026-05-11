import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
import pandas as pd
from pathlib import Path

ROOT = Path(r"C:\Users\Adrian\Desktop\dashboard")
files = [
    ROOT / "Job Analogue 03.05.26 - 09.05.26.xls",
    ROOT / "Job Analogue 26.04.26 - 02.05.26.xls",
]

for f in files:
    print("=" * 80)
    print(f.name)
    print("=" * 80)
    try:
        xl = pd.ExcelFile(f, engine="xlrd")
        print("sheets:", xl.sheet_names)
        for sn in xl.sheet_names:
            df = pd.read_excel(f, sheet_name=sn, engine="xlrd", header=None, nrows=5)
            print(f"--- {sn} | preview shape {df.shape}")
            for i in range(min(5, len(df))):
                print(f"row {i}:", [str(x)[:40] for x in df.iloc[i].tolist()])
            print()
            full = pd.read_excel(f, sheet_name=sn, engine="xlrd")
            print("Full shape:", full.shape)
            print("Columns:", list(full.columns))
            print()
            print("dtypes:")
            print(full.dtypes)
            print()
            print("Sample row:")
            print(full.iloc[0].to_dict())
    except Exception as e:
        print("xlrd error:", e)
        # Could be a HTML disguised as .xls
        head = open(f, 'rb').read(400)
        print("head bytes:", head[:200])
