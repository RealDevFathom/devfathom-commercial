import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
function sql(query: string) {
  const run = spawnSync('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'devfathom', '-At', '-c', query], {
    encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' }, timeout: 10000,
  });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout);
  return run.stdout.trim().split('\n')[0] ?? '';
}
const ids = {
  branchId: sql(`SELECT b.id FROM restaurant_branches b JOIN organizations o ON o.id=b."organizationId" WHERE o.slug='qa-karahi-house' AND b.code='MAIN'`),
  staffId: sql(`SELECT s.id FROM restaurant_staff_profiles s JOIN users u ON u.id=s."userId" WHERE u.email='qa-karahi-owner@example.com'`),
  publicationId: sql(`SELECT p.id FROM restaurant_branch_menu_publications p WHERE p."branchId"=(SELECT b.id FROM restaurant_branches b JOIN organizations o ON o.id=b."organizationId" WHERE o.slug='qa-karahi-house' AND b.code='MAIN') AND p.status='PUBLISHED' ORDER BY p."createdAt" DESC LIMIT 1`),
  menuItemId: sql(`SELECT i.id FROM restaurant_menu_items i JOIN restaurant_products p ON p.id=i."productId" WHERE p.name='Chicken Karahi' ORDER BY i."createdAt" DESC LIMIT 1`),
  naanItemId: sql(`SELECT i.id FROM restaurant_menu_items i JOIN restaurant_products p ON p.id=i."productId" WHERE p.name='Garlic Naan' ORDER BY i."createdAt" DESC LIMIT 1`),
  tableId: sql(`SELECT id FROM restaurant_tables WHERE code='T1' ORDER BY "createdAt" DESC LIMIT 1`),
  table2Id: sql(`SELECT id FROM restaurant_tables WHERE code='T2' ORDER BY "createdAt" DESC LIMIT 1`),
  stationId: sql(`SELECT id FROM restaurant_kitchen_stations WHERE name='Hot line' ORDER BY "createdAt" DESC LIMIT 1`),
};

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(`${HOUSE}/login`);
await page.locator('input[name="email"]').fill('qa-karahi-owner@example.com');
await page.locator('input[name="password"]').fill('QaRestaurant!Owner2026');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'));
await page.evaluate((branchId) => {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/restaurant/devices/browser-enroll';
  for (const [name, value] of Object.entries({ name: 'QA Orders', branchId, kind: 'POS', confirmation: 'confirmed' })) {
    const input = document.createElement('input');
    input.name = name; input.value = String(value); form.append(input);
  }
  document.body.append(form); form.submit();
}, ids.branchId);
await page.waitForURL(/\/pos/);
const flow = await page.evaluate(async (ids) => {
  const out: Array<{ id: string; status: number; note: string }> = [];
  const redact = (text: string) => text.replace(/"sessionToken":"[^"]+"/g, '"sessionToken":"[redacted]"').slice(0, 280);
  let session = '';
  async function call(id: string, path: string, body: unknown, key?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers['idempotency-key'] = key;
    if (session) headers['x-terminal-session'] = session;
    const response = await fetch(path, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
    const text = await response.text();
    out.push({ id, status: response.status, note: redact(text) });
    return text;
  }
  const established = await call('establish', '/api/restaurant/terminal/establish', {});
  try { session = JSON.parse(established).sessionToken || ''; } catch { session = ''; }
  await call('unlock', '/api/restaurant/terminal/unlock', { staffProfileId: ids.staffId, type: 'PIN', secret: '4821' });
  await call('SEC-02', '/api/restaurant/orders/open', { channel: 'DINE_IN' });
  const dine = await call('ORD-02-open', '/api/restaurant/orders/open', { channel: 'DINE_IN', publicationId: ids.publicationId, tableIds: [ids.tableId], coverCount: 2 }, `ord-${Date.now()}`);
  let orderId = '';
  try { orderId = JSON.parse(dine).orderId || ''; } catch { orderId = ''; }
  await call('ORD-02-add', '/api/restaurant/orders/add-item', { orderId, menuItemId: ids.menuItemId, quantity: 1 }, `add-${Date.now()}`);
  await call('ORD-02-naan', '/api/restaurant/orders/add-item', { orderId, menuItemId: ids.naanItemId, quantity: 1, seatNumber: 2 }, `naan-${Date.now()}`);
  await call('ORD-02-fire', '/api/restaurant/orders/fire', { orderId }, `fire-${Date.now()}`);
  await call('ORD-03', '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId: ids.publicationId }, `take-${Date.now()}`);
  await call('ORD-05', '/api/restaurant/orders/move-table', { orderId, fromTableId: ids.tableId, toTableId: ids.table2Id }, `move-${Date.now()}`);
  await call('drawer', '/api/restaurant/cash/drawer/open', { openingFloat: '500.00' }, `drawer-${Date.now()}`);
  const bill = await call('PAY-01', '/api/restaurant/checkout/bill', { orderId, split: { kind: 'NONE' } }, `bill-${Date.now()}`);
  let billId = '';
  let grand = '';
  try { const parsed = JSON.parse(bill); const first = parsed.bills?.[0] ?? parsed; billId = first.id ?? ''; grand = String(first.grandTotal ?? ''); } catch { /* empty */ }
  await call('PAY-03', '/api/restaurant/checkout/tender', { billId, tender: { type: 'CASH', amount: grand, cashReceived: '2000.00' } }, `cash-${Date.now()}`);
  return out;
}, ids);
await page.screenshot({ path: '/workspace/qa/restaurants/evidence/pos-orders.png' });
writeFileSync('/workspace/qa/restaurants/evidence/pos-orders.json', JSON.stringify(flow, null, 2));
for (const row of flow) console.log(row.status, row.id, row.note.slice(0, 160));
await browser.close();
