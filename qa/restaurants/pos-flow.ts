import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chromium, type Page } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const OUT = '/workspace/qa/restaurants/evidence/pos-flow.json';
const results: Array<{ id: string; status: string; notes: string }> = [];
function sql(query: string) {
  const run = spawnSync('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'devfathom', '-At', '-c', query], {
    encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' }, timeout: 10000,
  });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout);
  return run.stdout.trim().split('\n')[0] ?? '';
}
function record(id: string, status: string, notes: string) {
  results.push({ id, status, notes: notes.slice(0, 700) });
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`[${status}] ${id} — ${notes.slice(0, 180)}`);
}
async function call(page: Page, path: string, body: unknown, key?: string) {
  return page.evaluate(async ({ path, body, key }) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers['idempotency-key'] = key;
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, text: (await response.text()).slice(0, 700) };
  }, { path, body, key });
}

const branchId = sql(`SELECT b.id FROM restaurant_branches b JOIN organizations o ON o.id=b."organizationId" WHERE o.slug='qa-karahi-house' AND b.code='MAIN'`);
const staffId = sql(`SELECT s.id FROM restaurant_staff_profiles s JOIN users u ON u.id=s."userId" WHERE u.email='qa-karahi-owner@example.com'`);
const ownerRole = sql(`SELECT id FROM restaurant_job_roles WHERE key='owner' ORDER BY "createdAt" DESC LIMIT 1`);
const publicationId = sql(`SELECT id FROM restaurant_branch_menu_publications WHERE "branchId"='${branchId}' AND status='PUBLISHED' ORDER BY "createdAt" DESC LIMIT 1`);
const menuItemId = sql(`SELECT i.id FROM restaurant_menu_items i JOIN restaurant_products p ON p.id=i."productId" WHERE p.name='Chicken Karahi' ORDER BY i."createdAt" DESC LIMIT 1`);
const naanItemId = sql(`SELECT i.id FROM restaurant_menu_items i JOIN restaurant_products p ON p.id=i."productId" WHERE p.name='Garlic Naan' ORDER BY i."createdAt" DESC LIMIT 1`);
const tableId = sql(`SELECT id FROM restaurant_tables WHERE code='T1' ORDER BY "createdAt" DESC LIMIT 1`);
const table2 = sql(`SELECT id FROM restaurant_tables WHERE code='T2' ORDER BY "createdAt" DESC LIMIT 1`);

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(`${HOUSE}/login`);
await page.locator('input[name="email"]').fill('qa-karahi-owner@example.com');
await page.locator('input[name="password"]').fill('QaRestaurant!Owner2026');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'));
const jobs = await page.evaluate(async ({ staffId, branchId, ownerRole }) => {
  const response = await fetch('/api/trpc/restaurantStaff.setStaffJobRoles', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: { staffProfileId: staffId, branchId, jobRoleIds: ownerRole ? [ownerRole] : [] } }),
  });
  return { status: response.status, text: (await response.text()).slice(0, 300) };
}, { staffId, branchId, ownerRole });
record('STF-owner-role', jobs.status < 400 ? 'pass' : 'fail', `${jobs.status} ${jobs.text}`);

await page.evaluate((id) => {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/restaurant/devices/browser-enroll';
  for (const [name, value] of Object.entries({ name: 'QA Register flow', branchId: id, kind: 'POS', confirmation: 'confirmed' })) {
    const input = document.createElement('input');
    input.name = name; input.value = String(value); form.append(input);
  }
  document.body.append(form); form.submit();
}, branchId);
await page.waitForURL(/\/pos/);
await page.waitForTimeout(1500);
const lengths = (await page.context().cookies()).map((cookie) => `${cookie.name}:${cookie.value.length}`);
record('CFG-02-cookie', lengths.some((item) => item.startsWith('devfathom-terminal:') && !item.endsWith(':0')) ? 'pass' : 'fail', lengths.join(' '));
const sessionLeft = lengths.find((item) => item.startsWith('authjs.session-token:'));
record('CFG-02-session-ended', sessionLeft && !sessionLeft.endsWith(':0') ? 'fail' : 'pass', `Admin session cookie after enroll: ${sessionLeft ?? 'absent'}`);

const missing = await call(page, '/api/restaurant/orders/open', { channel: 'DINE_IN' });
record('SEC-02', missing.status === 400 ? 'pass' : 'fail', `${missing.status} ${missing.text.slice(0, 180)}`);
const unlock = await call(page, '/api/restaurant/terminal/unlock', { staffProfileId: staffId, type: 'PIN', secret: '4821' });
record('POS-unlock', unlock.status < 400 ? 'pass' : 'fail', `${unlock.status} ${unlock.text.slice(0, 240)}`);
await page.goto(`${HOUSE}/pos`);
await page.waitForTimeout(1000);
const copy = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 350);
await page.screenshot({ path: '/workspace/qa/restaurants/evidence/pos-flow.png' });
record('PAY-04-copy', /mock|simulat|not a live|not an authorization/i.test(copy) ? 'pass' : 'fail', copy);

