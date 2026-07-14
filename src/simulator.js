import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.164.1/+esm';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/controls/OrbitControls.js/+esm';

// ── Yahboom DOFBOT (6DOF / Raspberry Pi 5) 忠実CG ──────────────────────────
//   サーボ割当: ID1 ベース旋回 / ID2 肩 / ID3 肘 / ID4 手首ピッチ / ID5 手首回転 / ID6 グリッパ
//   Pick&Place を実機どおりの離散フェーズで再現:
//     接近 → 下降 → 把持(閉) → 持ち上げ → 回転搬送(ID1) → bin上下降 → 解放(開) → 退避
const COL = {
  chassis: 0x14171d, bracket: 0x252a33, servo: 0x1f5fd0, servoDark: 0x184aa0,
  horn: 0xc3cad6, finger: 0x111318, camera: 0x0c0e12, lens: 0x2dd4bf,
};
const sc = x => x * x * x * (10 - 15 * x + 6 * x * x);   // min-jerk 補間

export class LineSimulator {
  constructor(container) {
    this.container = container;
    this.parts = [];
    this.running = false;
    this.speed = 1;
    this.spawnTimer = 0;
    this.pickState = null;
    this.held = null;               // 把持中の部品
    this.onPickupZone = null;
    this.onMiss = null;
    this.onPhase = null;            // フェーズ開始通知 (ログ用)
    this.joints = [];               // 5 個の位置決め関節 (ID1..ID5)
    this.jointAxis = ['y', 'z', 'z', 'z', 'y'];
    this.q = [0, 0, 0, 0, 0];
    this.qPrev = [0, 0, 0, 0, 0];
    this.grip = 1;                  // ID6 (1=開 0=閉)
    this.gripPrev = 1;
    this.activeServo = -1;          // 駆動中サーボ 0..5 (5=ID6) / -1
    this.HOME = [0, -0.35, 0.95, 0.55, 0];
    this.initThree();
  }

