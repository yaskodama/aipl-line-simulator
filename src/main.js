import { ActorRuntime, BaseActor } from './aipl_runtime.js';
import { LineSimulator, KINDS, WRIST } from './simulator.js';
import * as TM from './tinyml.js';
import * as L from './layout.js';

const ui = Object.fromEntries(
  ['processed','success','failed','graspErr','messages','statusBadge','log','actorGrid','sourceView',
   'srcTarget','speed','cameraFault','shelfPanel','pcActor','pcLine','follow',
   'wristCanvas','recogLabel','recogConf','recogBars','recogNote','visionAcc']
    .map(id => [id, document.getElementById(id)]));
const simulator = new LineSimulator(document.getElementById('scene'));
let stats = { processed:0, success:0, failed:0, graspErr:0, seen:0, correct:0 };
let activeApp = '';

// ===================== TinyML（手首カメラ画像の分類） =====================
// 学習済みの重みは rl/train_tinyml.py が実レンダ画像から作る。
let MODEL = null;
TM.loadModel().then(m => {
  MODEL = m;
  log('AICE', `TinyML 読込: ${TM.NFEAT}→${m.hidden}→3 (${m.nparam} params, 学習時 test acc ${(m.test_acc*100).toFixed(1)}%)`);
}).catch(e => {
  ui.recogNote.textContent = `モデル未読込: ${e.message}`;
  log('AICE', `TinyML モデルなし → 認識できません (${e.message})`);
});

// 手首カメラの PiP。TinyML に渡すのと同一のピクセルをそのまま拡大表示する。
function drawWrist(frame) {
  const c = ui.wristCanvas; if (!c) return;
  const n = frame.res;
  if (c.width !== n) { c.width = n; c.height = n; }
  c.getContext('2d').putImageData(new ImageData(frame.rgba, n, n), 0, 0);
}
function showRecognition(r, truth) {
  ui.recogLabel.textContent = TM.LABELS[r.label];
  ui.recogLabel.style.color = `#${KINDS[r.label].hex.toString(16).padStart(6, '0')}`;
  ui.recogConf.textContent = `信頼度 ${(r.conf * 100).toFixed(1)}%`;
  ui.recogBars.innerHTML = TM.CLASSES.map((c, i) =>
    `<div class="pbar"><span>${TM.LABELS[c]}</span>`
    + `<i style="width:${(r.probs[i] * 100).toFixed(1)}%;background:#${KINDS[c].hex.toString(16).padStart(6,'0')}"></i>`
    + `<b>${(r.probs[i] * 100).toFixed(0)}%</b></div>`).join('');
  const ok = r.label === truth;
  ui.recogNote.textContent = ok ? '正解' : `誤認識（正解は ${TM.LABELS[truth]}）`;
  ui.recogNote.className = 'recog-note ' + (ok ? 'ok' : 'bad');
}

// ===================== Capability（効果）推論エンジン =====================
// AIPL ソースに !{...} は書かない。各メソッド本体の一次作用(primitive)を走査して
// !{mut, ai, net, fs} を導出し、そこから役割を推論する。
// AIPL 処理系に実在する組込みだけを並べる（BUILTINS.md と対応）。
// ここに実在しない名前を書くと、強調も効果推論も黙って空振りする。
const PRIM = 'Arm_serial_servo_write6|Arm_serial_servo_write|Arm_serial_servo_read|'
  + 'dofbot_belt_drive|dofbot_camera_grab|dofbot_camera_truth|dofbot_servo_writes|'
  + 'tinyml_load|tinyml_infer|tinyml_argmax|'
  + 'write_file|read_file|append_file|env_get|print|'
  + 'send|now|future|await|reply|remote|'
  + 'array_push|array_set|array_len|sqrt|sin|cos|atan2|acos|floor';