const dine = await call(page, '/api/restaurant/orders/open', { channel: 'DINE_IN', publicationId, tableIds: [tableId], coverCount: 2 }, `flow-dine-${Date.now()}`);
let orderId = '';
try { orderId = JSON.parse(dine.text).orderId || ''; } catch { orderId = ''; }
const added = await call(page, '/api/restaurant/orders/add-item', { orderId, menuItemId, quantity: 1 }, `flow-add-${Date.now()}`);
const addedNaan = await call(page, '/api/restaurant/orders/add-item', { orderId, menuItemId: naanItemId, quantity: 1, seatNumber: 2 }, `flow-naan-${Date.now()}`);
const fired = await call(page, '/api/restaurant/orders/fire', { orderId }, `flow-fire-${Date.now()}`);
record('ORD-02', dine.status < 400 && added.status < 400 && fired.status < 400 ? 'pass' : 'fail', `open ${dine.status} ${dine.text.slice(0, 140)}; add ${added.status} ${added.text.slice(0, 120)}; naan ${addedNaan.status} ${addedNaan.text.slice(0, 80)}; fire ${fired.status} ${fired.text.slice(0, 120)}`);
const takeaway = await call(page, '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId }, `flow-take-${Date.now()}`);
record('ORD-03', takeaway.status < 400 ? 'pass' : 'fail', `${takeaway.status} ${takeaway.text.slice(0, 160)}`);
const moved = await call(page, '/api/restaurant/orders/move-table', { orderId, fromTableId: tableId, toTableId: table2 }, `flow-move-${Date.now()}`);
record('ORD-05', moved.status < 400 ? 'pass' : 'fail', `${moved.status} ${moved.text.slice(0, 160)}`);
const drawer = await call(page, '/api/restaurant/cash/drawer/open', { openingFloat: '500.00' }, `flow-drawer-${Date.now()}`);
const bill = await call(page, '/api/restaurant/checkout/bill', { orderId, split: { kind: 'NONE' } }, `flow-bill-${Date.now()}`);
let billId = '';
let grand = '';
try { const parsed = JSON.parse(bill.text); const first = parsed.bills?.[0] ?? parsed; billId = first.id ?? ''; grand = String(first.grandTotal ?? ''); } catch { /* empty */ }
record('PAY-01', bill.status < 400 ? 'pass' : 'fail', `drawer ${drawer.status} ${drawer.text.slice(0, 100)}; bill ${bill.status} ${bill.text.slice(0, 220)}`);
const cash = await call(page, '/api/restaurant/checkout/tender', { billId, tender: { type: 'CASH', amount: grand || '0.00', cashReceived: '2000.00' } }, `flow-cash-${Date.now()}`);
record('PAY-03', cash.status < 400 ? 'pass' : 'fail', `${cash.status} ${cash.text.slice(0, 240)}`);
const cardOrder = await call(page, '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId }, `flow-card-open-${Date.now()}`);
let cardOrderId = '';
try { cardOrderId = JSON.parse(cardOrder.text).orderId || ''; } catch { cardOrderId = ''; }
await call(page, '/api/restaurant/orders/add-item', { orderId: cardOrderId, menuItemId: naanItemId }, `flow-card-item-${Date.now()}`);
await call(page, '/api/restaurant/orders/fire', { orderId: cardOrderId }, `flow-card-fire-${Date.now()}`);
const cardBill = await call(page, '/api/restaurant/checkout/bill', { orderId: cardOrderId, split: { kind: 'NONE' } }, `flow-card-bill-${Date.now()}`);
let cardBillId = '';
let cardTotal = '120.00';
try { const parsed = JSON.parse(cardBill.text); cardBillId = parsed.bills?.[0]?.id ?? ''; cardTotal = String(parsed.bills?.[0]?.grandTotal ?? cardTotal); } catch { /* empty */ }
const card = await call(page, '/api/restaurant/checkout/tender', { billId: cardBillId, tender: { type: 'CARD', amount: cardTotal, tipAmount: '20.00' } }, `flow-card-${Date.now()}`);
record('PAY-04', card.status < 400 ? 'pass' : 'fail', `${card.status} ${card.text.slice(0, 240)}`);
await browser.close();
