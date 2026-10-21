/** Browser-cookie terminal journey. One browser. Results flushed every case. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chromium, type Page } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const EVIDENCE = '/workspace/qa/restaurants/evidence';
const OUT = `${EVIDENCE}/pos-results.json`;
const OWNER = 'qa-karahi-owner@example.com';
const PASSWORD = 'QaRestaurant!Owner2026';
const PIN = '4821';
type Result = { id: string; status: 'pass' | 'fail' | 'blocked'; notes: string };
const results: Result[] = [];
const bag: Record<string, string> = {};

function loadEnv() {
  for (const line of readFileSync('/workspace/.env.local', 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (!process.env[trimmed.slice(0, eq)]) process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^"|"$/g, '');
  }
}
function record(id: string, status: Result['status'], notes: string) {
  results.push({ id, status, notes: notes.slice(0, 900) });
  writeFileSync(OUT, JSON.stringify({ bag, results }, null, 2));
  console.log(`[${status}] ${id} — ${notes.slice(0, 200)}`);
}
function sql(query: string) {
  const run = spawnSync('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'devfathom', '-At', '-F', '|', '-c', query], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: 'postgres' },
    timeout: 10000,
  });
  if (run.status !== 0) throw new Error((run.stderr || run.stdout).slice(0, 300));
  return run.stdout.trim();
}
async function api(page: Page, path: string, body: unknown, key?: string) {
  return page.evaluate(
    async ({ path, body, key }) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (key) headers['idempotency-key'] = key;
      const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, text: (await response.text()).slice(0, 800) };
    },
    { path, body, key }
  );
}
async function trpc(page: Page, procedure: string, input: unknown) {
  return page.evaluate(async ({ procedure, input }) => {
    const response = await fetch(`/api/trpc/${procedure}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: input }),
    });
    return { status: response.status, text: (await response.text()).slice(0, 800) };
  }, { procedure, input });
}

async function main() {
  loadEnv();
  mkdirSync(EVIDENCE, { recursive: true });
  bag.branchId = sql(`SELECT b.id FROM restaurant_branches b JOIN organizations o ON o.id=b."organizationId" WHERE o.slug='qa-karahi-house' AND b.code='MAIN'`).split('\n')[0]!;
  bag.staffId = sql(`SELECT s.id FROM restaurant_staff_profiles s JOIN users u ON u.id=s."userId" WHERE u.email='${OWNER}'`).split('\n')[0] ?? '';
  bag.publicationId = sql(`SELECT p.id FROM restaurant_branch_menu_publications p JOIN restaurant_branches b ON b.id=p."branchId" WHERE b.id='${bag.branchId}' ORDER BY p."createdAt" DESC LIMIT 1`);
  bag.menuItemId = sql(`SELECT i.id FROM restaurant_menu_items i JOIN restaurant_products pr ON pr.id=i."productId" WHERE pr.name='Chicken Karahi' ORDER BY i."createdAt" DESC LIMIT 1`);
  bag.naanItemId = sql(`SELECT i.id FROM restaurant_menu_items i JOIN restaurant_products pr ON pr.id=i."productId" WHERE pr.name='Garlic Naan' ORDER BY i."createdAt" DESC LIMIT 1`);
  bag.tableId = sql(`SELECT t.id FROM restaurant_tables t JOIN restaurant_floors f ON f.id=t."floorId" WHERE t.code='T1' ORDER BY t."createdAt" DESC LIMIT 1`);
  bag.stationId = sql(`SELECT id FROM restaurant_kitchen_stations WHERE "branchId"='${bag.branchId}' ORDER BY "createdAt" DESC LIMIT 1`);
  record('POS-ids', bag.staffId && bag.menuItemId ? 'pass' : 'fail', JSON.stringify(bag));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${HOUSE}/login`);
  await page.locator('input[name="email"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });

  const roles = await trpc(page, 'restaurantStaff.listJobRoles', { activeOnly: false });
  const seeded = await trpc(page, 'restaurantStaff.seedDefaultJobRoles', {});
  record('STF-roles', roles.status < 400 || seeded.status < 400 ? 'pass' : 'fail', `list ${roles.status} ${roles.text.slice(0, 180)}; seed ${seeded.status} ${seeded.text.slice(0, 180)}`);
  const pin = await trpc(page, 'restaurantStaff.issueCredential', { staffProfileId: bag.staffId, type: 'PIN', secret: PIN });
  record('STF-owner-pin', pin.status < 400 ? 'pass' : 'fail', `${pin.status} ${pin.text.slice(0, 240)}`);
  const jobs = await trpc(page, 'restaurantStaff.setStaffJobRoles', {
    staffProfileId: bag.staffId,
    branchId: bag.branchId,
    jobRoleIds: [],
  });
  record('STF-jobs-empty', jobs.status < 500 ? 'pass' : 'fail', `${jobs.status} ${jobs.text.slice(0, 240)}`);

  const enrolled = await page.evaluate(async (branchId) => {
    const body = new FormData();
    body.set('name', 'QA Register browser');
    body.set('branchId', branchId);
    body.set('kind', 'POS');
    body.set('confirmation', 'confirmed');
    const response = await fetch('/api/restaurant/devices/browser-enroll', { method: 'POST', body });
    return { status: response.status, url: response.url, text: (await response.text()).slice(0, 240) };
  }, bag.branchId);
  await page.goto(`${HOUSE}/pos`);
  await page.waitForTimeout(800);
  const posText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
  await page.screenshot({ path: `${EVIDENCE}/pos-browser.png` });
  record('CFG-02-browser', enrolled.status < 400 && !/not enrolled/i.test(posText) ? 'pass' : 'fail', `enroll ${enrolled.status} ${enrolled.url} ${enrolled.text}; page ${posText}`);

  const missing = await api(page, '/api/restaurant/orders/open', { channel: 'DINE_IN' });
  record('SEC-02', missing.status === 400 ? 'pass' : 'fail', `${missing.status} ${missing.text.slice(0, 200)}`);
  const unlock = await api(page, '/api/restaurant/terminal/unlock', { staffProfileId: bag.staffId, type: 'PIN', secret: PIN });
  record('POS-unlock', unlock.status < 400 ? 'pass' : 'fail', `${unlock.status} ${unlock.text.slice(0, 300)}`);
  await page.goto(`${HOUSE}/pos`);
  const openCopy = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
  await page.screenshot({ path: `${EVIDENCE}/pos-unlocked.png` });
  record('PAY-04-copy', /mock|simulat|not a live|not an authorization/i.test(openCopy) ? 'pass' : 'fail', openCopy);

  const dine = await api(page, '/api/restaurant/orders/open', { channel: 'DINE_IN', publicationId: bag.publicationId, tableIds: [bag.tableId], coverCount: 2 }, `qa-dine-${Date.now()}`);
  const dineBody = JSON.parse(dine.text || '{}');
  bag.orderId = dineBody.orderId || dineBody.id || '';
  const added = await api(page, '/api/restaurant/orders/add-item', { orderId: bag.orderId, menuItemId: bag.menuItemId, quantity: 1 }, `qa-add-${Date.now()}`);
  const fired = await api(page, '/api/restaurant/orders/fire', { orderId: bag.orderId }, `qa-fire-${Date.now()}`);
  record('ORD-02', dine.status < 400 && added.status < 400 && fired.status < 400 ? 'pass' : 'fail', `open ${dine.status} ${dine.text.slice(0, 160)}; add ${added.status} ${added.text.slice(0, 160)}; fire ${fired.status} ${fired.text.slice(0, 160)}`);
  const takeaway = await api(page, '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId: bag.publicationId }, `qa-take-${Date.now()}`);
  record('ORD-03', takeaway.status < 400 ? 'pass' : 'fail', `${takeaway.status} ${takeaway.text.slice(0, 200)}`);
  const drawer = await api(page, '/api/restaurant/cash/drawer/open', { openingFloat: '500.00' }, `qa-drawer-${Date.now()}`);
  const bill = await api(page, '/api/restaurant/checkout/bill', { orderId: bag.orderId, split: { kind: 'NONE' } }, `qa-bill-${Date.now()}`);
  let billId = '';
  let grand = '900.00';
  try {
    const parsed = JSON.parse(bill.text);
    const first = parsed.bills?.[0] ?? parsed;
    billId = first.id ?? '';
    grand = String(first.grandTotal ?? grand);
  } catch { /* keep empty */ }
  record('PAY-01', bill.status < 400 && Boolean(billId) ? 'pass' : 'fail', `drawer ${drawer.status} ${drawer.text.slice(0, 120)}; bill ${bill.status} ${bill.text.slice(0, 240)}`);
  const cash = await api(page, '/api/restaurant/checkout/tender', { billId, tender: { type: 'CASH', amount: grand, cashReceived: '2000.00' } }, `qa-cash-${Date.now()}`);
  record('PAY-03', cash.status < 400 ? 'pass' : 'fail', `${cash.status} ${cash.text.slice(0, 280)}`);
  await browser.close();
}
main().catch((error) => {
  record('RUN', 'blocked', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
