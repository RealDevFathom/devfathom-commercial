// Generic UI step runner. Usage: node steps.mjs <role> <steps.json> [width]
// Step kinds: {goto}, {fill:{label|sel|placeholder}, value}, {select:{label|sel}, value|index}, {click:{text|role,name|sel}, nth?}, {press}, {wait:ms}, {waitText}, {map:true}, {shot:name, full?}, {eval:js}, {upload:{label|sel}, file}
import fs from 'node:fs';
import { roleContext, capture, closeBrowser, BASE, shot } from './lib.mjs';
const [role, stepsFile, width = '1440', height = '900'] = process.argv.slice(2);
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const ctx = await roleContext(role, { viewport: { width: +width, height: +height } });
const page = await ctx.newPage();
const log = capture(page);
page.setDefaultTimeout(15000);

function loc(t) {
  if (t.sel) return page.locator(t.sel);
  if (t.label) return page.getByLabel(t.label, { exact: t.exact ?? false });
  if (t.placeholder) return page.getByPlaceholder(t.placeholder);
  if (t.role) return page.getByRole(t.role, { name: t.name, exact: t.exact ?? false });
  if (t.text) return page.getByText(t.text, { exact: t.exact ?? false });
  throw new Error('bad locator ' + JSON.stringify(t));
}
async function dumpMap() {
  return page.evaluate(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const lab = (e) => {
      const id = e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
      return (
        e.getAttribute('aria-label') ||
        (id && id.innerText) ||
        e.closest('label')?.innerText ||
        e.placeholder ||
        e.name ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 50);
    };
    const main = document.querySelector('main') ?? document.body;
    const heads = [...main.querySelectorAll('h1,h2,h3')]
      .filter(vis)
      .map((h) => h.innerText.trim().replace(/\s+/g, ' ').slice(0, 60));
    const buttons = [...main.querySelectorAll('button,[role=button]')]
      .filter(vis)
      .map(
        (b) =>
          `${b.disabled ? '(x)' : ''}${(b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}`
      );
    const inputs = [...main.querySelectorAll('input,select,textarea')].filter(vis).map(
      (i) =>
        `${i.tagName.toLowerCase()}${i.type ? '[' + i.type + ']' : ''}${i.disabled ? '(x)' : ''}"${lab(i)}"=${JSON.stringify(i.tagName === 'SELECT' ? i.options[i.selectedIndex]?.text : i.value).slice(0, 30)}${
          i.tagName === 'SELECT'
            ? ' {' +
              [...i.options]
                .map((o) => o.text)
                .slice(0, 10)
                .join('/') +
              '}'
            : ''
        }`
    );
    const alerts = [...document.querySelectorAll('[role=alert],[role=status],[aria-live]')]
      .filter(vis)
      .map((a) => a.innerText.trim().replace(/\s+/g, ' ').slice(0, 200))
      .filter(Boolean);
    return { heads, buttons, inputs, alerts };
  });
}
const t00 = Date.now();
for (const [i, s] of steps.entries()) {
  const t0 = Date.now();
  try {
    if (s.goto) await page.goto(BASE + s.goto, { waitUntil: 'networkidle', timeout: 60000 });
    else if (s.fill)
      await loc(s.fill)
        .nth(s.nth ?? 0)
        .fill(String(s.value));
    else if (s.type)
      await loc(s.type)
        .nth(s.nth ?? 0)
        .pressSequentially(String(s.value), { delay: s.delay ?? 20 });
    else if (s.select) {
      const l = loc(s.select).nth(s.nth ?? 0);
      if (s.index !== undefined) await l.selectOption({ index: s.index });
      else await l.selectOption({ label: s.value }).catch(() => l.selectOption(s.value));
    } else if (s.check)
      await loc(s.check)
        .nth(s.nth ?? 0)
        .check();
    else if (s.click)
      await loc(s.click)
        .nth(s.nth ?? 0)
        .click({ timeout: s.timeout ?? 15000 });
    else if (s.press) await page.keyboard.press(s.press);
    else if (s.wait) await page.waitForTimeout(s.wait);
    else if (s.waitText)
      await page
        .getByText(s.waitText)
        .first()
        .waitFor({ timeout: s.timeout ?? 20000 });
    else if (s.upload)
      await loc(s.upload)
        .nth(s.nth ?? 0)
        .setInputFiles(s.file);
    else if (s.eval)
      console.log(
        `#${i} EVAL`,
        String(JSON.stringify(await page.evaluate(s.eval))).slice(0, s.max ?? 2500)
      );
    if (s.settle !== false && !s.wait)
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    if (s.map) console.log(`#${i} MAP`, JSON.stringify(await dumpMap()).slice(0, s.max ?? 3500));
    if (s.shot) console.log(`#${i} SHOT`, await shot(page, s.shot, { fullPage: s.full ?? false }));
    if (s.text)
      console.log(
        `#${i} TEXT`,
        (
          await page.evaluate(
            (sel) => (document.querySelector(sel) ?? document.body).innerText,
            s.text
          )
        )
          .replace(/\n+/g, ' | ')
          .slice(0, s.max ?? 2500)
      );
    if (s.log) console.log(`#${i} ok ${Date.now() - t0}ms ${s.log}`);
  } catch (e) {
    console.log(
      `#${i} FAIL ${JSON.stringify(s).slice(0, 150)} :: ${String(e).split('\n')[0].slice(0, 300)}`
    );
    try {
      console.log(`#${i} MAP-ON-FAIL`, JSON.stringify(await dumpMap()).slice(0, 3000));
    } catch {}
    try {
      console.log(`#${i} SHOT`, await shot(page, `fail-${Date.now()}`, { fullPage: true }));
    } catch {}
    if (!s.optional) break;
  }
}
const errs = log.http
  .filter((h) => h.status >= 400)
  .map((h) => [
    h.status,
    h.method,
    h.url.replace(/^https:\/\/[^/]+/, '').slice(0, 140),
    h.body.slice(0, 300),
    h.at,
  ]);
if (errs.length) console.log('HTTP-ERRORS', JSON.stringify(errs));
if (log.console.filter((c) => c.type !== 'warning').length)
  console.log(
    'CONSOLE',
    JSON.stringify(log.console.filter((c) => c.type !== 'warning').slice(0, 6))
  );
if (log.slow.length) console.log('SLOW', JSON.stringify(log.slow.slice(0, 6)));
console.log('TOTAL', Date.now() - t00, 'ms');
if (process.env.PERSIST) {
  await ctx.storageState({ path: (await import('./lib.mjs')).statePath(role) });
  console.log('state persisted');
}
await ctx.close();
await closeBrowser();
