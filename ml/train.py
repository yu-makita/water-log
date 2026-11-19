# 現在から次の排尿までの時間をLightGBMで学習する
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np

from load_data import load_entries
from features import build_training_data

BASE_DIR = Path(__file__).resolve().parent

DROP_COLUMNS = [
    "target_minutes",
    "interval_id",
    "prediction_time",
]


# 排尿間隔ごとに時系列分割してモデルを評価する関数
def evaluate_model(data, params):
    interval_ids = sorted(data["interval_id"].unique())

    if len(interval_ids) < 5:
        print("評価用の排尿間隔が不足しているため、精度評価を保留します。")
        return

    split = max(1, int(len(interval_ids) * 0.8))

    train_ids = interval_ids[:split]
    test_ids = interval_ids[split:]

    train = data[data["interval_id"].isin(train_ids)]
    test = data[data["interval_id"].isin(test_ids)]

    features = [
        c for c in data.columns
        if c not in DROP_COLUMNS
    ]

    model = lgb.LGBMRegressor(**params)
    model.fit(train[features], train["target_minutes"])

    predicted = model.predict(test[features])
    actual = test["target_minutes"].to_numpy()

    mae = np.mean(np.abs(actual - predicted))

    print(f"未使用データでの平均絶対誤差: {mae:.1f}分")


# 全記録からモデルを学習して保存する関数
def train_model():
    records = load_entries()
    data = build_training_data(records)

    print(f"取得した記録数: {len(records)}件")
    print(f"学習データ数: {len(data)}件")

    if len(data) < 2:
        print("学習データが不足しています。")
        return

    features = [
        c for c in data.columns
        if c not in DROP_COLUMNS
    ]

    X = data[features]
    y = data["target_minutes"]

    params = {
        "n_estimators": 100,
        "learning_rate": 0.05,
        "num_leaves": 7,
        "max_depth": 4,
        "min_child_samples": 2,
        "verbosity": -1,
        "random_state": 42,
    }

    evaluate_model(data, params)

    model = lgb.LGBMRegressor(**params)
    model.fit(X, y)

    predictions = model.predict(X)
    mae = np.mean(np.abs(y - predictions))

    print("学習完了")
    print(f"学習データ上の平均絶対誤差: {mae:.1f}分")

    joblib.dump(
        {
            "model": model,
            "features": features,
        },
        BASE_DIR / "model.pkl"
    )

    print("モデルを ml/model.pkl に保存しました。")


if __name__ == "__main__":
    train_model()