  initThree() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0f18);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(7.5, 5.5, 8.5);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(1.2, 1.2, 0);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x1e293b, 1.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(6, 10, 6); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x93c5fd, 0.6); fill.position.set(-6, 4, -3); this.scene.add(fill);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 14),
      new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.scene.add(floor);
    const grid = new THREE.GridHelper(20, 40, 0x334155, 0x1f2b3a); grid.position.y = 0.001; this.scene.add(grid);

    this.buildConveyor(); this.buildBins(); this.buildArm();
    this.applyJoints(this.HOME); this.setGrip(1);
    this.resize(); window.addEventListener('resize', () => this.resize());
  }

  buildConveyor() {
    const belt = new THREE.Mesh(new THREE.BoxGeometry(8, 0.28, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.2, roughness: 0.8 }));
    belt.position.set(-0.6, 0.55, 0); belt.receiveShadow = true; this.scene.add(belt);
    for (let i = -4; i <= 4; i++) {
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.95, 18),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.7 }));
      roller.rotation.x = Math.PI / 2; roller.position.set(i - 0.6, 0.56, 0); this.scene.add(roller);
    }
  }

  buildBins() {
    this.binA = this.makeBin(2.9, 2.6, 0xb91c1c);
    this.binB = this.makeBin(2.9, -2.6, 0x1d4ed8);
  }
  makeBin(x, z, color) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 1.5),
      new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.82 }));
    m.position.set(x, 0.3, z); m.receiveShadow = true; this.scene.add(m); return m;
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
  makeBracket(len, w = 0.34) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: COL.bracket, metalness: 0.5, roughness: 0.5 });
    for (const s of [-1, 1]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.07, len, w), mat);
      plate.position.set(s * w * 0.62, len / 2, 0); plate.castShadow = true; g.add(plate);
    }
    const spine = new THREE.Mesh(new THREE.BoxGeometry(w * 1.24, len * 0.92, 0.07), mat);
    spine.position.y = len / 2; g.add(spine);
    const end = new THREE.Group(); end.position.y = len; g.add(end); g.userData.end = end;
    return g;
  }

  buildArm() {
    this.armRoot = new THREE.Group();
    this.armRoot.position.set(2.5, 0, -0.1); this.scene.add(this.armRoot);

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.32, 1.55),
      new THREE.MeshStandardMaterial({ color: COL.chassis, metalness: 0.3, roughness: 0.7 }));
    chassis.position.y = 0.16; chassis.castShadow = true; chassis.receiveShadow = true; this.armRoot.add(chassis);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x0f5132 })); deck.position.y = 0.34; this.armRoot.add(deck);

    const j1 = new THREE.Group(); j1.position.y = 0.37; this.armRoot.add(j1);          // ID1 ベース旋回
    const sv1 = this.makeServo(0.6); sv1.position.y = 0.3; j1.add(sv1);
    const b1 = this.makeBracket(0.5); b1.position.y = 0.6; j1.add(b1);

    const j2 = new THREE.Group(); b1.userData.end.add(j2);                              // ID2 肩
    j2.add(this.makeServo(0.52));
    const b2 = this.makeBracket(1.5); b2.position.y = 0.18; j2.add(b2);

    const j3 = new THREE.Group(); b2.userData.end.add(j3);                              // ID3 肘
    j3.add(this.makeServo(0.46));
    const b3 = this.makeBracket(1.25); b3.position.y = 0.16; j3.add(b3);

    const j4 = new THREE.Group(); b3.userData.end.add(j4);                              // ID4 手首ピッチ
    j4.add(this.makeServo(0.4));
    const b4 = this.makeBracket(0.5); b4.position.y = 0.14; j4.add(b4);

    const j5 = new THREE.Group(); b4.userData.end.add(j5);                              // ID5 手首回転
    j5.add(this.makeServo(0.36));
    const wristMount = new THREE.Group(); wristMount.position.y = 0.34; j5.add(wristMount);

    const s6 = this.makeServo(0.34); wristMount.add(s6);                                // ID6 グリッパ・サーボ
    const gbase = new THREE.Group(); gbase.position.y = 0.2; wristMount.add(gbase);
    const cam = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.16),
      new THREE.MeshStandardMaterial({ color: COL.camera })); cam.position.set(0, 0.02, 0.24); gbase.add(cam);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.06, 16),
      new THREE.MeshStandardMaterial({ color: COL.lens, emissive: 0x0e6b5f, emissiveIntensity: 0.6 }));
    lens.rotation.x = Math.PI / 2; lens.position.set(0, 0.02, 0.33); gbase.add(lens);

    this.gripper = new THREE.Group(); gbase.add(this.gripper);
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.34),
      new THREE.MeshStandardMaterial({ color: COL.bracket, metalness: 0.5 })); palm.position.y = 0.08; this.gripper.add(palm);
    this.fingers = [];
    for (const s of [-1, 1]) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.42, 0.2),
        new THREE.MeshStandardMaterial({ color: COL.finger, metalness: 0.4 }));
      finger.position.set(s * 0.16, 0.36, 0); finger.castShadow = true; this.gripper.add(finger); this.fingers.push(finger);
    }
    this.gripTip = new THREE.Group(); this.gripTip.position.y = 0.5; this.gripper.add(this.gripTip);

    this.joints = [j1, j2, j3, j4, j5];
  }

  applyJoints(q) { for (let i = 0; i < 5; i++) this.joints[i].rotation[this.jointAxis[i]] = q[i]; this.q = q.slice(); }
  setGrip(open) {
    this.grip = Math.max(0, Math.min(1, open));
    const x = 0.09 + this.grip * 0.09;
    if (this.fingers) { this.fingers[0].position.x = -x; this.fingers[1].position.x = x; }
  }

  spawnPart() {
    const red = Math.random() > 0.5;
    const geometry = red ? new THREE.BoxGeometry(0.42, 0.42, 0.42) : new THREE.CylinderGeometry(0.22, 0.22, 0.46, 24);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: red ? 0xef4444 : 0x3b82f6, metalness: 0.2 }));
    mesh.position.set(-4.6, 0.92, 0); mesh.castShadow = true;
    mesh.userData = { color: red ? 'red' : 'blue', picked: false, announced: false, falling: false };
    this.scene.add(mesh); this.parts.push(mesh); return mesh;
  }

  // ── 実機どおりの Pick & Place シーケンスを組み立てる ──
  beginPick(part, dest, done) {
    const toA = dest === this.binA;
    const by = toA ? -1.05 : 1.05;                 // ベース旋回角 (bin 方向)
    const ABOVE = [0, 0.00, 1.10, 0.68, 0];        // 物体の上(ホバー)
    const GRASP = [0, 0.20, 1.36, 0.72, 0];        // 物体位置(下降)
    const OVER  = [by, -0.05, 1.02, 0.62, 0.5];    // bin 上(ホバー, 手首回転)
    const DOWN  = [by, 0.14, 0.88, 0.62, 0.5];     // bin へ下降
    const RET   = [by, -0.28, 0.98, 0.58, 0];      // 退避
    this.seq = [
      { type: 'grip', grip: 1, ms: 0.35, label: '① グリッパを開く (ID6→90°)' },
      { type: 'arm',  pose: ABOVE, ms: 0.60, label: '② 物体の上へ接近' },
      { type: 'arm',  pose: GRASP, ms: 0.55, label: '③ 物体まで下降' },
      { type: 'grip', grip: 0, ms: 0.55, label: '④ 把持：グリッパを閉じる (ID6→20°)', grab: true },
      { type: 'arm',  pose: ABOVE, ms: 0.55, label: '⑤ 持ち上げ' },
      { type: 'arm',  pose: OVER,  ms: 0.95, label: '⑥ ベース旋回で搬送（回転）' },
      { type: 'arm',  pose: DOWN,  ms: 0.55, label: '⑦ bin 上で下降' },
      { type: 'grip', grip: 1, ms: 0.55, label: '⑧ 解放：グリッパを開く (ID6→90°)', release: true },
      { type: 'arm',  pose: RET,   ms: 0.50, label: '⑨ 退避 → ホーム' },
    ];
    this.pickState = { part, dest, done, idx: 0, elapsed: 0, lastIdx: -1, startPose: this.q.slice(), startGrip: this.grip };
    part.userData.picked = true;
  }

  update(dt) {
    if (!this.running) return;
    this.spawnTimer += dt * this.speed;
    if (this.spawnTimer > 2.8) { this.spawnTimer = 0; this.spawnPart(); }

    for (const p of this.parts) {
      if (p.userData.falling) { this.fall(p, dt); continue; }
      if (!p.userData.picked) p.position.x += dt * 0.9 * this.speed;
      if (!p.userData.picked && !p.userData.announced && p.position.x > 1.0) { p.userData.announced = true; this.onPickupZone?.(p); }
    }

    this.qPrev = this.q.slice(); this.gripPrev = this.grip;
    if (this.pickState) this.runPick(dt); else this.easeTo(this.HOME, dt, 2.2);
    if (this.held) { const h = new THREE.Vector3(); this.gripTip.getWorldPosition(h); this.held.position.lerp(h, 0.55); }

    let mj = -1, mv = 2e-4;
    for (let i = 0; i < 5; i++) { const v = Math.abs(this.q[i] - this.qPrev[i]); if (v > mv) { mv = v; mj = i; } }
    if (Math.abs(this.grip - this.gripPrev) * 0.7 > mv) mj = 5;   // ID6 グリッパ
    this.activeServo = mj;

    for (const p of [...this.parts]) {
      if (!p.userData.picked && !p.userData.falling && p.position.x > 3.8) {
        this.scene.remove(p); this.parts = this.parts.filter(x => x !== p); this.onMiss?.(p);
      }
    }
  }

  runPick(dt) {
    const s = this.pickState; const step = this.seq[s.idx];
    if (s.idx !== s.lastIdx) { s.lastIdx = s.idx; this.onPhase?.(step.label); }
    s.elapsed += dt * this.speed;
    const t = Math.min(1, s.elapsed / step.ms), e = sc(t);
    if (step.type === 'arm') {
      const q = this.q.slice();
      for (let i = 0; i < 5; i++) q[i] = s.startPose[i] + (step.pose[i] - s.startPose[i]) * e;
      this.applyJoints(q);
    } else {
      this.setGrip(s.startGrip + (step.grip - s.startGrip) * e);
      if (step.grab && this.grip < 0.25 && !this.held) this.held = s.part;                 // 掴んだ
      if (step.release && this.grip > 0.5 && this.held) { this.drop(s.part, s.dest); this.held = null; }  // 離した
    }
    if (t >= 1) {
      s.idx++; s.elapsed = 0; s.startPose = this.q.slice(); s.startGrip = this.grip;
      if (s.idx >= this.seq.length) { const done = s.done; this.pickState = null; done?.(); }
    }
  }

  drop(part, dest) {   // bin へ落下開始
    part.userData.falling = true; part.userData.vy = 0;
    part.userData.fallTo = { x: dest.position.x + (Math.random() - 0.5) * 0.5, y: dest.position.y + 0.55, z: dest.position.z + (Math.random() - 0.5) * 0.5 };
  }
  fall(p, dt) {
    const T = p.userData.fallTo;
    p.position.x += (T.x - p.position.x) * Math.min(1, dt * 6);
    p.position.z += (T.z - p.position.z) * Math.min(1, dt * 6);
    p.userData.vy -= 12 * dt; p.position.y += p.userData.vy * dt;
    if (p.position.y <= T.y) { p.position.y = T.y; p.userData.falling = false; }
  }

  easeTo(target, dt, speed) {
    const k = Math.min(1, dt * speed * this.speed); const q = this.q.slice();
    for (let i = 0; i < 5; i++) q[i] += (target[i] - q[i]) * k;
    this.applyJoints(q); this.setGrip(this.grip + (1 - this.grip) * k);
  }

  reset() {
    for (const p of this.parts) this.scene.remove(p);
    this.parts = []; this.pickState = null; this.held = null; this.spawnTimer = 0;
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
