// ik.js —— Yahboom DOFBOT (6DOF) の順/逆運動学
// ===========================================================================
// 実機 DOFBOT のリンク構成をワールド単位へスケールしたもの。
//   ID1 ベース旋回(yaw, Y軸) → ID2 肩(Z軸) → ID3 肘(Z軸) → ID4 手首ピッチ(Z軸)
//   → ID5 手首回転(roll, Y軸) → ID6 グリッパ
// ID5 の回転軸は手先方向と一直線なので手先位置に寄与しない。よって位置決めは
// 「ベース旋回 + 3リンク平面アーム」に分解できる。
//
// 平面内の角度は +Y(真上)からの反時計回り。Three.js の rotation.z が +φ のとき
// ローカル (0,L,0) は (-L sinφ, L cosφ, 0) へ移るため、リーチ方向はローカル -X。
// ===========================================================================

export const GEO = {
  baseX: 0, baseZ: 0,
  j1Y: 0.30,          // armRoot → ID1(ベース旋回)
  shoulderY: 0.75,    // ID1 → ID2(肩)
  L1: 1.20,           // ID2(肩)   → ID3(肘)
  L2: 1.20,           // ID3(肘)   → ID4(手首ピッチ)
  L3: 1.05,           // ID4       → グリッパ把持点(gripTip)
};
GEO.shoulderY_W = GEO.j1Y + GEO.shoulderY;   // 肩のワールド高さ = 1.05
GEO.planarMax = GEO.L1 + GEO.L2;             // 肩から手首までの最大距離 = 2.40

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── 逆運動学：ワールド目標点 (tx,ty,tz) を「真上から掴む」姿勢で解く ─────────
//   工具軸を鉛直下向き(A3=π)に固定するので、手首(ID4)は目標の真上 L3 の位置。
//   戻り値 q = [yaw(ID1), 肩(ID2), 肘(ID3), 手首ピッチ(ID4), 手首回転(ID5)]
export function solveIK(tx, ty, tz) {
  const { L1, L2, L3, shoulderY_W, planarMax } = GEO;
  const dx = tx - GEO.baseX, dz = tz - GEO.baseZ;
  const u = Math.hypot(dx, dz);                 // 旋回面内での水平リーチ量
  const yaw = u < 1e-6 ? 0 : Math.atan2(dz, -dx);

  // 手首中心（肩を原点とする平面座標。u が伸び方向, v が高さ方向）
  let wu = u, wv = (ty - shoulderY_W) + L3;
  const d0 = Math.hypot(wu, wv);
  const limit = planarMax * 0.995;              // 完全伸びきり(特異点)は避ける
  const reachable = d0 <= limit;
  if (!reachable && d0 > 1e-6) { const k = limit / d0; wu *= k; wv *= k; }

  const d = Math.min(d0, limit);
  const cosB = clamp((d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
  const beta = Math.acos(cosB);                                     // 肘の曲げ量(>=0 = 肘上げ)
  const A1 = Math.atan2(wu, wv) - Math.atan2(L2 * Math.sin(beta), L1 + L2 * Math.cos(beta));
  const A2 = A1 + beta;                                             // 肘の累積角
  const A3 = Math.PI;                                               // 工具軸 = 真下

  return {
    q: [yaw, A1, beta, A3 - A2, yaw],   // ID5 は yaw を打ち消し、ハンド向きをワールド固定に保つ
    reach: d0 / planarMax,
    reachable,
  };
}

// ── 順運動学：関節角から把持点(gripTip)のワールド座標を求める（検証用）──────
export function forward(q) {
  const { L1, L2, L3, shoulderY_W } = GEO;
  const [yaw, p1, p2, p3] = q;
  const A1 = p1, A2 = p1 + p2, A3 = p1 + p2 + p3;
  const x = -(L1 * Math.sin(A1) + L2 * Math.sin(A2) + L3 * Math.sin(A3));   // 旋回面ローカル X
  const y = L1 * Math.cos(A1) + L2 * Math.cos(A2) + L3 * Math.cos(A3);
  return {
    x: GEO.baseX + x * Math.cos(yaw),
    y: shoulderY_W + y,
    z: GEO.baseZ - x * Math.sin(yaw),
  };
}

// ── 関節角 → 実機バスサーボ指令角 [0..180] ────────────────────────────────
//   Arm_serial_servo_write(id, angle, ms) に渡す角度。
//   OFFSET は「CG のゼロ姿勢 → 実機サーボ角」の取付較正値。作業セル内の全ポーズ
//   (コンベア停止位置・棚18スロット・搬送姿勢) が 0..180 に収まるよう決めてある。
//   ID3 だけ符号が逆なのは、肘の曲げ量 beta が常に正で定義されているため。
const DEG = 180 / Math.PI;
const OFFSET = [63, 85, 1, -2, 63];        // ID1..ID5（作業セルの全ポーズが 0..180 に入るよう決定）
export const SERVO_LIMIT = { lo: 0, hi: 180 };

export function servoAngles(q, grip) {
  const raw = [
    OFFSET[0] + q[0] * DEG,   // ID1 ベース旋回
    OFFSET[1] + q[1] * DEG,   // ID2 肩
    OFFSET[2] + q[2] * DEG,   // ID3 肘（曲げ量）
    OFFSET[3] + q[3] * DEG,   // ID4 手首ピッチ
    OFFSET[4] + q[4] * DEG,   // ID5 手首回転
    30 + grip * 150,          // ID6 グリッパ : 30=全閉 180=全開
  ];
  return raw.map(a => clamp(Math.round(a * 10) / 10, SERVO_LIMIT.lo, SERVO_LIMIT.hi));
}

// 可動域を超えた指令が出ていないか（超えていれば実機なら動作が破綻する）
export function servoOutOfRange(q, grip) {
  const raw = [
    OFFSET[0] + q[0] * DEG, OFFSET[1] + q[1] * DEG, OFFSET[2] + q[2] * DEG,
    OFFSET[3] + q[3] * DEG, OFFSET[4] + q[4] * DEG, 30 + grip * 150,
  ];
  return raw.map((a, i) => (a < SERVO_LIMIT.lo || a > SERVO_LIMIT.hi) ? i + 1 : 0).filter(Boolean);
}
