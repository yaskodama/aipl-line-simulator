import puppeteer from 'puppeteer';

const URL = 'http://127.0.0.1:8022/index.html?auto';
const RUN_MS = Number(process.env.RUN_MS ?? 60000);

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !t.includes('favicon') && !t.includes('404')) errors.push(`console: ${t}`); });
page.on('requestfailed', r => { if (!r.url().includes('favicon')) errors.push(`requestfailed: ${r.url()}`); });

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__sim !== undefined', { timeout: 10000 });

// 掴んだ瞬間の「把持点↔部品中心」距離と、置いた先の棚の色を毎サイクル記録する
await page.evaluate(() => {
  const { simulator } = window.__sim;
  window.__rec = { grasps: [], places: [], ships: [], maxTipErr: 0, phases: new Set(), servoFaults: [], servoMin: [999,999,999,999,999,999], servoMax: [-999,-999,-999,-999,-999,-999] };
  simulator.onServoFault = ids => window.__rec.servoFaults.push(ids.join(','));
  simulator.onServo = a => a.forEach((v, i) => { window.__rec.servoMin[i] = Math.min(window.__rec.servoMin[i], v); window.__rec.servoMax[i] = Math.max(window.__rec.servoMax[i], v); });
  const origBegin = simulator.beginCycle.bind(simulator);
  simulator.beginCycle = (part, rack, slot, done) => origBegin(part, rack, slot, res => {
    window.__rec.grasps.push(res.graspErr);
    window.__rec.places.push({
      partColor: res.part.userData.color, rackColor: res.rack.color, err: res.placeErr,
    });
    done(res);
  });
  const origPhase = simulator.onPhase;
  simulator.onPhase = (k, l) => { window.__rec.phases.add(k); origPhase?.(k, l); };
  // 把持中は毎フレーム、部品が本当にハンドに固定されているかを追跡
  const origUpdate = simulator.update.bind(simulator);
  simulator.update = dt => {
    origUpdate(dt);
    if (simulator.held) {
      const tip = simulator.tipWorld();
      const p = simulator.held.getWorldPosition(new (simulator.held.position.constructor)());
      window.__rec.maxTipErr = Math.max(window.__rec.maxTipErr, tip.distanceTo(p));
    }
  };
});

process.stdout.write('シミュレーション実行中');
const t0 = Date.now();
while (Date.now() - t0 < RUN_MS) {
  await new Promise(r => setTimeout(r, 5000));
  process.stdout.write('.');
}
console.log('');

const R = await page.evaluate(() => {
  const { simulator, stats, L } = window.__sim;
  const r = window.__rec;
  return {
    grasps: r.grasps, places: r.places, maxTipErr: r.maxTipErr,
    servoFaults: r.servoFaults, servoMin: r.servoMin, servoMax: r.servoMax,
    phases: [...r.phases],
    stats: stats(),
    unit: L.UNIT_MM,
    // 棚に残っている部品が本当に色一致の棚に入っているか、位置が正しいか
    shelfCheck: simulator.racks.flatMap(rack => rack.slots.filter(s => s.part?.userData.placed).map(s => ({
      rack: rack.color, part: s.part.userData.color,
      dist: s.part.getWorldPosition(new s.part.position.constructor())
        .distanceTo(new s.part.position.constructor(s.pos.x, s.pos.y, s.pos.z)),
    }))),
    pcResolved: document.getElementById('pcLine').textContent,
    servoText: [...document.querySelectorAll('.sv')].slice(0, 6).map(e => e.textContent),
  };
});

const mm = v => (v * R.unit).toFixed(3);
const fail = [];
console.log('\n=== 検証結果 ===');
console.log(`サイクル完了数        : ${R.grasps.length}`);
console.log(`成功 / 失敗 / 処理済み: ${R.stats.success} / ${R.stats.failed} / ${R.stats.processed}`);

if (R.grasps.length < 3) fail.push(`サイクルが繰り返されていない (完了 ${R.grasps.length} 件)`);

const maxGrasp = Math.max(0, ...R.grasps);
console.log(`把持誤差(最大)        : ${mm(maxGrasp)} mm  ← 指を閉じた瞬間の 把持点↔部品中心`);
if (maxGrasp * R.unit > 0.5) fail.push(`把持がずれている: ${mm(maxGrasp)}mm`);

console.log(`把持中の追従誤差(最大): ${mm(R.maxTipErr)} mm  ← 搬送中ずっとハンドに固定されているか`);
if (R.maxTipErr * R.unit > 0.5) fail.push(`搬送中に部品がハンドから離れている: ${mm(R.maxTipErr)}mm`);

const mismatch = R.places.filter(p => p.partColor !== p.rackColor);
console.log(`色の一致(置いた先)    : ${R.places.length - mismatch.length}/${R.places.length} 一致`);
if (mismatch.length) fail.push(`色違いの棚へ置いた: ${JSON.stringify(mismatch.slice(0, 3))}`);

const maxPlace = Math.max(0, ...R.places.map(p => p.err));
console.log(`設置誤差(最大)        : ${mm(maxPlace)} mm  ← 解放時の 部品↔スロット中心`);
if (maxPlace * R.unit > 1.0) fail.push(`設置位置がずれている: ${mm(maxPlace)}mm`);

const shelfBad = R.shelfCheck.filter(s => s.rack !== s.part);
const shelfOff = R.shelfCheck.filter(s => s.dist * R.unit > 1.0);
console.log(`棚に残る部品          : ${R.shelfCheck.length} 個 / 色違い ${shelfBad.length} 個 / 位置ずれ ${shelfOff.length} 個`);
if (shelfBad.length) fail.push(`棚に色違いの部品がある: ${JSON.stringify(shelfBad)}`);
if (shelfOff.length) fail.push(`棚の部品がスロットからずれている: ${JSON.stringify(shelfOff)}`);

const want = ['open','above','descend','grasp','lift','swing','over','place','release','retreat','home'];
const missing = want.filter(w => !R.phases.includes(w));
console.log(`Pick&Place フェーズ   : ${R.phases.length}/${want.length} 実行`);
if (missing.length) fail.push(`未実行のフェーズ: ${missing.join(',')}`);

console.log(`AIPL 行追従           : ${R.pcResolved}`);
console.log('サーボ指令角の実績範囲 (実機 DOFBOT は 0..180 が限界):');
['ID1 旋回','ID2 肩','ID3 肘','ID4 手首P','ID5 roll','ID6 grip'].forEach((n, i) => {
  const ok = i === 5 ? true : (R.servoMin[i] > 0 && R.servoMax[i] < 180);   // ID6 の 180 は「全開」で正常
  console.log(`   ${n.padEnd(9)} ${R.servoMin[i].toFixed(1).padStart(6)} .. ${R.servoMax[i].toFixed(1).padStart(6)}  ${ok ? '✓' : '✗ 可動域に張り付き'}`);
});
if (R.servoFaults.length) fail.push(`サーボ可動域の逸脱 ${R.servoFaults.length} フレーム (ID: ${[...new Set(R.servoFaults)].join(' / ')})`);
if (errors.length) fail.push(...errors.slice(0, 5));

await page.screenshot({ path: './test/sim.png' });
await browser.close();

console.log('');
if (fail.length) { console.log('✗ 失敗:'); fail.forEach(f => console.log('   -', f)); process.exit(1); }
console.log('✓ 全項目 合格');
