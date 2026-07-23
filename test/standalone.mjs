// standalone.html を file:// で開き、サーバー無しで実際に動くかを検証する。
import puppeteer from 'puppeteer';

const FILE = 'file://' + (process.argv[2] || `${process.env.HOME}/aipl_line_simulator/standalone.html`);
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--enable-webgl', '--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [], reqs = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('request', r => { if (!r.url().startsWith('file://') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) reqs.push(r.url()); });

await page.goto(FILE, { waitUntil: 'networkidle0' });
try {
  await page.waitForFunction('window.__sim !== undefined', { timeout: 20000 });
} catch (e) {
  console.log(JSON.stringify({ bootFailed: true, errors, externalRequests: reqs }, null, 2));
  await browser.close();
  process.exit(1);
}
await page.click('#startBtn');
await new Promise(r => setTimeout(r, 25000));

const out = await page.evaluate(() => ({
  stats: window.__sim.stats(),
  status: document.getElementById('statusBadge').textContent,
  srcLines: document.getElementById('sourceView').textContent.split('\n').length,
  cards: document.getElementById('actorGrid').children.length,
  log: document.getElementById('log').textContent.slice(-300),
  recog: document.getElementById('recogLabel').textContent,
  canvas: !!document.querySelector('#scene canvas'),
  model: !!window.__sim.model(),
}));
console.log(JSON.stringify({ out, externalRequests: reqs, errors }, null, 2));
await browser.close();
