// Drives the dashboard in Chromium for tests/test_visual.py. Usage: node snap.js <baseUrl> <outDir> <fixedEpochMs>
// Prints one JSON object: structural snapshot, font checks, console errors, overflow widths.
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const [base, out, fixed] = process.argv.slice(2);
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    // a project-pinned playwright may lack its own browser build; use a provided Chromium instead
    const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
    browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  }
  const result = { errors: [], shots: [] };
  const open = async (width, height) => {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce',
      httpCredentials: { username: 'ops', password: 'visual-test' }, timezoneId: 'UTC', locale: 'en-US' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(Number(fixed)));
    page.on('console', (m) => { if (m.type() === 'error') result.errors.push(m.text()); });
    page.on('pageerror', (e) => result.errors.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => result.errors.push(`requestfailed: ${r.url()}`));
    await page.goto(base);
    // transient toasts are positioned against the viewport and land differently in full-page captures
    await page.evaluate(() => document.getElementById('toasts').style.setProperty('display', 'none', 'important'));
    await page.waitForSelector('.kpi-card .kpi-val');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    return { ctx, page };
  };

  const { ctx, page } = await open(1440, 900);
  result.fonts = await page.evaluate(() => ({
    geist: document.fonts.check('14px Geist'), mono: document.fonts.check('14px "Geist Mono"'),
    offenders: [...new Set([...document.querySelectorAll('body *')].map((el) => getComputedStyle(el).fontFamily)
      .filter((ff) => !/^"?Geist( Mono)?"?/.test(ff.split(',')[0].trim())))].slice(0, 10),
    svgText: [...new Set([...document.querySelectorAll('svg text')].map((el) => getComputedStyle(el).fontFamily.split(',')[0].trim()))],
  }));
  await page.click('.batch >> nth=0');
  await page.waitForTimeout(200);
  result.dom = await page.evaluate(() => ({
    kpis: [...document.querySelectorAll('.kpi-card')].map((k) => [k.querySelector('.kpi-top span').textContent.trim(), k.querySelector('.kpi-val b').textContent.trim()]),
    pulse: [document.querySelector('.pulse-center .val').textContent, ...[...document.querySelectorAll('#pulse .policy')].map((p) => p.textContent)],
    progress: [...document.querySelectorAll('#progress .check')].map((c) => c.textContent),
    runs: document.querySelectorAll('#runs tbody tr').length,
    pipeline: [...document.querySelectorAll('.stage')].map((s) => [s.querySelector('.stage-name').textContent, s.querySelector('.stage-count').firstChild.textContent]),
    filters: [...document.querySelectorAll('#f-status button')].map((b) => b.textContent),
    matrix: [...document.querySelectorAll('#matrix tbody tr')].map((tr) => [tr.cells[0].textContent, tr.cells[2].textContent]),
    insights: [...document.querySelectorAll('#insights .ins .i-title')].map((e) => e.textContent),
    lanes: !!document.querySelector('#lanes svg'), activityBars: document.querySelectorAll('#activity svg rect').length > 14,
  }));
  await page.click('.batch >> nth=0');
  await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
  result.shots.push('desktop.png');
  await page.goto(`${base}#task=pharmacy-campaign-repair-20261108-1306/DEV-13`);
  await page.waitForSelector('#dlg[open]');
  await page.waitForTimeout(250);
  result.dom.taskDialog = await page.evaluate(() => [document.getElementById('dlg-title').textContent, document.querySelector('#dlg-body .verdict').textContent]);
  await page.screenshot({ path: path.join(out, 'task-dialog.png') });
  result.shots.push('task-dialog.png');
  await ctx.close();

  const m = await open(390, 844);
  result.mobileScrollWidth = await m.page.evaluate(() => document.documentElement.scrollWidth);
  if (result.mobileScrollWidth > 390) result.mobileOverflowers = await m.page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.right > 392 && r.left < 380 && !e.closest('aside,dialog,[aria-hidden=true]'); })
    .slice(-8).map(e => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().right)} ${(e.textContent || '').slice(0, 60)}`));
  await m.page.screenshot({ path: path.join(out, 'mobile.png') });
  result.shots.push('mobile.png');
  await m.ctx.close();
  await browser.close();
  process.stdout.write(JSON.stringify(result));
})().catch((e) => { process.stdout.write(JSON.stringify({ fatal: String(e && e.stack || e) })); process.exit(1); });
