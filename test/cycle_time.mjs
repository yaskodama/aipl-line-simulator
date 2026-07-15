#!/usr/bin/env node
// cycle_time.mjs —— 強化学習の主張（サイクル短縮）を実走行で確かめる。
// 学習側は自前の力学モデルで時間を計算しているだけなので、実際に 3Dsim を
// 回して「①開く から ⑪ホーム まで」の実測時間を測り、突き合わせる。
//
//   node test/cycle_time.mjs
import puppeteer from 'puppeteer';

const URL = process.env.URL ?? 'http://127.0.0.1:8022/index.html?auto';
const N = Number(process.env.N ?? 5);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-webgl', '--use-gl=angle', '--use-angle=metal'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700 });
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__sim !== undefined');

// フェーズ①(open)から⑪(home)完了までを、シミュレータ内部の時計で測る
await page.evaluate(() => {
  const { simulator } = window.__sim;
  window.__ct = { cycles: [], t: 0, mark: null };
  const origUpdate = simulator.update.bind(simulator);
  simulator.update = dt => {
    origUpdate(dt);
    if (simulator.running) window.__ct.t += dt * simulator.speed;   // sim 内時間
  };
  const origPhase = simulator.onPhase;
  simulator.onPhase = (k, l) => {
    if (k === 'open') window.__ct.mark = window.__ct.t;
    origPhase?.(k, l);
  };
  const origDone = simulator.beginPickPlace.bind(simulator);
  simulator.beginPickPlace = (part, rack, slot, done) => origDone(part, rack, slot, res => {
    if (window.__ct.mark !== null) window.__ct.cycles.push(window.__ct.t - window.__ct.mark);
    done(res);
  });
});

process.stdout.write(`${N} サイクルぶん実走行`);
await page.waitForFunction(`window.__ct.cycles.length >= ${N}`, { timeout: 180000, polling: 1000 })
  .catch(() => {});
console.log('');

const R = await page.evaluate(() => ({
  cycles: window.__ct.cycles,
  nominal: window.__sim.L.CYCLE_SEC,
  T: window.__sim.L.T,
}));
await browser.close();

if (!R.cycles.length) { console.log('✗ サイクルを 1 つも完走できなかった'); process.exit(1); }
const avg = R.cycles.reduce((a, b) => a + b, 0) / R.cycles.length;
const lo = Math.min(...R.cycles), hi = Math.max(...R.cycles);
console.log(`実測サイクル時間 : ${avg.toFixed(3)} 秒  (${R.cycles.length} 回 / 最小 ${lo.toFixed(3)} / 最大 ${hi.toFixed(3)})`);
console.log(`layout.js の合計 : ${R.nominal.toFixed(3)} 秒`);
const drift = Math.abs(avg - R.nominal);
console.log(`差              : ${drift.toFixed(3)} 秒  ${drift < 0.15 ? '✓ 設定どおり動いている' : '✗ 設定と実走行がずれている'}`);
console.log('\n各フェーズ[秒]: ' + Object.entries(R.T).map(([k, v]) => `${k} ${v}`).join(' / '));
process.exit(drift < 0.15 ? 0 : 1);
