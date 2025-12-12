import pandas as pd
import os

file_path = r"ls-data\input\input.parquet"
if not os.path.exists(file_path):
    print(f"File not found: {file_path}")
else:
    df = pd.read_parquet(file_path)
    print("Columns:", df.columns.tolist())
    print("\nFirst 3 rows:")
    print(df.head(3))
