import { ActorRuntime, BaseActor } from './aipl_runtime.js';
import { LineSimulator } from './simulator.js';

const ui = Object.fromEntries(
  ['processed','success','failed','messages','statusBadge','log','actorGrid','sourceView','srcTarget','speed','cameraFault']
    .map(id => [id, document.getElementById(id)]));
const simulator = new LineSimulator(document.getElementById('scene'));
let stats = { processed:0, success:0, failed:0 };
let activeApp = '';

// ===================== Capability（効果）推論エンジン =====================
// AIPL ソースに !{...} は書かない。各メソッド本体の一次作用(primitive)を走査して
// !{mut, ai, net, fs} を導出し、そこから役割を推論する。
const PRIM = 'Arm_serial_servo_write6|Arm_serial_servo_write|Arm_serial_servo_read|send|now|reply|remote|servo_write|grip_set|drive_servo|ai_infer|vision_detect|llm_ask|recognize|file_write|file_read|persist|encoder_read|camera_grab|inverse_kinematics|motor_of|array_push';
const KW = 'class|method|var|while|do|if|else|new|return';
const MUT_PRIM = ['servo_write', 'grip_set', 'drive_servo', 'Arm_serial_servo_write', 'Arm_serial_servo_write6'];

function matchBrace(text, from) {
  let i = text.indexOf('{', from), depth = 0, j = i;
  for (; j < text.length; j++) { const c = text[j]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } }
  return { open: i, close: j };
}
function parseClasses(text) {
  const classes = {}; const re = /class\s+(\w+)\s*\{/g; let m;
  while ((m = re.exec(text))) {
    const { close } = matchBrace(text, m.index);
    classes[m[1]] = { name: m[1], full: text.slice(m.index, close + 1), body: text.slice(text.indexOf('{', m.index) + 1, close) };
    re.lastIndex = close + 1;
  }
  return classes;
}
function getMethods(body) {
  const out = []; const re = /method\s+(\w+)\s*\([^)]*\)\s*\{/g; let m;
  while ((m = re.exec(body))) {
    const { open, close } = matchBrace(body, m.index);
    out.push({ name: m[1], full: body.slice(m.index, close + 1), mbody: body.slice(open + 1, close) });
    re.lastIndex = close + 1;
  }
  return out;
}
function classFields(body, methods) {
  let s = body; for (const meth of methods) s = s.replace(meth.full, '');
  const names = []; let m; const re = /var\s+(\w+)\s*=/g;
  while ((m = re.exec(s))) names.push(m[1]);
  return names;
}
function inferCaps(cls) {
  const methods = getMethods(cls.body);
  const fields = classFields(cls.body, methods);
  const caps = { mut:false, ai:false, net:false, fs:false }; const why = new Set();
  for (const meth of methods) {
    const b = meth.mbody;
    for (const p of ['send','now','reply','remote']) if (new RegExp('\\b'+p+'\\b').test(b)) { caps.net = true; why.add(p); }
    for (const p of ['ai_infer','vision_detect','llm_ask','recognize']) if (new RegExp('\\b'+p+'\\b').test(b)) { caps.ai = true; why.add(p); }
    for (const p of ['file_write','file_read','persist']) if (new RegExp('\\b'+p+'\\b').test(b)) { caps.fs = true; why.add(p); }
    for (const p of MUT_PRIM) if (new RegExp('\\b'+p+'\\b').test(b)) { caps.mut = true; why.add(p); }
    for (const f of fields) if (new RegExp('\\b'+f+'\\s*=(?!=)').test(b)) { caps.mut = true; why.add(f+'='); }
  }
  return { caps, why: [...why] };
}
function inferRole(caps, cls) {
  const b = cls.body;
  if (caps.mut && /grip_set/.test(b)) return 'グリッパ駆動';
  if (caps.mut) return 'アクチュエータ（サーボ駆動）';
  if (caps.ai) return '知覚（AI 認識）';
  if (caps.fs && caps.net) return '安全監視（永続ログ）';
  if (caps.net) {
    if (/inverse_kinematics/.test(b)) return '動作計画（IK・駆動権限なし）';
    if (/Arm_serial_servo_read|encoder_read/.test(b)) return 'センサ（サーボ角計測・read-only）';
    if (/motor_of/.test(b)) return '搬送（サーボへ駆動委譲）';
    if (/array_push|setup/.test(b)) return '調整（12 Xinu 巡回）';
    return '通信';
  }
  return '純計算';
}
function capsChips(caps) {
  return ['mut','ai','net','fs'].filter(k => caps[k]).map(k => `<span class="cap cap-${k}">!{${k}}</span>`).join('');
}

// AIPL シンタックスハイライト（推論の根拠となる primitive を桃色で強調）
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function highlight(code) {
  let h = esc(code).replace(new RegExp(`(//[^\\n]*)|("[^"]*")|\\b(${PRIM})\\b|\\b(${KW})\\b`, 'g'),
    (m, cm, str, prim, kw) => cm ? `<span class="tok-cm">${cm}</span>`
      : str ? `<span class="tok-str">${str}</span>`
      : prim ? `<span class="tok-prim">${prim}</span>`
      : `<span class="tok-kw">${kw}</span>`);
  return h.replace(/(<span class="tok-kw">class<\/span>\s+)(\w+)/g, '$1<span class="tok-cls">$2</span>');
}

// ===================== 画面構築（12 Xinu + アプリ層） =====================
let CLASSES = {}, INFO = {}, FULLSRC = '';
const APP_ACTORS = ['CameraActor','RecognitionActor','PlannerActor','ArmMover','SafetyActor','Coordinator'];
const SERVOS = [   // 実機 DOFBOT のサーボ割当（6軸 = 6 サーボ, ID6 がグリッパ）
  { id: 1, name: 'ベース旋回' }, { id: 2, name: '肩' }, { id: 3, name: '肘' },
  { id: 4, name: '手首ピッチ' }, { id: 5, name: '手首回転' }, { id: 6, name: 'グリッパ' },
];

function showSource(clsName) {
  ui.srcTarget.textContent = clsName;
  ui.sourceView.innerHTML = highlight(CLASSES[clsName].full);
}
function showAll() { ui.srcTarget.textContent = '全体'; ui.sourceView.innerHTML = highlight(FULLSRC); }

function card(actorId, clsName, title) {
  const info = INFO[clsName];
  const div = document.createElement('div'); div.className = 'actor';
  div.dataset.actor = actorId; div.dataset.cls = clsName;
  div.innerHTML = `<strong>${title}</strong><span class="role">${info.role}</span><div class="caps">${capsChips(info.caps)}</div>`;
  div.addEventListener('click', () => showSource(clsName));
  return div;
}
function groupHead(text) {
  const d = document.createElement('div'); d.className = 'group-head'; d.textContent = text; return d;
}
function buildCards() {
  ui.actorGrid.innerHTML = '';
  ui.actorGrid.append(groupHead('物理層 — 12 Xinu（6 サーボ × 2）'));
  for (const sv of SERVOS) {
    ui.actorGrid.append(card(`ID${sv.id}-A`, 'ServoMotor', `ID${sv.id}-A · ${sv.name}`));
    ui.actorGrid.append(card(`ID${sv.id}-B`, 'ServoSensor', `ID${sv.id}-B · ${sv.name}`));
  }
  ui.actorGrid.append(groupHead('アプリ層アクター — Raspberry Pi 5'));
  for (const name of APP_ACTORS) ui.actorGrid.append(card(name, name, name));
}

function setActive(name) { activeApp = name; }
function log(actor, text) {
  const line = document.createElement('div'); line.textContent = `[${actor}] ${text}`; ui.log.prepend(line);
  while (ui.log.children.length > 16) ui.log.lastChild.remove();
}
function refresh() {
  ui.processed.textContent = stats.processed; ui.success.textContent = stats.success;
  ui.failed.textContent = stats.failed; ui.messages.textContent = runtime.messageCount;
  const aj = simulator.activeServo;
  document.querySelectorAll('.actor').forEach(el => {
    const id = el.dataset.actor;
    const on = (aj >= 0 && (id === `ID${aj+1}-A` || id === `ID${aj+1}-B`)) || id === activeApp;
    el.classList.toggle('active', on);
  });
}

// ===================== アクター実装（CG を駆動） =====================
class Coordinator extends BaseActor { tick(part){ this.log('cycle start'); this.send('CameraActor','capture',part); } halt(){ this.log('halt'); } }
class CameraActor extends BaseActor {
  capture(part) {
    if (ui.cameraFault.checked) { this.log('vision_detect failed (fault)'); this.send('SafetyActor','abort',part,'camera unavailable'); return; }
    this.log(`vision_detect → ${part.userData.color} object`); this.send('RecognitionActor','classify',part);
  }
}
class RecognitionActor extends BaseActor {
  classify(part){ const bin = part.userData.color === 'blue' ? 'B' : 'A'; this.log(`ai_infer → class=${part.userData.color} (bin ${bin})`); this.send('PlannerActor','plan',part,bin); }
}
class PlannerActor extends BaseActor {
  plan(part, bin) {
    this.log(`inverse_kinematics → 接近/把持/搬送/解放 姿勢を生成 (bin ${bin})`);
    this.log('Pick&Place シーケンス開始 → ArmMover / ID6 グリッパへ発行');
    const dest = bin === 'A' ? simulator.binA : simulator.binB;
    simulator.beginPick(part, dest, () => this.send('SafetyActor','complete',part));
  }
}
class SafetyActor extends BaseActor {
  complete(){ stats.processed++; stats.success++; this.log('file_write(cycle.log, ok)'); refresh(); }
  abort(part, reason){ stats.processed++; stats.failed++; this.log(`file_write(cycle.log, ${reason})`); simulator.scene.remove(part); simulator.parts = simulator.parts.filter(p => p !== part); refresh(); }
  miss(){ stats.processed++; stats.failed++; this.log('part missed pickup zone'); refresh(); }
}

const runtime = new ActorRuntime({ onLog: log, onActivity: setActive });
runtime.register('Coordinator', new Coordinator());
runtime.register('CameraActor', new CameraActor());
runtime.register('RecognitionActor', new RecognitionActor());
runtime.register('PlannerActor', new PlannerActor());
runtime.register('SafetyActor', new SafetyActor());

simulator.onPickupZone = part => runtime.send('Coordinator','tick',part);
simulator.onMiss = () => runtime.send('SafetyActor','miss');
simulator.onPhase = label => log('DOFBOT', label);   // Pick&Place 各フェーズをログ
simulator.renderLoop(async () => { await runtime.step(); refresh(); });

function setRunning(v){ simulator.running = v; runtime.running = v; ui.statusBadge.textContent = v ? '実行中' : '停止中'; log('AICE', v ? 'simulation started' : 'simulation paused'); }
document.getElementById('startBtn').addEventListener('click', () => setRunning(true));
document.getElementById('pauseBtn').addEventListener('click', () => setRunning(false));
document.getElementById('spawnBtn').addEventListener('click', () => simulator.spawnPart());
document.getElementById('resetBtn').addEventListener('click', () => { setRunning(false); simulator.reset(); runtime.queue = []; runtime.messageCount = 0; stats = { processed:0, success:0, failed:0 }; ui.log.innerHTML = ''; refresh(); log('AICE','simulation reset'); });
document.getElementById('srcAll').addEventListener('click', showAll);
ui.speed.addEventListener('input', () => { simulator.speed = Number(ui.speed.value); });

// ソース取得 → 効果推論 → カード生成
fetch('./aipl/dofbot_xinu.abcl').then(r => r.text()).then(text => {
  FULLSRC = text; CLASSES = parseClasses(text);
  for (const [name, cls] of Object.entries(CLASSES)) {
    const { caps } = inferCaps(cls); INFO[name] = { caps, role: inferRole(caps, cls) };
  }
  buildCards(); showAll();
  log('AICE', `効果推論完了: ${Object.keys(CLASSES).length} クラス → Capability を導出`);
}).catch(e => { ui.sourceView.textContent = e.message; });

simulator.spawnPart();
log('AICE', 'DOFBOT 12-Xinu actor runtime initialized');
refresh();
if (new URLSearchParams(location.search).has('auto')) setRunning(true);  // ?auto で自動開始
