import modelData from './lightgbm_model.json' with { type: 'json' };

const CATEGORIES = ['water', 'caffeine', 'soup', 'alcohol'];
const WINDOWS = [30, 60, 120, 240, 360];

// 日本時間の記録を日時に変換する関数
function parseTime(value) {
  if (typeof value !== 'string') return NaN;

  const text = value.trim();

  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(text)) {
    return Date.parse(text);
  }

  return Date.parse(text + '+09:00');
}

// LightGBMの決定木を評価する関数
function evaluateTree(node, values) {
  if (Object.prototype.hasOwnProperty.call(node, 'leaf_value')) {
    return node.leaf_value;
  }

  if (node.decision_type !== '<=') {
    throw new Error(`Unsupported tree split: ${node.decision_type}`);
  }

  const value = values[node.split_feature];

  if (value === null || !Number.isFinite(value)) {
    return evaluateTree(
      node.default_left ? node.left_child : node.right_child,
      values
    );
  }

  const goLeft = value <= Number(node.threshold);

  return evaluateTree(
    goLeft ? node.left_child : node.right_child,
    values
  );
}

// 現在時刻までの記録から特徴量を作る関数
function makeFeatures(entries, now) {
  const nowMs = parseTime(now);

  if (!Number.isFinite(nowMs)) {
    throw new Error('Invalid prediction time');
  }

  const records = entries
    .map(e => ({ ...e, time: parseTime(e.at) }))
    .filter(e => Number.isFinite(e.time) && e.time <= nowMs)
    .sort((a, b) => a.time - b.time);

  const urinations = records.filter(
    e => e.kind === 'small' || e.kind === 'both'
  );

  if (!urinations.length) {
    throw new Error('No urination records');
  }

  const last = urinations[urinations.length - 1];

  const jst = new Date(nowMs + 9 * 60 * 60000);
  const hour = jst.getUTCHours() + jst.getUTCMinutes() / 60;

  const amountMap = { '少': 1, '中': 2, '多': 3 };

  const features = {
    elapsed_minutes: (nowMs - last.time) / 60000,
    hour_sin: Math.sin(2 * Math.PI * hour / 24),
    hour_cos: Math.cos(2 * Math.PI * hour / 24),
    weekday: (jst.getUTCDay() + 6) % 7,
    previous_urge:
      last.urge == null || last.urge === ''
        ? NaN
        : Number(last.urge),
    previous_amount: amountMap[last.urineAmount] ?? NaN,
  };

  const drinks = records.filter(e => e.kind === 'water');

  for (const minutes of WINDOWS) {
    const start = nowMs - minutes * 60000;

    for (const category of CATEGORIES) {
      features[`${category}_${minutes}m`] = drinks
        .filter(
          e =>
            e.category === category &&
            e.time > start &&
            e.time <= nowMs
        )
        .reduce((sum, e) => sum + (Number(e.ml) || 0), 0);
    }
  }

  return features;
}

// 学習済みモデルで次回排尿までの残り時間を予測する関数
export function predictWithLightGBM(entries, now) {
  const features = makeFeatures(entries, now);

  const values = modelData.features.map(
    name => features[name] ?? NaN
  );

  let prediction = 0;

  for (const tree of modelData.trees) {
    prediction += evaluateTree(tree, values);
  }

  if (!Number.isFinite(prediction)) {
    throw new Error('Invalid model prediction');
  }

  return Math.max(0, prediction);
}
