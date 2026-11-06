import { browser, closeBrowser, statePath, BASE } from './lib.mjs';
const route = process.argv[2] ?? '/pharmacy/orders';
const b = await browser();
async function textOf(js) {
  const ctx = await b.newContext({
    storageState: statePath('owner'),
    javaScriptEnabled: js,
    viewport: { width: 1440, height: 900 },
  });
  const p = await ctx.newPage();
  await p.goto(BASE + route, { waitUntil: js ? 'networkidle' : 'load' });
  const t = await p.evaluate(
    () => document.querySelector('main')?.innerText ?? document.body.innerText
  );
  await ctx.close();
  return t
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
const ssr = await textOf(false);
const csr = await textOf(true);
const sset = new Set(ssr);
const cset = new Set(csr);
console.log('SSR-only lines:', ssr.filter((l) => !cset.has(l)).slice(0, 15));
console.log('Client-only lines:', csr.filter((l) => !sset.has(l)).slice(0, 15));
await closeBrowser();
