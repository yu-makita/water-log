
# 学習済みLightGBMをCloudflare Worker用のJSONに変換する
import json
from pathlib import Path

import joblib

BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR.parent / "worker"


# 学習済みモデルをJSONとして出力する関数
def export_model():
    saved = joblib.load(BASE_DIR / "model.pkl")

    model = saved["model"]
    features = saved["features"]

    # LightGBMの木構造を取得
    model_data = model.booster_.dump_model()

    # Workerで必要な情報を保存
    exported = {
        "model_type": "lightgbm",
        "features": features,
        "trees": [
            tree["tree_structure"]
            for tree in model_data["tree_info"]
        ],
        "average_output": model_data.get("average_output", False),
    }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / "lightgbm_model.json"

    output_path.write_text(
        json.dumps(exported, ensure_ascii=False),
        encoding="utf-8"
    )

    print("JSON変換完了")
    print(f"保存先: {output_path}")
    print(f"特徴量数: {len(features)}")
    print(f"決定木の数: {len(exported['trees'])}")


if __name__ == "__main__":
    export_model()
