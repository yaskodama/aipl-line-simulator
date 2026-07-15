import { solveIK, forward } from '../src/ik.js';
import * as L from '../src/layout.js';
const D = 180/Math.PI;

// ---- 1) 全ポーズの到達性と関節可動域 ----
function cyclePoses(ri, tier, slot) {
  const S = L.STATION, sp = L.slotPose(ri, tier, slot);
  const cs = L.polar(L.STATION_YAW, L.CARRY.u), cr = L.polar(L.RACKS[ri].yaw, L.CARRY.u);
  return [{ ...S, y: S.y + L.HOVER }, S, { x: cs.x, y: L.CARRY.y, z: cs.z }, { x: cr.x, y: L.CARRY.y, z: cr.z },
          { ...sp, y: sp.y + L.HOVER }, sp];
}
const lo=[9e9,9e9,9e9,9e9,9e9], hi=[-9e9,-9e9,-9e9,-9e9,-9e9];
let maxErr=0, maxReach=0, unreach=0, n=0;
for (let ri=0; ri<L.RACKS.length; ri++) for (let t=0; t<L.TIERS.length; t++) for (let s=0; s<L.SLOT_T.length; s++)
  for (const T of cyclePoses(ri,t,s)) {
    const { q, reach, reachable } = solveIK(T.x,T.y,T.z); n++;
    const p = forward(q); maxErr = Math.max(maxErr, Math.hypot(p.x-T.x,p.y-T.y,p.z-T.z));
    maxReach = Math.max(maxReach, reach); if (!reachable) unreach++;
    for (let i=0;i<5;i++){ lo[i]=Math.min(lo[i],q[i]*D); hi[i]=Math.max(hi[i],q[i]*D); }
  }
console.log(`■ 到達性: ポーズ ${n} 件 / 到達不能 ${unreach} / 最大リーチ率 ${(maxReach*100).toFixed(1)}% / IK誤差 ${maxErr.toExponential(1)}`);
console.log('■ 関節可動域と必要オフセット');
const NAME=['ID1 旋回','ID2 肩','ID3 肘','ID4 手首P','ID5 roll'];
const off = [];
for (let i=0;i<5;i++){
  const span = hi[i]-lo[i], mid = (hi[i]+lo[i])/2, o = Math.round(90-mid);
  off.push(o);
  console.log(`   ${NAME[i].padEnd(9)} ${lo[i].toFixed(1).padStart(7)}..${hi[i].toFixed(1).padStart(7)}° (幅${span.toFixed(1)}°)  offset=${String(o).padStart(4)} → サーボ ${(lo[i]+o).toFixed(0).padStart(4)}..${(hi[i]+o).toFixed(0).padStart(4)}  ${span<174?'✓':'✗ 180°超'}`);
}
console.log(`   → OFFSET = [${off.join(', ')}]`);

// ---- 2) 棚どうしの干渉（回転矩形 OBB の分離軸判定）----
function rackCorners(i) {
  const yaw = L.RACKS[i].yaw, c = L.polar(yaw, L.RACK_R);
  const ry = Math.atan2(c.x, c.z);                       // simulator.js と同じ向き
  const hw = L.RACK_W/2, dIn = L.RACK_Z.in, dOut = L.RACK_Z.out;
  return [[-hw,dIn],[hw,dIn],[hw,dOut],[-hw,dOut]].map(([lx,lz]) => ({
    x: c.x + lx*Math.cos(ry) + lz*Math.sin(ry), z: c.z - lx*Math.sin(ry) + lz*Math.cos(ry) }));
}
function overlap(A, B) {                                  // 分離軸定理
  for (const poly of [A, B]) for (let i=0;i<4;i++) {
    const p = poly[i], q = poly[(i+1)%4], ax = -(q.z-p.z), az = q.x-p.x;
    const proj = poly2 => poly2.map(v => v.x*ax + v.z*az);
    const a = proj(A), b = proj(B);
    if (Math.max(...a) < Math.min(...b) || Math.max(...b) < Math.min(...a)) return false;
  }
  return true;
}
console.log('■ 棚どうしの干渉');
let clash = 0;
for (let i=0;i<L.RACKS.length;i++) for (let j=i+1;j<L.RACKS.length;j++) {
  const hit = overlap(rackCorners(i), rackCorners(j));
  if (hit) clash++;
  console.log(`   ${L.RACKS[i].label} ↔ ${L.RACKS[j].label} : ${hit ? '✗ 重なっている' : '✓ 干渉なし'}`);
}

// ---- 3) 棚とコンベアの干渉 ----
const beltZ = [L.STATION.z - L.BELT.width/2, L.STATION.z + L.BELT.width/2];
console.log('■ 棚とコンベアの干渉');
for (let i=0;i<L.RACKS.length;i++) {
  const c = rackCorners(i), zmin = Math.min(...c.map(v=>v.z)), zmax = Math.max(...c.map(v=>v.z));
  const xmin = Math.min(...c.map(v=>v.x)), xmax = Math.max(...c.map(v=>v.x));
  const hit = zmin < beltZ[1] && zmax > beltZ[0] && xmin < L.BELT.x1 && xmax > L.BELT.x0;
  if (hit) clash++;
  console.log(`   ${L.RACKS[i].label} : z ${zmin.toFixed(2)}..${zmax.toFixed(2)} vs ベルト z ${beltZ[0].toFixed(2)}..${beltZ[1].toFixed(2)} → ${hit?'✗ 重なる':'✓ 干渉なし'}`);
}

// ---- 4) 搬送中のクリアランス ----
const carryBottom = L.CARRY.y - L.PART.height/2;
const shelfTop = Math.max(...L.TIERS.map(t=>t.top)) + L.PART.height;
const rackInner = L.RACK_R + L.TIERS[0].dr - L.DECK_D/2;
console.log('■ 旋回搬送のクリアランス');
console.log(`   運搬部品の下端 ${carryBottom.toFixed(2)} vs 棚上の部品 ${shelfTop.toFixed(2)} → ${carryBottom>shelfTop?`✓ ${(carryBottom-shelfTop).toFixed(2)}`:'✗ 干渉'}`);
console.log(`   引込半径 ${L.CARRY.u} vs 棚の最手前 ${rackInner.toFixed(2)} → ${L.CARRY.u<rackInner?`✓ ${(rackInner-L.CARRY.u).toFixed(2)}`:'✗ 干渉'}`);
// ---- 5) 奥段へ置くときのグリッパと背板のすき間 ----
// ID5 がハンド向きをワールド固定に保つため、指は常にワールド X 軸に沿って開く。
// 棚Aは半径方向がまさにワールド X なので、ここが最悪ケースになる。
const FINGER_OPEN_X = 0.30;              // 開いた指の把持点からの張り出し (simulator.js の GRIP_X.open)
const backFace = L.RACK_Z.out - 0.05;    // 背板の内側の面
const need = L.TIERS[1].dr + FINGER_OPEN_X;
console.log('■ 奥段へ置くときのグリッパと背板');
console.log(`   開いた指の外端 dr=${need.toFixed(2)} vs 背板の内面 dr=${backFace.toFixed(2)} → ${backFace > need ? `✓ ${(backFace-need).toFixed(2)} クリア` : '✗ 指が背板を突き抜ける'}`);
if (backFace <= need) clash++;

console.log(`\n${clash===0 && unreach===0 ? '✓ セル配置に干渉なし・全スロット到達可能' : `✗ 問題 ${clash+unreach} 件`}`);
