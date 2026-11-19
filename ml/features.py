# 排尿履歴から、予測時点を基準とした機械学習データを作成する
import numpy as np
import pandas as pd

WINDOWS = [30, 60, 120, 240, 360]
CATEGORIES = ["water", "caffeine", "soup", "alcohol"]


# D1の記録を日時順に整理する関数
def parse_entries(records):
    df = pd.DataFrame(records)

    if df.empty:
        return df

    df["at"] = pd.to_datetime(df["at"], errors="coerce")
    df = df.dropna(subset=["at"])

    return df.sort_values("at").reset_index(drop=True)


# 予測時点までの飲水量を集計する関数
def drink_features(df, current_time):
    drinks = df[df["kind"] == "water"]
    result = {}

    for minutes in WINDOWS:
        start = current_time - pd.Timedelta(minutes=minutes)

        recent = drinks[
            (drinks["at"] > start) &
            (drinks["at"] <= current_time)
        ]

        for category in CATEGORIES:
            selected = recent[recent["category"] == category]

            result[f"{category}_{minutes}m"] = float(
                pd.to_numeric(
                    selected["ml"], errors="coerce"
                ).fillna(0).sum()
            )

    return result


# 現在の状態から予測用特徴量を作成する関数
def make_features(df, current_time, last_urination):
    elapsed = (
        current_time - last_urination["at"]
    ).total_seconds() / 60

    hour = current_time.hour + current_time.minute / 60

    row = {
        "elapsed_minutes": elapsed,
        "hour_sin": np.sin(2 * np.pi * hour / 24),
        "hour_cos": np.cos(2 * np.pi * hour / 24),
        "weekday": current_time.weekday(),
        "previous_urge": pd.to_numeric(
            last_urination.get("urge"), errors="coerce"
        ),
        "previous_amount": {
            "少": 1, "中": 2, "多": 3
        }.get(last_urination.get("urine_amount"), np.nan),
    }

    row.update(drink_features(df, current_time))
    return row


# 過去の排尿間隔から仮想的な予測時点を作る関数
def build_training_data(records):
    df = parse_entries(records)

    if df.empty:
        return pd.DataFrame()

    urinations = df[
        df["kind"].isin(["small", "both"])
    ].reset_index(drop=True)

    rows = []

    for i in range(len(urinations) - 1):
        previous = urinations.iloc[i]
        next_urination = urinations.iloc[i + 1]

        start = previous["at"]
        end = next_urination["at"]

        interval = (end - start).total_seconds() / 60

        if interval <= 0 or interval > 1440:
            continue

        # 15分間隔で仮想的な予測時点を生成する
        prediction_times = pd.date_range(
            start=start,
            end=end,
            freq="15min",
            inclusive="left"
        )

        for current_time in prediction_times:
            remaining = (end - current_time).total_seconds() / 60

            row = make_features(df, current_time, previous)
            row["target_minutes"] = remaining

            # 同じ排尿間隔から作ったデータを識別する
            row["interval_id"] = i
            row["prediction_time"] = current_time

            rows.append(row)

    return pd.DataFrame(rows)


# 実際の予測時点の特徴量を作成する関数
def build_prediction_data(records, current_time=None):
    df = parse_entries(records)

    if df.empty:
        raise ValueError("記録がありません")

    urinations = df[
        df["kind"].isin(["small", "both"])
    ]

    if urinations.empty:
        raise ValueError("排尿記録がありません")

    if current_time is None:
        current_time = pd.Timestamp.now()

    current_time = pd.Timestamp(current_time)

    previous = urinations[
        urinations["at"] <= current_time
    ]

    if previous.empty:
        raise ValueError("予測時点以前の排尿記録がありません")

    row = make_features(df, current_time, previous.iloc[-1])

    return pd.DataFrame([row])