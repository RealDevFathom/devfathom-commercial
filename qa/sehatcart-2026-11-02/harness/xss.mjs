// Plant XSS payloads in tenant data, then render pages and watch for script execution.
import { trpc, short, disposeApis, roleContext, closeBrowser, BASE, shot, save } from './lib.mjs';
const P = `QA-XSS <img src=x onerror="window.__xss=(window.__xss||0)+1;alert('xss')"><svg onload="window.__xss=(window.__xss||0)+1">`;
const created = {};
const sup = await trpc(
  'cashier',
  'pharmacyPurchasing.createSupplier',
  {
    name: `${P} supplier`,
    legalName: `${P} Ltd`,
    serviceArea: `=HYPERLINK("http://example.invalid","x")`,
  },
  'mutation'
);
console.log('createSupplier', short(sup, 120));
created.supplier = sup.data?.id;
const pat = await trpc(
  'owner',
  'pharmacyPrescriptions.createPatient',
  { displayName: `${P} patient`, phone: '+923009998877' },
  'mutation'
);
console.log('createPatient', short(pat, 120));
created.patient = pat.data?.id;
const ing = await trpc(
  'owner',
  'pharmacyMedicine.createIngredient',
  { name: `${P} ingredient` },
  'mutation'
);
console.log('createIngredient', short(ing, 120));
created.ingredient = ing.data?.id;
await disposeApis();

const results = [];
for (const [role, route] of [
  ['owner', '/pharmacy/purchasing/suppliers'],
  ['manager', '/pharmacy/purchasing/receiving'],
  ['owner', '/pharmacy/prescriptions'],
  ['owner', '/pharmacy/medicines'],
  ['pharmacist', '/pharmacy/counter'],
]) {
  const ctx = await roleContext(role);
  const page = await ctx.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  if (route === '/pharmacy/counter') {
    await page
      .getByLabel('Find patient')
      .fill('QA-XSS')
      .catch(() => {});
    await page
      .getByRole('button', { name: 'Search', exact: true })
      .click()
      .catch(() => {});
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(1200);
  const probe = await page.evaluate(() => ({
    xss: window.__xss || 0,
    injectedImg: document.querySelectorAll('img[src="x"]').length,
    injectedSvg: [...document.querySelectorAll('svg[onload]')].length,
    textShown: document.body.innerText.includes('QA-XSS <img'),
  }));
  results.push({ role, route, dialogs, ...probe });
  console.log(role, route, JSON.stringify({ dialogs, ...probe }));
  if (probe.textShown) await shot(page, `xss-${route.split('/').pop()}`, { fullPage: false });
  await ctx.close();
}
save('xss.json', { created, results });
await closeBrowser();
