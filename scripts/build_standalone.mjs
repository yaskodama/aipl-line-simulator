// build_standalone.mjs — DOFBOT シミュレータを「サーバー不要」の 1 枚 HTML に固める。
//
// file:// で開いた HTML は ES モジュールを相対パスで import できない（CORS）ため、
// 全モジュールのソースを文字列として埋め込み、実行時に Blob URL 化して
// 依存の順に import する（=ブラウザ内ミニバンドラ）。three.js も CDN ではなく同梱するので
// 完全オフラインで動く。fetch していた AIPL ソースと TinyML 重みは fetch シムで返す。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;   // scripts/ の一つ上 = リポジトリ直下
const VENDOR = join(ROOT, 'vendor');                     // three.js は CDN でなく同梱する
const OUT = process.argv[2] || join(ROOT, 'standalone.html');

const read = p => readFileSync(p, 'utf8');

// 依存の浅い順。specifier → モジュール ID の書き換え表つき。
const MODULES = [
  { id: 'three',       src: read(join(VENDOR, 'three.module.min.js')), map: {} },
  { id: 'orbit',       src: read(join(VENDOR, 'OrbitControls.js')),    map: { 'three': 'three' } },
  { id: 'ik',          src: read(join(ROOT, 'src/ik.js')),             map: {} },
  { id: 'layout',      src: read(join(ROOT, 'src/layout.js')),         map: {} },
  { id: 'tinyml',      src: read(join(ROOT, 'src/tinyml.js')),         map: {} },
  { id: 'aipl_runtime',src: read(join(ROOT, 'src/aipl_runtime.js')),   map: {} },
  { id: 'simulator',   src: read(join(ROOT, 'src/simulator.js')),      map: {
      'https://cdn.jsdelivr.net/npm/three@0.164.1/+esm': 'three',
      'https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/controls/OrbitControls.js/+esm': 'orbit',
      './ik.js': 'ik', './layout.js': 'layout' } },
  { id: 'main',        src: read(join(ROOT, 'src/main.js')),           map: {
      './aipl_runtime.js': 'aipl_runtime', './simulator.js': 'simulator',
      './tinyml.js': 'tinyml', './layout.js': 'layout' } },
];

// import 指定子を実行時に差し替えるプレースホルダへ。取りこぼしたら即エラーにする。
for (const m of MODULES) {
  for (const [spec, dep] of Object.entries(m.map)) {
    const before = m.src;
    for (const q of ["'", '"']) m.src = m.src.split(q + spec + q).join(q + `__MOD:${dep}__` + q);
    if (m.src === before) throw new Error(`${m.id}: import '${spec}' が見つからない`);
  }
  const leftover = m.src.match(/from\s+['"](?!__MOD:)[^'"]+['"]/g);
  if (leftover) throw new Error(`${m.id}: 未解決の import → ${leftover.join(', ')}`);
}

const ASSETS = {
  './aipl/dofbot_xinu.abcl': read(join(ROOT, 'aipl/dofbot_xinu.abcl')),
  './aipl/tinyml_model.json': read(join(ROOT, 'aipl/tinyml_model.json')),
};

const loader = `
// ── サーバー無しで動かすためのローダ ───────────────────────────────────
// ① fetch シム：元コードが読んでいた AIPL ソースと TinyML 重みは埋め込み済みの文字列を返す
const ASSETS = ${JSON.stringify(ASSETS)};
const realFetch = window.fetch ? window.fetch.bind(window) : null;
window.fetch = (input, init) => {
  const key = String(input && input.url ? input.url : input);
  const hit = Object.keys(ASSETS).find(k => key === k || key.endsWith(k.replace('./', '/')));
  if (hit) return Promise.resolve(new Response(ASSETS[hit], {
    status: 200, headers: { 'content-type': hit.endsWith('.json') ? 'application/json' : 'text/plain' } }));
  if (realFetch) return realFetch(input, init);
  return Promise.reject(new Error('offline: ' + key));
};

// ② ミニバンドラ：埋め込みソースを Blob URL 化し、依存の順に import する
const SOURCES = ${JSON.stringify(MODULES.map(m => [m.id, m.src]))};
const urls = {};
for (const [id, src0] of SOURCES) {
  const src = src0.replace(/__MOD:([a-z_]+)__/g, (_, d) => urls[d]);
  urls[id] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
}
try {
  await import(urls.main);
} catch (e) {
  document.body.insertAdjacentHTML('afterbegin',
    '<pre style="color:#f87171;background:#111;padding:12px;white-space:pre-wrap">起動に失敗: ' +
    String(e && e.stack || e).replace(/</g, '&lt;') + '</pre>');
  throw e;
}
`;

// 置換文字列に $& 等が混ざる（three.min.js や CSS が含む）ので、必ず関数で差し込む。
const swap = (s, from, to) => s.replace(from, () => to);

let html = read(join(ROOT, 'index.html'));
html = swap(html, '<link rel="stylesheet" href="./styles.css" />',
  '<style>\n' + read(join(ROOT, 'styles.css')) + '\n</style>');
// 埋め込みソース中の </script> は HTML パーサに拾われるため、JS 文字列として無害な形へ。
const safeLoader = loader.split('</script').join('<\\/script');
html = swap(html, '<script type="module" src="./src/main.js"></script>',
  '<script type="module">\n' + safeLoader + '\n</script>');
html = swap(html, '</title>', '（スタンドアロン版・サーバー不要）</title>');
if (html.includes('src="./src/main.js"') || html.includes('href="./styles.css"'))
  throw new Error('index.html の差し替えに失敗');

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${(html.length / 1e6).toFixed(2)} MB)`);
