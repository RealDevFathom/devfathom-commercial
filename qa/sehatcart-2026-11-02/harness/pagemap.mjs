// Usage: node pagemap.mjs <role> <route> [shotName] [width]
import { roleContext, capture, closeBrowser, BASE, shot } from './lib.mjs';
const [role, route, shotName, width = '1440'] = process.argv.slice(2);
const ctx = await roleContext(role, { viewport: { width: +width, height: 900 } });
const page = await ctx.newPage();
const log = capture(page);
await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(800);
// expand <details>
await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
const map = await page.evaluate(() => {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const lab = (e) => {
    const id = e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
    return (e.getAttribute('aria-label') || (id && id.innerText) || e.closest('label')?.innerText || e.placeholder || e.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  };
  const main = document.querySelector('main') ?? document.body;
  const heads = [...main.querySelectorAll('h1,h2,h3,h4')].filter(vis).map((h) => h.tagName + ':' + h.innerText.trim().replace(/\s+/g, ' ').slice(0, 70));
  const buttons = [...main.querySelectorAll('button,[role=button],a[href]')].filter(vis).map((b) => `${b.tagName === 'A' ? 'a' : 'btn'}${b.disabled ? '(disabled)' : ''}:${(b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50)}${b.tagName === 'A' ? '→' + b.getAttribute('href') : ''}`);
  const inputs = [...main.querySelectorAll('input,select,textarea')].filter(vis).map((i) => `${i.tagName.toLowerCase()}[${i.type || ''}]${i.required ? '*' : ''}${i.disabled ? '(disabled)' : ''} "${lab(i)}"${i.tagName === 'SELECT' ? ' opts=' + [...i.options].map((o) => o.text).slice(0, 8).join('/') : ''}`);
  return { heads, buttons, inputs };
});
console.log('URL', page.url().replace(BASE, ''));
console.log('HEADINGS', map.heads.join(' || '));
console.log('BUTTONS', map.buttons.join(' || '));
console.log('INPUTS', map.inputs.join(' || '));
if (log.http.length) console.log('HTTP', JSON.stringify(log.http.map((h) => [h.status, h.url.replace(/^https:\/\/[^/]+/, '').slice(0, 120), h.body.slice(0, 200)])));
if (log.console.length) console.log('CONSOLE', JSON.stringify(log.console.slice(0, 5)));
if (shotName) console.log('SHOT', await shot(page, shotName, { fullPage: true }));
await ctx.close();
await closeBrowser();
