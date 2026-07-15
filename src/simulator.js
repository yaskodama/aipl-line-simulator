import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.164.1/+esm';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/controls/OrbitControls.js/+esm';
import { GEO, solveIK, servoAngles, servoOutOfRange } from './ik.js';
import * as L from './layout.js';

// ── Yahboom DOFBOT (6DOF / Raspberry Pi 5) 忠実CG ──────────────────────────
//   ID1 ベース旋回 / ID2 肩 / ID3 肘 / ID4 手首ピッチ / ID5 手首回転 / ID6 グリッパ
//   姿勢はすべて逆運動学(ik.js)で解く。ハードコードした関節角は無い。
//   把持した部品はグリッパに剛体固定(attach)され、色の一致する棚のスロットへ置かれる。
const COL = {
  chassis: 0x14171d, bracket: 0x252a33, servo: 0x1f5fd0, servoDark: 0x184aa0,
  horn: 0xc3cad6, finger: 0x111318, camera: 0x0c0e12, lens: 0x2dd4bf,
};
const sc = x => x * x * x * (10 - 15 * x + 6 * x * x);   // min-jerk 補間

// 部品の種類（色 → 形状・寸法・掴み代）
export const KINDS = {
  red:   { hex: 0xef4444, half: 0.160, label: '赤・立方体' },
  blue:  { hex: 0x3b82f6, half: 0.150, label: '青・円柱' },
  green: { hex: 0x22c55e, half: 0.156, label: '緑・六角柱' },
};
const FINGER_T = 0.07;                  // 指の厚み
const GRIP_X = { closed: 0.09, open: 0.30 };
// 開度 t(0..1) → 指の中心 x。掴み代 half の部品は指の内面が触れる t で閉じる。
const gripX = t => GRIP_X.closed + t * (GRIP_X.open - GRIP_X.closed);
const graspT = half => (half + FINGER_T / 2 - GRIP_X.closed) / (GRIP_X.open - GRIP_X.closed);

export class LineSimulator {
  constructor(container) {
    this.container = container;
    this.parts = [];
    this.running = false;
    this.speed = 1;
    this.spawnTimer = 0;
    this.cycle = null;
    this.held = null;                 // 把持中の部品
    this.onPhase = null;              // AIPL のどの行を実行中か
    this.onServo = null;              // サーボ指令角
    this.onServoFault = null;         // 可動域を超えた指令が出た
    this.q = [0, 0, 0, 0, 0];
    this.qPrev = [0, 0, 0, 0, 0];
    this.grip = 1;
    this.gripPrev = 1;
    this.activeServo = -1;
    this.stationPart = null;          // ストッパで停止中の部品
    this.racks = [];                  // { key,color,group,slots:[{pos,part}] }
    this.HOME = solveIK(...homeTarget()).q;
    this.initThree();
  }

