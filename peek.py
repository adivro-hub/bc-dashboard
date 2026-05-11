import pandas as pd
import os
import glob

folder = r"C:\Users\Adrian\Desktop\dashboard"

for f in sorted(glob.glob(os.path.join(folder, "Income Structure*.xls"))):
    print("=" * 80)
    print("FILE:", os.path.basename(f))
    print("=" * 80)
    try:
        xl = pd.ExcelFile(f, engine="xlrd")
        print("Sheets:", xl.sheet_names)
        for sn in xl.sheet_names:
            df = pd.read_excel(f, sheet_name=sn, engine="xlrd", header=None)
            print(f"--- Sheet: {sn} | shape: {df.shape} ---")
            print(df.head(40).to_string())
            print()
    except Exception as e:
        print("xlrd failed:", e)
        try:
            xl = pd.ExcelFile(f)
            print("Sheets:", xl.sheet_names)
            for sn in xl.sheet_names:
                df = pd.read_excel(f, sheet_name=sn, header=None)
                print(f"--- Sheet: {sn} | shape: {df.shape} ---")
                print(df.head(40).to_string())
                print()
        except Exception as e2:
            print("default failed:", e2)
