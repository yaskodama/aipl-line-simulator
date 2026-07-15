// tinyml.js —— 手首カメラ画像を分類する小型ニューラルネット（推論のみ）
// ===========================================================================
// 本物の TinyML。フレームワークは使わない（数十行の行列積だけ）ので、
// 実機の Raspberry Pi でも Xinu 上でもそのまま動く規模に収めてある。
//
//   入力  : 手首カメラの実レンダ画像 96x96 RGBA
//           → 中央を切り出して 8x8 に平均プーリング → RGB 正規化 = 192 次元
//   構造  : 192 → 12 (tanh) → 3 (softmax)
//   出力  : P(赤・立方体) / P(青・円柱) / P(緑・六角柱)
//
// 重み(tinyml_model.json)は rl/train_tinyml.py が実画像から学習して書き出す。
// 学習・推論・表示の 3 者が「同じ前処理」を使うよう、特徴抽出はここに一本化する。
// ===========================================================================

export const CLASSES = ['red', 'blue', 'green'];
export const LABELS = { red: '赤・立方体', blue: '青・円柱', green: '緑・六角柱' };
export const GRID = 8;                  // 8x8 に潰す
export const CROP = 0.62;               // 中央 62% を切り出す（把持点まわりだけ見る）
export const NFEAT = GRID * GRID * 3;   // 192

// ── 前処理：RGBA フレーム → 192 次元特徴 ────────────────────────────────
// 学習時と推論時で必ず同一の関数を通すこと（ここがズレると精度が出ない）。
export function features(frame) {
  const { res, rgba } = frame;
  const lo = Math.floor(res * (1 - CROP) / 2), hi = Math.ceil(res * (1 + CROP) / 2);
  const span = hi - lo, cell = span / GRID;
  const f = new Array(NFEAT).fill(0);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let r = 0, g = 0, b = 0, n = 0;
      const y0 = lo + Math.floor(gy * cell), y1 = lo + Math.floor((gy + 1) * cell);
      const x0 = lo + Math.floor(gx * cell), x1 = lo + Math.floor((gx + 1) * cell);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * res + x) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
        }
      }
      const k = (gy * GRID + gx) * 3;
      f[k] = r / n / 255; f[k + 1] = g / n / 255; f[k + 2] = b / n / 255;
    }
  }
  return f;
}

// ── 推論：192 → 12 (tanh) → 3 (softmax) ────────────────────────────────
export function infer(model, feat) {
  const { w1, b1, w2, b2, hidden } = model;
  const h = new Array(hidden);
  for (let j = 0; j < hidden; j++) {
    let s = b1[j];
    for (let i = 0; i < NFEAT; i++) s += w1[j * NFEAT + i] * feat[i];
    h[j] = Math.tanh(s);
  }
  const o = new Array(CLASSES.length);
  for (let k = 0; k < CLASSES.length; k++) {
    let s = b2[k];
    for (let j = 0; j < hidden; j++) s += w2[k * hidden + j] * h[j];
    o[k] = s;
  }
  const m = Math.max(...o);
  const ex = o.map(v => Math.exp(v - m));
  const sum = ex.reduce((a, b) => a + b, 0);
  const p = ex.map(v => v / sum);
  let best = 0;
  for (let k = 1; k < p.length; k++) if (p[k] > p[best]) best = k;
  return { label: CLASSES[best], conf: p[best], probs: p };
}

export async function loadModel(url = './aipl/tinyml_model.json') {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TinyML モデルを読めない: ${r.status}`);
  return r.json();
}
