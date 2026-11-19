# D1からエクスポートしたSQLファイルを読み込む
import sqlite3
from pathlib import Path
from features import build_training_data

BASE_DIR = Path(__file__).resolve().parent


# SQLファイルから排尿・飲水記録を取得する関数
def load_entries():
    sql_path = BASE_DIR / "data.sql"
    sql = sql_path.read_text(encoding="utf-8")

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row

    try:
        conn.executescript(sql)

        rows = conn.execute(
            "SELECT * FROM entries ORDER BY at"
        ).fetchall()

        return [dict(row) for row in rows]
    finally:
        conn.close()


# 学習用データを作成して確認する関数
def main():
    records = load_entries()
    print(f"取得した記録数: {len(records)}件")

    training_data = build_training_data(records)
    print(f"学習データ数: {len(training_data)}件")

    if not training_data.empty:
        print(training_data.head().to_string(index=False))


if __name__ == "__main__":
    main()