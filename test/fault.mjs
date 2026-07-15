import puppeteer from 'puppeteer';
// CameraActor 障害を注入 → 不良品が排出され、解除後にサイクルが復帰することを確認する。
// abort 経路で busy フラグが戻らないとラインが永久停止するので、そこが本題。
const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-webgl', '--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://127.0.0.1:8022/index.html?auto', { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__sim !== undefined');

await new Promise(r => setTimeout(r, 20000));
const before = await page.evaluate(() => window.__sim.stats());
console.log(`障害注入前 : 成功 ${before.success} / 失敗 ${before.failed}`);

await page.click('#cameraFault');                     // 障害 ON
await new Promise(r => setTimeout(r, 25000));
const during = await page.evaluate(() => window.__sim.stats());
console.log(`障害注入中 : 成功 ${during.success} / 失敗 ${during.failed}  ← 失敗が増えるはず`);

await page.click('#cameraFault');                     // 障害 OFF
await new Promise(r => setTimeout(r, 30000));
const after = await page.evaluate(() => window.__sim.stats());
console.log(`障害復旧後 : 成功 ${after.success} / 失敗 ${after.failed}  ← 成功が再び増えるはず`);

const stuck = await page.evaluate(() => {
  const { simulator } = window.__sim;
  return { onBelt: simulator.parts.filter(p => p.userData.onBelt).length, cycling: !!simulator.cycle };
});

const fail = [];
if (during.failed <= before.failed) fail.push('障害注入で不良品が排出されていない');
if (after.success <= during.success) fail.push('障害復旧後にサイクルが再開していない（busy フラグが戻っていない可能性）');
if (errors.length) fail.push(...errors);
console.log(`\nベルト上の部品 ${stuck.onBelt} / 動作中 ${stuck.cycling}`);
await browser.close();
if (fail.length) { console.log('✗ 失敗:'); fail.forEach(f => console.log('  -', f)); process.exit(1); }
console.log('✓ 障害注入 → 排出 → 復帰 が正しく巡回した');
