// Page sweep: role x route at a viewport. Usage: node sweep.mjs <tag> <width> <height> <scheme> [roles...]
import fs from 'node:fs';
import path from 'node:path';
import { roleContext, capture, closeBrowser, SCRATCH, BASE, pkt } from './lib.mjs';

const [tag = 'desk', w = '1440', h = '900', scheme = 'light', ...rolesArg] = process.argv.slice(2);
const roles = rolesArg.length ? rolesArg : ['owner', 'cashier', 'manager', 'pharmacist'];
const ROUTES = (process.env.ROUTES ?? `/dashboard /pharmacy /pharmacy/counter /pharmacy/counter/close /pharmacy/inventory /pharmacy/inventory/expiry /pharmacy/inventory/import /pharmacy/inventory/imports /pharmacy/inventory/transfers /pharmacy/medicines /pharmacy/medicines/prices /pharmacy/medicines/staged /pharmacy/purchasing /pharmacy/purchasing/orders /pharmacy/purchasing/receiving /pharmacy/purchasing/returns /pharmacy/purchasing/suppliers /pharmacy/prescriptions /pharmacy/pharmacist-queue /pharmacy/substitution /pharmacy/controlled-register /pharmacy/reports /pharmacy/reports/branch-comparison /pharmacy/reports/repeat-purchasing /pharmacy/reports/replenishment /pharmacy/reports/supplier-credit-follow-up /pharmacy/finance /pharmacy/accounts/profit-loss /pharmacy/accounts/balance-sheet /pharmacy/accounts/cash-flow /pharmacy/accounts/trial-balance-control /pharmacy/accounts/account-activity-bridge /pharmacy/marketing /pharmacy/loyalty /pharmacy/orders /pharmacy/regulatory /pharmacy/regulatory/fbr-tier-1 /pharmacy/settings/branches /pharmacy/cameras /settings /settings/receipts /team /organization /audit-logs /finance /api-docs`).split(/\s+/).filter(Boolean);

const outDir = path.join(SCRATCH, 'sweep', tag);
fs.mkdirSync(outDir, { recursive: true });

async function runRole(role) {
  const ctx = await roleContext(role, { viewport: { width: +w, height: +h }, colorScheme: scheme });
  const results = [];
  for (const route of ROUTES) {
    const page = await ctx.newPage();
    const log = capture(page);
    const t0 = Date.now();
    let navErr = null;
    try {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(600);
    } catch (e) {
      navErr = String(e).slice(0, 200);
    }
    const loadMs = Date.now() - t0;
    let info = {};
    try {
      info = await page.evaluate(() => {
        const h1 = [...document.querySelectorAll('h1')].map((e) => e.innerText.trim()).filter(Boolean);
        const navLinks = [...document.querySelectorAll('nav a')].map((a) => ({ t: a.innerText.trim().slice(0, 40), h: a.getAttribute('href') }));
        const text = document.body?.innerText ?? '';
        const docW = document.documentElement.scrollWidth;
        const vw = window.innerWidth;
        const skeletons = document.querySelectorAll('[class*="skeleton"],[class*="animate-pulse"]').length;
        return { h1, navLinks, text: text.slice(0, 3000), docW, vw, skeletons, title: document.title, dir: document.documentElement.dir, lang: document.documentElement.lang };
      });
    } catch (e) {
      info = { evalErr: String(e).slice(0, 200) };
    }
    const safe = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
    const shotPath = path.join(outDir, `${role}__${safe}.png`);
    try {
      await page.screenshot({ path: shotPath, fullPage: false });
    } catch {}
    results.push({ role, route, final: page.url().replace(BASE, ''), loadMs, navErr, ...info, console: log.console, http: log.http, failed: log.failed, slow: log.slow, at: pkt(), shot: shotPath });
    await page.close();
  }
  await ctx.close();
  return results;
}

const all = (await Promise.all(roles.map(runRole))).flat();
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(all, null, 1));
console.log('done', all.length, 'pages ->', outDir);
await Promise.race([closeBrowser(), new Promise((r) => setTimeout(r, 5000))]);
process.exit(0);
