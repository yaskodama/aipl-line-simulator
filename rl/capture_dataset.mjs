#!/usr/bin/env node
// capture_dataset.mjs —— TinyML の学習データを「実際の手首カメラ描画」から作る
// ===========================================================================
// シミュレータをヘッドレスで開き、部品をコンベア停止位置に置いてアームを撮像姿勢へ動かし、
// 手首カメラの WebGL 描画結果を読み出して特徴量に変換し、ラベル付きで dump する。
// 部品の位置・向き・撮像高さ・アームのばらつきを振って、実運転で出る見え方を網羅する。
//
//   node rl/capture_dataset.mjs            # → rl/dataset.json
//   N_PER_CLASS=200 node rl/capture_dataset.mjs
// ===========================================================================
import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = process.env.URL ?? 'http://127.0.0.1:8022/index.html';
const N = Number(process.env.N_PER_CLASS ?? 160);

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=metal'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700 });
page.on('pageerror', e => { console.error('pageerror:', e.message); });
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__sim !== undefined', { timeout: 15000 });

console.log(`手首カメラから学習データを収集: ${N} 枚 x 3 クラス`);

const data = await page.evaluate(async (N) => {
  const { simulator, L } = window.__sim;
  const tm = await import('./src/tinyml.js');
  const THREE = simulator.gripTip.constructor;   // 既に読み込まれている three を使う

  const rnd = (() => { let s = 12345;            // 再現可能な擬似乱数
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();

  simulator.running = false;
  simulator.reset();
  const out = { X: [], y: [], meta: [] };
  const classes = ['red', 'blue', 'green'];

  for (let ci = 0; ci < classes.length; ci++) {
    for (let n = 0; n < N; n++) {
      const part = simulator.spawnPart(classes[ci]);
      // 実運転のばらつきを再現: 停止位置の誤差・向き・撮像高さ
      const jx = (rnd() - 0.5) * 0.06, jz = (rnd() - 0.5) * 0.06;
      part.position.set(L.STATION.x + jx, L.STATION.y, L.STATION.z + jz);
      part.rotation.y = rnd() * Math.PI * 2;
      const hover = L.HOVER * (0.82 + 0.36 * rnd());

      // 撮像姿勢へ（実際に IK を解いて動かす。カメラの見え方は姿勢で変わる）
      const ikmod = await import('./src/ik.js');
      const q = ikmod.solveIK(part.position.x, part.position.y + hover, part.position.z).q;
      simulator.applyJoints(q);
      simulator.setGrip(1);

      const frame = simulator.grabWristFrame();
      out.X.push(tm.features(frame));
      out.y.push(ci);
      out.meta.push({ hover: +hover.toFixed(3), rotY: +part.rotation.y.toFixed(3) });

      simulator.scene.remove(part);
      simulator.parts = simulator.parts.filter(p => p !== part);
    }
  }
  return out;
}, N);

// 「全部同じ絵」になっていないか（＝カメラが部品を捉えているか）を確認する
const varOf = k => {
  const col = data.X.map(x => x[k]);
  const m = col.reduce((a, b) => a + b, 0) / col.length;
  return col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length;
};
const vars = Array.from({ length: data.X[0].length }, (_, k) => varOf(k));
const maxVar = Math.max(...vars);

const path = join(HERE, 'dataset.json');
writeFileSync(path, JSON.stringify(data));
console.log(`${data.X.length} 枚 / 特徴 ${data.X[0].length} 次元 → ${path}`);
console.log(`特徴量の最大分散 ${maxVar.toFixed(4)} ${maxVar > 0.001 ? '✓ 画像に差がある' : '✗ 全部同じ絵（カメラが部品を見ていない）'}`);
await browser.close();
if (!(maxVar > 0.001)) process.exit(1);
