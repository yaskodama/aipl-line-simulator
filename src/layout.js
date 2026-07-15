// layout.js —— 作業セルの寸法（CG・IK・検証で共有する唯一の真実）
// ===========================================================================
// アーム基部をワールド原点に置き、
//   ・コンベア  : ID1 yaw = -55° の方向。部品はストッパで停止位置に保持される
//   ・棚(3台)   : ID1 yaw = 0° / 50° / 100° の扇状。色ごとに 1 台
// を全て DOFBOT の可動域（各サーボ 0..180°）内に収める。
//
// ここの数値を変えたら必ず `node test/cell.mjs` を通すこと。到達性・棚どうしの干渉・
// 搬送経路のクリアランス・グリッパと背板のすき間を一括で検証する。
// ===========================================================================
const D = Math.PI / 180;

// ワールド 1 単位 = 何 mm か。実機 DOFBOT の肩→肘リンクが 83mm、CG では 1.20 単位。
// 把持誤差などを実機スケールの mm で表示するために使う。
export const UNIT_MM = 83 / 1.20;        // ≒ 69.2 mm

// ── 部品（実機 DOFBOT が扱う 3cm 角ブロック相当 = 0.32 単位 ≒ 22mm）──────
export const PART = { size: 0.32, height: 0.32 };

// ── コンベア ──────────────────────────────────────────────────────────────
export const STATION_YAW = -55 * D;      // 停止位置の ID1 方向
export const STATION_U   = 1.45;         // 基部からの水平距離
export const STATION = {                 // 停止時の部品中心（ワールド）
  x: -STATION_U * Math.cos(STATION_YAW),
  y: 0.90,                               // ベルト上面 0.74 + 部品半分 0.16
  z:  STATION_U * Math.sin(STATION_YAW),
};
export const BELT = { y: 0.60, thick: 0.28, width: 0.86, x0: -3.6, x1: 0.85 };

// ── 棚（色別 3 台 × 雛壇 2 段 × 2 スロット = 12 スロット）────────────────
//   DOFBOT の可動範囲は狭い（肩から手首まで 2.40）。棚は
//     ・全スロットが届く距離に置く
//     ・扇状に並べても隣同士がぶつからない幅にする
//     ・ID1 の首振り総量（コンベア〜最遠スロット）を 180° 未満に収める
//   の 3 つを同時に満たす必要があり、幅 0.75 / 2 スロット / 50° 間隔が解。
export const RACK_R = 1.35;              // 基部から棚中心までの水平距離
export const RACK_W = 0.75;              // 棚の幅（接線方向）
export const DECK_D = 0.38;              // 棚板の奥行き
// 奥段のスロットと背板のすき間。ここが狭いと、奥段へ置くときに開いたグリッパの指
// (把持点から半径方向へ最大 0.30) が背板を突き抜ける。
export const BACK_GAP = 0.30;
export const TIERS = [
  { dr: -0.22, top: 0.40 },              // 手前段（低い）
  { dr: +0.22, top: 0.76 },              // 奥段（高い）… 手前段の部品(上端0.72)を越える高さ
];
export const SLOT_T = [-0.19, 0.19];     // 段内のスロット位置（ピッチ0.38 > 部品0.32）

export const RACKS = [
  { key: 'A', color: 'red',   yaw:   0 * D, hex: 0xef4444, label: '棚A · 赤' },
  { key: 'B', color: 'blue',  yaw:  50 * D, hex: 0x3b82f6, label: '棚B · 青' },
  { key: 'C', color: 'green', yaw: 100 * D, hex: 0x22c55e, label: '棚C · 緑' },
];

// ── 動作の高さ ────────────────────────────────────────────────────────────
export const HOVER = 0.239;               // 把持/設置の直上に構える高さ
export const CARRY = { u: 0.722, y: 1.539 };  // 搬送時は基部近くへ引き込んで高く保持
                                            // → 旋回中に棚や既設部品と絶対に干渉しない

// ── 各フェーズの所要時間[秒] ──────────────────────────────────────────────
// 強化学習 (rl/dofbot_rl.py) が学習した方策。6.30秒 → 5.16秒。手で書き換えず python3 rl/apply_policy.py で更新すること。
// HOVER / CARRY も方策パラメータなので、ここを変えたら必ず test/cell.mjs を通すこと。
export const T = {
  open: 0.195, inspect: 0.380, descend: 0.130, grasp: 0.195, lift: 0.363, swing: 1.631,
  over: 0.425, place: 0.143, release: 0.198, retreat: 0.141, home: 1.363,
};
export const CYCLE_SEC = Object.values(T).reduce((a, b) => a + b, 0);

// ── 位置ヘルパ ────────────────────────────────────────────────────────────
// yaw 方向・水平距離 u・接線オフセット tan のワールド座標。
// solveIK と同じ規約: yaw のとき手先は (-u cos yaw, ·, u sin yaw) 方向へ伸びる。
export function polar(yaw, u, tan = 0) {
  return {
    x: -u * Math.cos(yaw) + tan * Math.sin(yaw),
    z:  u * Math.sin(yaw) + tan * Math.cos(yaw),
  };
}

// 棚 rackIndex の段 tier・スロット slot に置いた部品中心のワールド座標
export function slotPose(rackIndex, tier, slot) {
  const r = RACK_R + TIERS[tier].dr;
  const p = polar(RACKS[rackIndex].yaw, r, SLOT_T[slot]);
  return { x: p.x, y: TIERS[tier].top + PART.height / 2, z: p.z };
}

export const SLOTS_PER_RACK = TIERS.length * SLOT_T.length;   // 4

// 棚の footprint（棚ローカルの半径方向。CG・干渉検証の両方がこれを使う）
export const RACK_Z = {
  in:  TIERS[0].dr - DECK_D / 2,
  out: TIERS[TIERS.length - 1].dr + DECK_D / 2 + BACK_GAP,
};