  initThree() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0f18);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(4.0, 3.4, -2.7);   // セルの空いている方位から作業域全体を見る
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(-0.45, 0.90, 0.25);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x1e293b, 1.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(4, 9, -6); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -6; key.shadow.camera.right = 6;
    key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x93c5fd, 0.55); fill.position.set(-5, 4, 4); this.scene.add(fill);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24),
      new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.scene.add(floor);
    const grid = new THREE.GridHelper(24, 48, 0x334155, 0x1f2b3a); grid.position.y = 0.002; this.scene.add(grid);

    this.buildConveyor(); this.buildRacks(); this.buildArm();
    this.applyJoints(this.HOME); this.setGrip(1);
    this.resize(); window.addEventListener('resize', () => this.resize());
  }

  // ── コンベア（ストッパ付き。部品は停止位置でアームを待つ）────────────────
  buildConveyor() {
    const len = L.BELT.x1 - L.BELT.x0, cx = (L.BELT.x0 + L.BELT.x1) / 2;
    const belt = new THREE.Mesh(new THREE.BoxGeometry(len, L.BELT.thick, L.BELT.width),
      new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.2, roughness: 0.85 }));
    belt.position.set(cx, L.BELT.y, L.STATION.z); belt.receiveShadow = true; this.scene.add(belt);
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, 0.05),
        new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.6 }));
      rail.position.set(cx, L.BELT.y + 0.19, L.STATION.z + s * (L.BELT.width / 2 + 0.02)); this.scene.add(rail);
    }
    for (let x = L.BELT.x0 + 0.25; x < L.BELT.x1; x += 0.42) {
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, L.BELT.width + 0.1, 14),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.7 }));
      roller.rotation.x = Math.PI / 2; roller.position.set(x, L.BELT.y + 0.15, L.STATION.z); this.scene.add(roller);
    }
    for (const x of [L.BELT.x0 + 0.4, cx, L.BELT.x1 - 0.4]) for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, L.BELT.y - 0.14, 0.09),
        new THREE.MeshStandardMaterial({ color: 0x334155 }));
      leg.position.set(x, (L.BELT.y - 0.14) / 2, L.STATION.z + s * (L.BELT.width / 2 - 0.08));
      leg.castShadow = true; this.scene.add(leg);
    }
    // ストッパ（この位置で部品を止め、アームの到着を待つ）
    const stop = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, L.BELT.width),
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x7c2d12, emissiveIntensity: 0.5 }));
    stop.position.set(L.STATION.x + 0.19, L.BELT.y + 0.27, L.STATION.z);
    this.stopper = stop; this.scene.add(stop);
  }

  // ── 色別の棚（雛壇 2 段 × 3 スロット）────────────────────────────────────
  buildRacks() {
    for (let i = 0; i < L.RACKS.length; i++) {
      const spec = L.RACKS[i];
      const g = new THREE.Group();
      const c = L.polar(spec.yaw, L.RACK_R);
      g.position.set(c.x, 0, c.z);
      g.rotation.y = Math.atan2(c.x, c.z);      // ローカル +Z が基部の外向き（＝奥）
      this.scene.add(g);

      const frameMat = new THREE.MeshStandardMaterial({ color: 0x3f4a5c, metalness: 0.45, roughness: 0.65 });
      const deckMat = new THREE.MeshStandardMaterial({ color: 0x59657a, roughness: 0.8 });
      const paintMat = new THREE.MeshStandardMaterial({ color: spec.hex, emissive: spec.hex, emissiveIntensity: 0.25 });
      const W = L.RACK_W, DD = L.DECK_D;     // 幅・棚板の奥行き（layout.js と共有）
      const zIn = L.RACK_Z.in, zOut = L.RACK_Z.out;   // 棚全体の手前/奥（layout.js と共有）
      const depth = zOut - zIn, zMid = (zIn + zOut) / 2;
      const slots = [];

      // 雛壇型のパーツラック。手前側には段より上に出る構造を置かない
      // （グリッパは把持点から半径方向へ 0.30 張り出すので、手前に柱があると必ず当たる）
      const base = new THREE.Mesh(new THREE.BoxGeometry(W, 0.05, depth), frameMat);
      base.position.set(0, 0.025, zMid); base.castShadow = true; base.receiveShadow = true; g.add(base);

      for (let t = 0; t < L.TIERS.length; t++) {
        const tier = L.TIERS[t];
        const zFront = tier.dr - DD / 2;
        // 蹴込み（段の正面。ここが色の主張面になる）
        const riserBottom = t === 0 ? 0 : L.TIERS[t - 1].top;
        const riser = new THREE.Mesh(new THREE.BoxGeometry(W, tier.top - riserBottom, 0.04), paintMat);
        riser.position.set(0, (tier.top + riserBottom) / 2, zFront); riser.castShadow = true; g.add(riser);
        // 棚板（受け皿）
        const deck = new THREE.Mesh(new THREE.BoxGeometry(W, 0.05, DD), deckMat);
        deck.position.set(0, tier.top - 0.025, tier.dr);
        deck.castShadow = true; deck.receiveShadow = true; g.add(deck);
        // 側の縁（受け皿のふち）
        for (const s of [-1, 1]) {
          const lip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, DD), frameMat);
          lip.position.set(s * (W / 2 - 0.015), tier.top + 0.03, tier.dr); g.add(lip);
        }
        // スロット枠
        for (let s = 0; s < L.SLOT_T.length; s++) {
          const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34),
            new THREE.MeshBasicMaterial({ color: spec.hex, transparent: true, opacity: 0.25 }));
          mark.rotation.x = -Math.PI / 2;
          mark.position.set(L.SLOT_T[s], tier.top + 0.004, tier.dr); g.add(mark);
          const ring = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.34, 0.34)),
            new THREE.LineBasicMaterial({ color: spec.hex, transparent: true, opacity: 0.9 }));
          ring.rotation.x = -Math.PI / 2; ring.position.copy(mark.position); g.add(ring);
          slots.push({ tier: t, slot: s, pos: L.slotPose(i, t, s), part: null, mark, ring });
        }
      }

      // 奥の 2 本柱 + 上部の色サイン（棚の識別。奥なのでアームと干渉しない）
      const signY = L.TIERS[1].top + 0.62;
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, signY, 0.05), frameMat);
        post.position.set(s * (W / 2 - 0.03), signY / 2, zOut - 0.04);
        post.castShadow = true; g.add(post);
      }
      const sign = new THREE.Mesh(new THREE.BoxGeometry(W, 0.2, 0.03),
        new THREE.MeshStandardMaterial({ color: spec.hex, emissive: spec.hex, emissiveIntensity: 0.8 }));
      sign.position.set(0, signY, zOut - 0.04); sign.castShadow = true; g.add(sign);

      this.racks.push({ ...spec, index: i, group: g, slots });
    }
  }

  makeServo(size = 0.5) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(size, size * 1.05, size * 0.62),
      new THREE.MeshStandardMaterial({ color: COL.servo, metalness: 0.35, roughness: 0.45 }));
    body.castShadow = true; g.add(body);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(size * 1.02, size * 0.16, size * 0.64),
      new THREE.MeshStandardMaterial({ color: COL.servoDark })); cap.position.y = size * 0.55; g.add(cap);
    for (const s of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.26, size * 0.26, size * 0.08, 20),
        new THREE.MeshStandardMaterial({ color: COL.horn, metalness: 0.8, roughness: 0.3 }));
      horn.rotation.x = Math.PI / 2; horn.position.z = s * size * 0.34; g.add(horn);
    }
    return g;
  }
  makeBracket(len, w = 0.3) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: COL.bracket, metalness: 0.5, roughness: 0.5 });
    for (const s of [-1, 1]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.06, len, w), mat);
      plate.position.set(s * w * 0.62, len / 2, 0); plate.castShadow = true; g.add(plate);
    }
    const spine = new THREE.Mesh(new THREE.BoxGeometry(w * 1.24, len * 0.9, 0.06), mat);
    spine.position.y = len / 2; g.add(spine);
    const end = new THREE.Group(); end.position.y = len; g.add(end); g.userData.end = end;
    return g;
  }

  // ── アーム本体。リンク長は ik.js の GEO と厳密に一致させる ────────────────
  buildArm() {
    this.armRoot = new THREE.Group();
    this.armRoot.position.set(GEO.baseX, 0, GEO.baseZ); this.scene.add(this.armRoot);

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.22, 1.2),
      new THREE.MeshStandardMaterial({ color: COL.chassis, metalness: 0.3, roughness: 0.7 }));
    chassis.position.y = 0.11; chassis.castShadow = true; chassis.receiveShadow = true; this.armRoot.add(chassis);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.05, 0.95),
      new THREE.MeshStandardMaterial({ color: 0x0f5132 }));
    deck.position.y = 0.245; this.armRoot.add(deck);   // Raspberry Pi 5 基板
    for (const s of [-1, 1]) for (const t of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 12),
        new THREE.MeshStandardMaterial({ color: 0x0b0d11 }));
      foot.position.set(s * 0.5, 0.02, t * 0.5); this.armRoot.add(foot);
    }

    // ID1 ベース旋回
    const j1 = new THREE.Group(); j1.position.y = GEO.j1Y; this.armRoot.add(j1);
    const sv1 = this.makeServo(0.5); sv1.position.y = 0.22; j1.add(sv1);
    const b1 = this.makeBracket(GEO.shoulderY - 0.45); b1.position.y = 0.45; j1.add(b1);

    // ID2 肩
    const j2 = new THREE.Group(); j2.position.y = GEO.shoulderY; j1.add(j2);
    j2.add(this.makeServo(0.44));
    const b2 = this.makeBracket(GEO.L1 - 0.14); b2.position.y = 0.14; j2.add(b2);

    // ID3 肘
    const j3 = new THREE.Group(); j3.position.y = GEO.L1; j2.add(j3);
    j3.add(this.makeServo(0.4));
    const b3 = this.makeBracket(GEO.L2 - 0.13); b3.position.y = 0.13; j3.add(b3);

    // ID4 手首ピッチ
    const j4 = new THREE.Group(); j4.position.y = GEO.L2; j3.add(j4);
    j4.add(this.makeServo(0.34));

    // ID5 手首回転（回転軸が手先方向と一直線 = 把持点を動かさない）
    const j5 = new THREE.Group(); j5.position.y = 0.3; j4.add(j5);
    j5.add(this.makeServo(0.3));

    const hand = new THREE.Group(); hand.position.y = 0.22; j5.add(hand);
    const cam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.14),
      new THREE.MeshStandardMaterial({ color: COL.camera })); cam.position.set(0, 0.04, 0.2); hand.add(cam);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 16),
      new THREE.MeshStandardMaterial({ color: COL.lens, emissive: 0x0e6b5f, emissiveIntensity: 0.7 }));
    lens.rotation.x = Math.PI / 2; lens.position.set(0, 0.04, 0.28); hand.add(lens);

    // ID6 グリッパ
    this.gripper = new THREE.Group(); hand.add(this.gripper);
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.28),
      new THREE.MeshStandardMaterial({ color: COL.bracket, metalness: 0.5 }));
    palm.position.y = 0.06; this.gripper.add(palm);
    // 把持点。j4 からの距離が GEO.L3 と厳密に一致する（= IK が解く手先そのもの）
    const tipY = GEO.L3 - 0.3 - 0.22;
    this.gripTip = new THREE.Group();
    this.gripTip.position.y = tipY;
    this.gripper.add(this.gripTip);

    // 指は把持点をまたぎ、指先が部品の底面（＝ベルト/棚板の高さ）で止まる長さにする
    this.fingers = [];
    const fBase = 0.12, fTip = tipY + L.PART.height / 2, fLen = fTip - fBase;
    for (const s of [-1, 1]) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(FINGER_T, fLen, 0.18),
        new THREE.MeshStandardMaterial({ color: COL.finger, metalness: 0.4 }));
      finger.position.set(s * GRIP_X.open, fBase + fLen / 2, 0);
      finger.castShadow = true; this.gripper.add(finger); this.fingers.push(finger);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.015, fLen * 0.55, 0.15),
        new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.9 }));
      pad.position.set(-s * (FINGER_T / 2), 0.06, 0); finger.add(pad);   // 内側の当たり面
    }

    this.joints = [j1, j2, j3, j4, j5];
  }

  applyJoints(q) {
    this.joints[0].rotation.y = q[0];
    this.joints[1].rotation.z = q[1];
    this.joints[2].rotation.z = q[2];
    this.joints[3].rotation.z = q[3];
    this.joints[4].rotation.y = q[4];
    this.q = q.slice();
  }
  setGrip(t) {
    this.grip = Math.max(0, Math.min(1, t));
    const x = gripX(this.grip);
    if (this.fingers) { this.fingers[0].position.x = -x; this.fingers[1].position.x = x; }
  }
  tipWorld() { const v = new THREE.Vector3(); this.gripTip.getWorldPosition(v); return v; }

  // ── 部品 ─────────────────────────────────────────────────────────────────
  spawnPart(color) {
    // 投入口に先行部品が残っていたら見送る（ベルトの外へ湧かせない）
    const spawnX = L.BELT.x0 + 0.3;
    if (this.parts.some(p => p.userData.onBelt && p.position.x < spawnX + 0.5)) return null;
    const keys = Object.keys(KINDS);
    const c = color ?? keys[Math.floor(Math.random() * keys.length)];
    const k = KINDS[c];
    const geo = c === 'red' ? new THREE.BoxGeometry(L.PART.size, L.PART.height, L.PART.size)
      : c === 'blue' ? new THREE.CylinderGeometry(0.15, 0.15, L.PART.height, 24)
        : new THREE.CylinderGeometry(0.18, 0.18, L.PART.height, 6);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: k.hex, metalness: 0.25, roughness: 0.5 }));
    mesh.position.set(spawnX, L.BELT.y + L.BELT.thick / 2 + L.PART.height / 2, L.STATION.z);
    mesh.castShadow = true;
    mesh.userData = { color: c, half: k.half, onBelt: true, stopped: false, rejected: false, placed: false };
    this.scene.add(mesh); this.parts.push(mesh); return mesh;
  }

  // ベルト上の部品を前進させ、ストッパ（または先行部品）の手前で停止させる
  advanceBelt(dt) {
    const queue = this.parts.filter(p => p.userData.onBelt && !p.userData.rejected)
      .sort((a, b) => b.position.x - a.position.x);
    queue.forEach((p, i) => {
      const limit = i === 0 ? L.STATION.x : queue[i - 1].position.x - 0.5;
      const nx = p.position.x + dt * 0.85 * this.speed;
      p.position.x = Math.min(nx, limit);
      if (i === 0 && !p.userData.stopped && p.position.x >= L.STATION.x - 1e-6) {
        // ストッパ位置に到達 → アームが空くまでここで待つ（main.js が拾う）
        p.position.x = L.STATION.x; p.userData.stopped = true;
        this.stationPart = p;
      }
    });
    // 不良品はストッパを開放してベルト端から排出
    for (const p of this.parts) {
      if (!p.userData.rejected || !p.userData.onBelt) continue;
      p.position.x += dt * 1.6 * this.speed;
      if (p.position.x > L.BELT.x1) {
        p.userData.onBelt = false;
        this.scene.remove(p); this.parts = this.parts.filter(x => x !== p);
      }
    }
  }
  reject(part) {
    if (!part) return;
    part.userData.rejected = true; part.userData.stopped = false;
    if (this.stationPart === part) this.stationPart = null;
  }

  // ── 棚のスロット割当（色が一致する棚の空きスロットを手前段から埋める）────
  allocSlot(color) {
    const rack = this.racks.find(r => r.color === color);
    if (!rack) return null;
    const free = rack.slots.find(s => !s.part);
    return free ? { rack, slot: free } : null;
  }
  rackFull(color) { const r = this.racks.find(x => x.color === color); return r ? r.slots.every(s => s.part) : false; }
  shipRack(color) {   // 満杯の棚を出荷 → スロットを解放し、サイクルを継続できるようにする
    const rack = this.racks.find(r => r.color === color); if (!rack) return 0;
    let n = 0;
    for (const s of rack.slots) {
      if (!s.part) continue;
      this.scene.remove(s.part); this.parts = this.parts.filter(p => p !== s.part);
      s.part = null; n++;
    }
    return n;
  }

  // ── Pick & Place：全ポーズを逆運動学で解いて手順を組む ────────────────────
  beginCycle(part, rack, slot, done) {
    const S = { x: part.position.x, y: part.position.y, z: part.position.z };   // 実際の停止位置
    const P = slot.pos;
    const cs = L.polar(L.STATION_YAW, L.CARRY.u);
    const cr = L.polar(rack.yaw, L.CARRY.u);
    const ik = (x, y, z) => solveIK(x, y, z).q;

    this.seq = [
      { key: 'open',    type: 'grip', grip: 1, ms: 0.30, label: '① グリッパを開く' },
      { key: 'above',   type: 'arm', q: ik(S.x, S.y + L.HOVER, S.z), ms: 0.70, label: '② 部品の真上へ接近' },
      { key: 'descend', type: 'arm', q: ik(S.x, S.y, S.z),           ms: 0.50, label: '③ 把持点まで下降' },
      { key: 'grasp',   type: 'grip', grip: graspT(part.userData.half), ms: 0.45, grab: true, label: '④ 把持：指が部品に接するまで閉じる' },
      { key: 'lift',    type: 'arm', q: ik(cs.x, L.CARRY.y, cs.z),   ms: 0.60, label: '⑤ 持ち上げて引き込む' },
      { key: 'swing',   type: 'arm', q: ik(cr.x, L.CARRY.y, cr.z),   ms: 1.00, label: `⑥ ${rack.label} へベース旋回` },
      { key: 'over',    type: 'arm', q: ik(P.x, P.y + L.HOVER, P.z), ms: 0.70, label: '⑦ スロット真上へ' },
      { key: 'place',   type: 'arm', q: ik(P.x, P.y, P.z),           ms: 0.50, label: '⑧ スロットへ下降' },
      { key: 'release', type: 'grip', grip: 1, ms: 0.40, release: true, label: '⑨ 解放：棚へ置く' },
      { key: 'retreat', type: 'arm', q: ik(P.x, P.y + L.HOVER, P.z), ms: 0.45, label: '⑩ 退避' },
      { key: 'home',    type: 'arm', q: this.HOME, ms: 0.70, label: '⑪ ホームへ戻る' },
    ];
    this.cycle = {
      part, rack, slot, done, idx: 0, elapsed: 0, lastIdx: -1,
      startQ: this.q.slice(), startGrip: this.grip, graspErr: null,
    };
    part.userData.onBelt = false;
    if (this.stationPart === part) this.stationPart = null;
    slot.part = part;                     // 予約（他の部品が同じ枠を取らない）
    slot.ring.material.opacity = 1; slot.mark.material.opacity = 0.55;   // 目標スロットを点灯
  }

  runCycle(dt) {
    const c = this.cycle, step = this.seq[c.idx];
    if (c.idx !== c.lastIdx) { c.lastIdx = c.idx; this.onPhase?.(step.key, step.label); }
    c.elapsed += dt * this.speed;
    const t = Math.min(1, c.elapsed / step.ms), e = sc(t);

    if (step.type === 'arm') {
      const q = c.startQ.map((v, i) => v + (step.q[i] - v) * e);
      this.applyJoints(q);
    } else {
      this.setGrip(c.startGrip + (step.grip - c.startGrip) * e);
      if (step.grab && t >= 1 && !this.held) {
        // 指が閉じ切った瞬間に剛体固定。IK が正確なら把持点は部品中心にある。
        c.graspErr = this.tipWorld().distanceTo(c.part.position);
        this.gripTip.attach(c.part);      // ワールド変換を保ったままハンドの子にする
        this.held = c.part;
      }
      if (step.release && t >= 1 && this.held) {
        this.scene.attach(this.held);     // ワールド変換を保ったままシーンへ戻す
        c.placeErr = this.held.position.distanceTo(new THREE.Vector3(c.slot.pos.x, c.slot.pos.y, c.slot.pos.z));
        this.held.userData.placed = true;
        this.held = null;
        c.slot.ring.material.opacity = 0.85; c.slot.mark.material.opacity = 0.2;
      }
    }
    if (t >= 1) {
      c.idx++; c.elapsed = 0; c.startQ = this.q.slice(); c.startGrip = this.grip;
      if (c.idx >= this.seq.length) {
        const { done, graspErr, placeErr, part, rack } = c;
        this.cycle = null;
        done?.({ graspErr, placeErr, part, rack });
      }
    }
  }

  update(dt) {
    if (!this.running) return;
    this.spawnTimer += dt * this.speed;
    const onBelt = this.parts.filter(p => p.userData.onBelt).length;
    if (this.spawnTimer > 2.2 && onBelt < 4) { this.spawnTimer = 0; this.spawnPart(); }

    this.advanceBelt(dt);
    this.qPrev = this.q.slice(); this.gripPrev = this.grip;
    if (this.cycle) this.runCycle(dt);

    // 駆動中のサーボを判定（カード点灯用）
    let mj = -1, mv = 2e-4;
    for (let i = 0; i < 5; i++) { const v = Math.abs(this.q[i] - this.qPrev[i]); if (v > mv) { mv = v; mj = i; } }
    if (Math.abs(this.grip - this.gripPrev) * 0.7 > mv) mj = 5;
    this.activeServo = mj;
    this.onServo?.(servoAngles(this.q, this.grip));
    // 実機で成立しない指令が出ていないかを常時監視（clamp で誤魔化さない）
    const bad = servoOutOfRange(this.q, this.grip);
    if (bad.length) { this.servoFaults = (this.servoFaults ?? 0) + 1; this.onServoFault?.(bad); }
  }

  reset() {
    for (const p of [...this.parts]) this.scene.remove(p);
    this.parts = []; this.cycle = null; this.held = null; this.spawnTimer = 0; this.stationPart = null;
    for (const r of this.racks) for (const s of r.slots) {
      s.part = null; s.ring.material.opacity = 0.85; s.mark.material.opacity = 0.2;
    }
    this.applyJoints(this.HOME); this.setGrip(1); this.activeServo = -1;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w, h);
  }

  renderLoop(callback) {
    const clock = new THREE.Clock();
    const frame = () => {
      requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.05);
      callback?.(dt); this.update(dt); this.controls.update(); this.renderer.render(this.scene, this.camera);
    };
    frame();
  }
}

// ホーム姿勢：コンベアと棚の中間、部品に当たらない高さ
function homeTarget() {
  const p = L.polar(-20 * Math.PI / 180, 1.15);
  return [p.x, 1.75, p.z];
}
