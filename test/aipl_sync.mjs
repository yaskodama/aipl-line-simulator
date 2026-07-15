#!/usr/bin/env node
// aipl_sync.mjs —— ブラウザ側 (src/main.js) と AIPL (aipl/dofbot_xinu.abcl) のズレを検出する。
// ===========================================================================
// 両者は「字面」で結合している（PCMAP の needle、primitive 名、クラス名）。
// AIPL を書き換えるとこの結合は黙って切れ、画面は例外なしで
// 「効果チップが消える」「行が光らない」だけになる —— 実際にそう壊れた。
// ブラウザ不要・一瞬で終わるので、AIPL を触ったら必ず通すこと。
//
//   node test/aipl_sync.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'aipl/dofbot_xinu.abcl'), 'utf8');
const js = readFileSync(join(ROOT, 'src/main.js'), 'utf8');
const fail = [];

// ---- main.js の推論エンジンをそのまま読み込んで動かす（コピーを作らない）----
const pre = js.slice(js.indexOf('const PRIM ='), js.indexOf('function closeFrom'));
const core = js.slice(js.indexOf('function closeFrom'), js.indexOf('// AIPL シンタックスハイライト'));
const engine = new Function('src', `${pre}${core}
  const classes = parseClasses(src);
  return { classes: Object.keys(classes),
           caps: Object.fromEntries(Object.entries(classes).map(([n,c]) => [n, inferCaps(c)])) };`);
const { classes, caps } = engine(src);

// ---- 1) クラス名: main.js が参照するクラスが AIPL に実在するか ----
const app = JSON.parse(js.match(/const APP_ACTORS = (\[[\s\S]*?\])/)[1].replace(/'/g, '"').replace(/\s+/g, ' '));
const ghost = app.filter(a => !classes.includes(a));
console.log(`■ アクター: AIPL ${classes.length} クラス / カード ${app.length} + サーボ 2`);
if (ghost.length) fail.push(`AIPL に無いクラスをカードが参照: ${ghost.join(', ')}（カード生成が例外になり、ソース表示ごと落ちる）`);
for (const need of ['ServoMotor', 'ServoSensor']) {
  if (!classes.includes(need)) fail.push(`AIPL に class ${need} が無い（12 Xinu のカードが作れない）`);
}
const orphan = classes.filter(c => !app.includes(c) && !['ServoMotor', 'ServoSensor'].includes(c));
if (orphan.length) fail.push(`AIPL にあるのにカードに出ないクラス: ${orphan.join(', ')}`);

// ---- 2) primitive: 推論に使う名前が AIPL に実在するか ----
const lists = { MUT_PRIM: 'mut', AI_PRIM: 'ai', FS_PRIM: 'fs', NET_PRIM: 'net' };
console.log('■ 効果推論に使う primitive');
for (const [name, eff] of Object.entries(lists)) {
  const arr = JSON.parse(js.match(new RegExp(`const ${name}\\s*=\\s*(\\[[^\\]]+\\])`))[1].replace(/'/g, '"'));
  const dead = arr.filter(p => !new RegExp(`\\b${p}\\b`).test(src));
  console.log(`   ${name.padEnd(9)} → !{${eff}}  ${arr.length} 個 / AIPL に無い ${dead.length} 個`);
  // NET/FS は AIPL が使わない組込みを含んでよい（remote 等）。mut/ai は要でなければ推論が死ぬ
  if (eff === 'mut' && dead.length === arr.length) fail.push(`mut を判定する primitive が AIPL に 1 つも無い`);
}

// ---- 3) PCMAP: 探している字面が、そのクラスの本体に実在するか ----
const map = js.match(/const PCMAP = \{([\s\S]*?)\n\};/)[1];
const rows = [...map.matchAll(/'([\w.]+)':\s*\['(\w+)',\s*'(.+?)'\],/g)];
const lineOf = i => src.slice(0, i).split('\n').length;
let unresolved = 0;
for (const [, key, cls, needle] of rows) {
  const at = src.indexOf(`class ${cls} {`);
  if (at < 0) { fail.push(`PCMAP ${key}: AIPL に class ${cls} が無い`); unresolved++; continue; }
  // クラス本体の行範囲に限って探す（resolvePC と同じ規約）
  let depth = 0, end = at;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) { end = j; break; }
  }
  if (!src.slice(at, end).includes(needle)) {
    fail.push(`PCMAP ${key}: class ${cls} に字面 "${needle}" が無い（その行は光らない）`);
    unresolved++;
  }
}
console.log(`■ AIPL 行対応 (PCMAP): ${rows.length} 件 / 未解決 ${unresolved} 件`);

// ---- 4) 効果: 推論した効果が、ソースの申告に含まれているか ----
// 申告が推論より広いのは正常（呼び出し先から伝播する効果を申告しているため。
// 実処理系は伝播を追うが、こちらは直接の primitive しか見ない）。
// 逆に「推論したのに申告していない」は申告漏れ＝実処理系が弾くべきもの。
console.log('■ 効果: 推論 ⊆ 申告');
let leak = 0;
for (const [n, r] of Object.entries(caps)) {
  const inf = ['mut', 'ai', 'net', 'fs'].filter(k => r.caps[k]);
  if (inf.length === 0) { fail.push(`${n}: 効果が 1 つも推論されなかった（メソッド解析が壊れている疑い）`); continue; }
  if (r.missing.length) { fail.push(`${n}: 申告漏れ !{${r.missing.join(',')}}`); leak++; }
}
console.log(`   ${Object.keys(caps).length} クラス / 申告漏れ ${leak} 件`);

console.log('');
if (fail.length) { console.log('✗ ブラウザ側と AIPL がずれている:'); fail.forEach(f => console.log('   -', f)); process.exit(1); }
console.log('✓ ブラウザ側と AIPL は同期している');
