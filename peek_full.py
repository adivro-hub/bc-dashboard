import pandas as pd

files = {
    "current": r"C:\Users\Adrian\Desktop\dashboard\Income Structure - 2026-05-11T110207.794.xls",
    "previous": r"C:\Users\Adrian\Desktop\dashboard\Income Structure - 2026-05-11T110214.270.xls",
}

for label, path in files.items():
    df = pd.read_excel(path, sheet_name="Sheet1", engine="xlrd", header=None)
    print("=" * 80)
    print(label, path)
    print("=" * 80)
    print(df.to_string())
    print()