const KW = 'class|method|var|while|do|if|else|new|return|self';
// 効果の対応表（aipl_typeck.BUILTIN_EFFECTS と一致させること）
const MUT_PRIM = ['Arm_serial_servo_write', 'Arm_serial_servo_write6', 'dofbot_belt_drive'];
const AI_PRIM  = ['tinyml_infer'];
const FS_PRIM  = ['write_file', 'read_file', 'append_file', 'tinyml_load'];
const NET_PRIM = ['send', 'now', 'future', 'await', 'reply', 'remote'];

// text[i] の '{' に対応する '}' の位置
function closeFrom(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return text.length - 1;
}
function matchBrace(text, from) {
  const i = text.indexOf('{', from);
  return { open: i, close: closeFrom(text, i) };
}
function parseClasses(text) {
  const classes = {}; const re = /class\s+(\w+)\s*\{/g; let m;
  while ((m = re.exec(text))) {
    const { close } = matchBrace(text, m.index);
    classes[m[1]] = {
      name: m[1], start: m.index, end: close,
      full: text.slice(m.index, close + 1),
      body: text.slice(text.indexOf('{', m.index) + 1, close),
    };
    re.lastIndex = close + 1;
  }
  return classes;
}
// method 名(引数) [-> 戻り型] [!{効果}] { 本体 }
// 効果注釈と戻り型注釈は省略可。ここを `\)\s*\{` に固定すると、注釈付きの
// メソッドを 1 つも拾えず「効果が何も推論されない」状態に黙って落ちる。
const RE_METHOD = /method\s+(\w+)\s*\([^)]*\)\s*(?:->\s*[^{!]+?)?\s*(?:!\s*\{([^}]*)\})?\s*\{/g;

function getMethods(body) {
  const out = []; const re = new RegExp(RE_METHOD.source, 'g'); let m;
  while ((m = re.exec(body))) {
    // 本体の '{' は正規表現の末尾そのもの。indexOf('{') で探すと効果注釈
    // !{mut, net} の波括弧を掴んでしまい、mbody が "mut, net" になって
    // primitive が 1 つも見つからず、効果推論が全クラスで空になる。
    const open = m.index + m[0].length - 1;
    const close = closeFrom(body, open);
    out.push({
      name: m[1],
      declared: m[2] ? m[2].split(',').map(s => s.trim()).filter(Boolean) : null,
      full: body.slice(m.index, close + 1),
      mbody: body.slice(open + 1, close),
    });
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
  const declared = new Set();
  for (const meth of methods) for (const e of (meth.declared ?? [])) declared.add(e);
  for (const meth of methods) {
    const b = meth.mbody;
    for (const p of NET_PRIM) if (new RegExp('\\b'+p+'\\b').test(b)) { caps.net = true; why.add(p); }
    for (const p of AI_PRIM)  if (new RegExp('\\b'+p+'\\b').test(b)) { caps.ai = true; why.add(p); }
    for (const p of FS_PRIM)  if (new RegExp('\\b'+p+'\\b').test(b)) { caps.fs = true; why.add(p); }
    for (const p of MUT_PRIM) if (new RegExp('\\b'+p+'\\b').test(b)) { caps.mut = true; why.add(p); }
    for (const f of fields) if (new RegExp('\\b'+f+'\\s*=(?!=)').test(b)) { caps.mut = true; why.add(f+'='); }
  }
  // 本体から推論した効果と、ソースが申告している効果の一致を見る。
  // 実処理系 (aipl_main.py --type-check) が同じ検査をしており、そこで
  // 「declared {mut,net} but uses {fs}」のように食い違いを弾く。
  const inferred = new Set(['mut','ai','net','fs'].filter(k => caps[k]));
  const missing = [...inferred].filter(e => !declared.has(e));   // 申告漏れ
  return { caps, why: [...why], declared: [...declared], missing };
}
function inferRole(caps, cls) {
  const b = cls.body;
  if (/Arm_serial_servo_write/.test(b)) return 'アクチュエータ（バスサーボ駆動）';
  if (/Arm_serial_servo_read/.test(b)) return 'センサ（サーボ角計測・read-only）';
  if (/dofbot_belt_drive/.test(b)) return 'コンベア駆動（ベルト/ストッパ）';
  if (/dofbot_camera_grab/.test(b)) return '知覚（手首カメラ撮像）';
  if (/tinyml_infer/.test(b)) return '認識（TinyML・機外へ出さない）';
  if (/atan2|acos/.test(b)) return '運動学（IK・純計算）';
  if (/array_set/.test(b) && /alloc/.test(b)) return '棚の在庫管理（スロット割当・出荷）';
  if (/write_file/.test(b)) return '安全監視（永続ログ）';
  if (/new ServoMotor/.test(b)) return '調整（12 Xinu 生成・巡回）';
  if (/motors\[/.test(b)) return '搬送（サーボへ駆動委譲）';
  if (/camera|recog|mover/.test(b)) return '動作計画（駆動権限なし）';
  return caps.net ? '通信' : '純計算';
}
function capsChips(caps) {
  return ['mut','ai','net','fs'].filter(k => caps[k]).map(k => `<span class="cap cap-${k}">!{${k}}</span>`).join('');
}

// AIPL シンタックスハイライト（推論の根拠となる primitive を桃色で強調）
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function highlight(code) {
  const h = esc(code).replace(new RegExp(`(//[^\\n]*)|("[^"]*")|\\b(${PRIM})\\b|\\b(${KW})\\b`, 'g'),
    (m, cm, str, prim, kw) => cm ? `<span class="tok-cm">${cm}</span>`
      : str ? `<span class="tok-str">${str}</span>`
      : prim ? `<span class="tok-prim">${prim}</span>`
      : `<span class="tok-kw">${kw}</span>`);
  return h.replace(/(<span class="tok-kw">class<\/span>\s+)(\w+)/g, '$1<span class="tok-cls">$2</span>');
}

// ===================== AIPL プログラムカウンタ =====================
// シミュレータのフェーズ ↔ AIPL ソース行 の対応。行番号を直接書かず、
// 「そのクラス本体の中でこの字面を含む最初の行」として解決するので、
// ソースを編集しても対応が壊れない。
const PCMAP = {
  'conveyor.arrived': ['ConveyorActor',   'stopped = 1'],
  'conveyor.feed':    ['ConveyorActor',   'dofbot_belt_drive(1)'],
  'conveyor.release': ['ConveyorActor',   'dofbot_belt_drive(2)'],
  'camera.capture':   ['CameraActor',     'dofbot_camera_grab()'],
  'recog.classify':   ['RecognitionActor','tinyml_infer(model, frame)'],
  'shelf.assign':     ['ShelfActor',      'array_set(used, shelf, n + 1)'],
  'shelf.ship':       ['ShelfActor',      'shipped = shipped + 1'],
  'plan.approach':    ['PlannerActor',    'now kin.solve(STX, STY + HOVER, STZ)'],
  'plan.ik':          ['PlannerActor',    'now kin.slot_pose(cls, slot)'],
  'open':             ['PlannerActor',    '// ①'],
  'inspect':          ['PlannerActor',    '// ②'],
  'descend':          ['PlannerActor',    '// ③'],
  'grasp':            ['PlannerActor',    '// ④'],
  'lift':             ['PlannerActor',    '// ⑤'],
  'swing':            ['PlannerActor',    '// ⑥'],
  'over':             ['PlannerActor',    '// ⑦'],
  'place':            ['PlannerActor',    '// ⑧'],
  'release':          ['PlannerActor',    '// ⑨'],
  'retreat':          ['PlannerActor',    '// ⑩'],
  'home':             ['PlannerActor',    '// ⑪'],
  'safety.complete':  ['SafetyActor',     'write_file("cycle.log", "shelf "'],
  'safety.abort':     ['SafetyActor',     'write_file("cycle.log", reason)'],
  'servo.write':      ['ServoMotor',      'Arm_serial_servo_write(id, angle, ms)'],
  'mover.to':         ['ArmMover',        'now m.write(q[j], ms)'],
  'kin.solve':        ['Kinematics',      'var beta = acos(cosB)'],
};
let PC = {};              // key → 行番号(1始まり)
let LINES = [];           // 行番号(1始まり) → 行の DOM

function resolvePC(text, classes) {
  const lines = text.split('\n');
  const lineOf = idx => text.slice(0, idx).split('\n').length;      // char offset → 行番号
  const out = {};
  for (const [key, [clsName, needle]] of Object.entries(PCMAP)) {
    const cls = classes[clsName]; if (!cls) continue;
    const from = lineOf(cls.start), to = lineOf(cls.end);
    for (let i = from - 1; i < to; i++) {
      if (lines[i].includes(needle)) { out[key] = i + 1; break; }
    }
  }
  const missing = Object.keys(PCMAP).filter(k => !out[k]);
  if (missing.length) log('AICE', `PC 未解決: ${missing.join(', ')}`);
  return out;
}

// 行番号つきでソース全体を描画（行番号が絶対なのでハイライトが安定する）
function renderSource(text) {
  const html = highlight(text).split('\n');
  ui.sourceView.innerHTML = '';
  LINES = [null];
  const frag = document.createDocumentFragment();
  html.forEach((h, i) => {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<span class="gut">${i + 1}</span><span class="ln">${h || ' '}</span>`;
    frag.append(row); LINES.push(row);
  });
  ui.sourceView.append(frag);
}

let pcRow = null, pcKey = null;
function setPC(key, actor) {
  const line = PC[key]; if (!line || line === pcKey) { pcKey = line; return; }
  pcKey = line;
  pcRow?.classList.remove('pc');
  pcRow = LINES[line]; if (!pcRow) return;
  pcRow.classList.add('pc');
  ui.pcActor.textContent = actor ?? '';
  ui.pcLine.textContent = `${PCMAP[key][0]} : ${line} 行目`;
  if (ui.follow.checked) pcRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ===================== 画面構築（12 Xinu + アプリ層） =====================
let CLASSES = {}, INFO = {}, FULLSRC = '';
// AIPL のクラスと一対一。ここに AIPL に無い名前を書くと INFO[name] が undefined で
// カード生成が例外になり、ソース表示ごと落ちる（実際に落とした）ので buildCards 側で防ぐ。
const APP_ACTORS = ['ConveyorActor','CameraActor','RecognitionActor','Kinematics',
                    'ShelfActor','PlannerActor','ArmMover','SafetyActor','Coordinator'];
const SERVOS = [   // 実機 DOFBOT のサーボ割当（6軸 = 6 サーボ, ID6 がグリッパ）
  { id: 1, name: 'ベース旋回' }, { id: 2, name: '肩' }, { id: 3, name: '肘' },
  { id: 4, name: '手首ピッチ' }, { id: 5, name: '手首回転' }, { id: 6, name: 'グリッパ' },
];

function focusClass(clsName) {
  ui.srcTarget.textContent = clsName;
  document.querySelectorAll('.row.focus').forEach(r => r.classList.remove('focus'));
  const cls = CLASSES[clsName]; if (!cls) return;
  const lineOf = idx => FULLSRC.slice(0, idx).split('\n').length;
  const from = lineOf(cls.start), to = lineOf(cls.end);
  for (let i = from; i <= to; i++) LINES[i]?.classList.add('focus');
  LINES[from]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function showAll() {
  ui.srcTarget.textContent = '全体';
  document.querySelectorAll('.row.focus').forEach(r => r.classList.remove('focus'));
  ui.sourceView.scrollTop = 0;
}

function card(actorId, clsName, title, servoId) {
  const info = INFO[clsName];
  if (!info) {   // AIPL に無いクラスを参照した = 対応表がずれている。黙って落とさず報告する
    log('AICE', `カード生成: AIPL に class ${clsName} が無い（対応表がずれている）`);
    return null;
  }
  const div = document.createElement('div'); div.className = 'actor';
  div.dataset.actor = actorId; div.dataset.cls = clsName;
  // servoId があれば、CG のホーン(銀色丸)に焼いてある番号と同じ丸バッジを出す
  div.innerHTML = (servoId ? `<b class="horn">${servoId}</b>` : '')
    + `<strong>${title}</strong><span class="role">${info.role}</span>`
    + (servoId ? `<span class="sv" data-sv="${servoId}">—</span>` : '')
    + `<div class="caps">${capsChips(info.caps)}</div>`;
  div.addEventListener('click', () => focusClass(clsName));
  return div;
}
function groupHead(text) {
  const d = document.createElement('div'); d.className = 'group-head'; d.textContent = text; return d;
}
function buildCards() {
  ui.actorGrid.innerHTML = '';
  ui.actorGrid.append(groupHead('物理層 — 12 Xinu（6 サーボ × 2）／番号は CG の銀色ホーンと一致'));
  for (const sv of SERVOS) {
    for (const [sfx, cls] of [['A', 'ServoMotor'], ['B', 'ServoSensor']]) {
      const el = card(`ID${sv.id}-${sfx}`, cls, `ID${sv.id}-${sfx} · ${sv.name}`, sv.id);
      if (el) ui.actorGrid.append(el);
    }
  }
  ui.actorGrid.append(groupHead('アプリ層アクター — Raspberry Pi 5'));
  for (const name of APP_ACTORS) { const el = card(name, name, name); if (el) ui.actorGrid.append(el); }
}

// 棚の在庫表示
function buildShelfPanel() {
  ui.shelfPanel.innerHTML = '';
  for (const rack of simulator.racks) {
    const d = document.createElement('div'); d.className = 'rack';
    d.innerHTML = `<span class="rack-name" style="color:#${rack.hex.toString(16).padStart(6,'0')}">${rack.label}</span>`
      + `<div class="slots">${rack.slots.map((_, i) => `<i data-slot="${rack.key}${i}"></i>`).join('')}</div>`
      + `<span class="rack-n" data-n="${rack.key}">0/${L.SLOTS_PER_RACK}</span>`;
    ui.shelfPanel.append(d);
  }
}
function refreshShelves() {
  for (const rack of simulator.racks) {
    let n = 0;
    rack.slots.forEach((s, i) => {
      const el = ui.shelfPanel.querySelector(`[data-slot="${rack.key}${i}"]`);
      const on = !!s.part; if (on) n++;
      el.style.background = on ? `#${rack.hex.toString(16).padStart(6,'0')}` : 'transparent';
      el.style.borderColor = `#${rack.hex.toString(16).padStart(6,'0')}`;
    });
    ui.shelfPanel.querySelector(`[data-n="${rack.key}"]`).textContent = `${n}/${L.SLOTS_PER_RACK}`;
  }
}

function setActive(name) { activeApp = name; }
function log(actor, text) {
  const line = document.createElement('div'); line.textContent = `[${actor}] ${text}`; ui.log.prepend(line);
  while (ui.log.children.length > 18) ui.log.lastChild.remove();
}
function refresh() {
  ui.processed.textContent = stats.processed; ui.success.textContent = stats.success;
  ui.failed.textContent = stats.failed; ui.messages.textContent = runtime.messageCount;
  ui.graspErr.textContent = stats.graspErr.toFixed(1);
  ui.visionAcc.textContent = stats.seen ? (100 * stats.correct / stats.seen).toFixed(0) : '—';
  const aj = simulator.activeServo;
  document.querySelectorAll('.actor').forEach(el => {
    const id = el.dataset.actor;
    const on = (aj >= 0 && (id === `ID${aj+1}-A` || id === `ID${aj+1}-B`)) || id === activeApp;
    el.classList.toggle('active', on);
  });
}

// ===================== アクター実装（AIPL と 1:1 対応） =====================
class ConveyorActor extends BaseActor {
  arrived(part) {
    setPC('conveyor.arrived', 'ConveyorActor');
    this.log('ストッパで停止 → まず撮像姿勢へ（見てから決める）');
    this.send('PlannerActor', 'approach', part);
  }
  release(part) {
    setPC('conveyor.release', 'ConveyorActor');
    this.log('belt_drive(2) → 不良品をベルト端から排出');
    simulator.reject(part); busy = false;
  }
  feed() { this.log('belt_drive(1) → 次の部品を停止位置へ'); }
}
class CameraActor extends BaseActor {
  // 手首カメラを実際に描画してピクセルを読む。これが camera_grab の実体。
  capture(part) {
    setPC('camera.capture', 'CameraActor');
    if (ui.cameraFault.checked) {
      this.log('camera_grab 失敗 (障害注入)');
      this.send('SafetyActor', 'abort', part, 'camera unavailable'); return;
    }
    const frame = simulator.grabWristFrame();
    drawWrist(frame);
    const feat = TM.features(frame);
    this.log(`camera_grab → ${frame.res}x${frame.res} を撮像 → 特徴 ${feat.length} 次元`);
    this.send('RecognitionActor', 'classify', part, feat);
  }
}
class RecognitionActor extends BaseActor {
  // TinyML の出力だけで棚を決める。part の色は「答え合わせ」にしか使わない
  // ので、誤認識すれば本当に違う色の棚へ運ばれる。
  classify(part, feat) {
    setPC('recog.classify', 'RecognitionActor');
    if (!MODEL) { this.log('TinyML モデル未読込 → 中断'); busy = false; return; }
    const r = TM.infer(MODEL, feat);
    const truth = part.userData.color;
    showRecognition(r, truth);
    stats.seen++; if (r.label === truth) stats.correct++;
    const shelf = { red:'A', blue:'B', green:'C' }[r.label];
    this.log(`tinyml_infer → "${r.label}" 信頼度 ${(r.conf*100).toFixed(1)}% → 棚${shelf}`
      + (r.label === truth ? '' : `  ※誤認識(正解 ${truth})`));
    this.send('ShelfActor', 'assign', part, r.label, shelf);
  }
}
class ShelfActor extends BaseActor {
  assign(part, color, shelf) {
    setPC('shelf.assign', 'ShelfActor');
    if (simulator.rackFull(color)) this.ship(color, shelf);      // now self.ship(shelf)
    const got = simulator.allocSlot(color);
    if (!got) { this.log(`棚${shelf} に空きなし`); busy = false; return; }
    this.log(`shelf_alloc(${shelf}) → 段${got.slot.tier + 1}・枠${got.slot.slot + 1}`);
    this.send('PlannerActor', 'place', part, shelf, got);
  }
  ship(color, shelf) {
    setPC('shelf.ship', 'ShelfActor');
    const n = simulator.shipRack(color);
    this.log(`file_write(shipment.log, ${shelf}) → 棚${shelf} 満杯につき ${n} 個を出荷`);
    refreshShelves();
  }
}
class PlannerActor extends BaseActor {
  // ①② 撮像姿勢へ。到着してから CameraActor に撮らせる。
  approach(part) {
    setPC('plan.approach', 'PlannerActor');
    this.log('inverse_kinematics → 部品の真上(撮像姿勢)を解く');
    simulator.beginApproach(part, () => this.send('CameraActor', 'capture', part));
  }
  // ③〜⑪ 認識結果で決まった棚へ運ぶ
  place(part, shelf, got) {
    setPC('plan.ik', 'PlannerActor');
    this.log(`inverse_kinematics → 把持/搬送/設置の姿勢を生成 (棚${shelf})`);
    simulator.beginPickPlace(part, got.rack, got.slot, res => {
      stats.graspErr = res.graspErr * L.UNIT_MM;
      this.send('SafetyActor', 'complete', res, shelf);
    });
    refreshShelves();
  }
}
class ArmMover extends BaseActor { to() { setPC('mover.to', 'ArmMover'); } }
class SafetyActor extends BaseActor {
  complete(res, shelf) {
    setPC('safety.complete', 'SafetyActor');
    stats.processed++; stats.success++;
    this.log(`file_write(cycle.log, ${shelf}) → 把持誤差 ${(res.graspErr * L.UNIT_MM).toFixed(2)}mm / 設置誤差 ${(res.placeErr * L.UNIT_MM).toFixed(2)}mm`);
    busy = false;
    refreshShelves(); refresh();
    this.send('Coordinator', 'next');
  }
  abort(part, reason) {
    setPC('safety.abort', 'SafetyActor');
    stats.processed++; stats.failed++;
    this.log(`file_write(cycle.log, ${reason})`);
    this.send('ConveyorActor', 'release', part);
    refresh();
  }
}
class Coordinator extends BaseActor {
  next() { this.send('ConveyorActor', 'feed'); }
  halt() { this.log('halt'); }
}

const runtime = new ActorRuntime({ onLog: log, onActivity: setActive });
runtime.register('ConveyorActor', new ConveyorActor());
runtime.register('CameraActor', new CameraActor());
runtime.register('RecognitionActor', new RecognitionActor());
runtime.register('ShelfActor', new ShelfActor());
runtime.register('PlannerActor', new PlannerActor());
runtime.register('ArmMover', new ArmMover());
runtime.register('SafetyActor', new SafetyActor());
runtime.register('Coordinator', new Coordinator());

// ===================== サイクル駆動 =====================
// 部品がストッパで停止し、かつアームが空いていれば次のサイクルを起動する。
// → 掴んで棚へ置く動作が途切れずに繰り返される。
let busy = false;
function pump() {
  if (!simulator.running || busy || simulator.cycle) return;
  const part = simulator.stationPart;
  if (!part) return;
  busy = true;
  runtime.send('ConveyorActor', 'arrived', part);
}

simulator.onPhase = (key, label) => { setPC(key, 'PlannerActor'); log('DOFBOT', label); };
simulator.onServo = angles => {
  document.querySelectorAll('.sv').forEach(el => {
    el.textContent = `${angles[Number(el.dataset.sv) - 1].toFixed(1)}°`;
  });
};
simulator.renderLoop(async () => { pump(); await runtime.step(); refresh(); });

function setRunning(v) {
  simulator.running = v; runtime.running = v;
  ui.statusBadge.textContent = v ? '実行中' : '停止中';
  ui.statusBadge.classList.toggle('on', v);
  log('AICE', v ? 'simulation started' : 'simulation paused');
}
document.getElementById('startBtn').addEventListener('click', () => setRunning(true));
document.getElementById('pauseBtn').addEventListener('click', () => setRunning(false));
document.getElementById('spawnBtn').addEventListener('click', () => simulator.spawnPart());
document.getElementById('resetBtn').addEventListener('click', () => {
  setRunning(false); simulator.reset(); runtime.queue = []; runtime.messageCount = 0; busy = false;
  stats = { processed:0, success:0, failed:0, graspErr:0, seen:0, correct:0 };
  ui.log.innerHTML = ''; refreshShelves(); refresh(); log('AICE','simulation reset');
});
document.getElementById('srcAll').addEventListener('click', showAll);
ui.speed.addEventListener('input', () => { simulator.speed = Number(ui.speed.value); });

// ソース取得 → 効果推論 → カード生成 → PC 解決
fetch('./aipl/dofbot_xinu.abcl').then(r => r.text()).then(text => {
  FULLSRC = text; CLASSES = parseClasses(text);
  for (const [name, cls] of Object.entries(CLASSES)) {
    const { caps, missing } = inferCaps(cls);
    INFO[name] = { caps, missing, role: inferRole(caps, cls) };
    if (missing.length) log('AICE', `${name}: 申告漏れ ${missing.map(e => '!{'+e+'}').join('')}`);
  }
  buildCards(); renderSource(text); PC = resolvePC(text, CLASSES);
  log('AICE', `効果推論完了: ${Object.keys(CLASSES).length} クラス → Capability を導出`);
  log('AICE', `AIPL 行対応を解決: ${Object.keys(PC).length} 箇所`);
}).catch(e => { ui.sourceView.textContent = e.message; });

buildShelfPanel(); refreshShelves();
log('AICE', 'DOFBOT 12-Xinu actor runtime initialized');
refresh();
if (new URLSearchParams(location.search).has('auto')) setRunning(true);   // ?auto で自動開始

// ヘッドレス検証用フック
window.__sim = { simulator, stats: () => stats, runtime, L, TM, model: () => MODEL };
