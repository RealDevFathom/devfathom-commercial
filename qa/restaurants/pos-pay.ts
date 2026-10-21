import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const ids = {
  branchId: 'cmvhhcldp000m1yjs2sc9obnz',
  staffId: 'cmvhhclfk004o1yjs8ekhf7z5',
  billId: 'cmvhkt5ds0027chjsijqnsxuk',
  publicationId: 'cmvhjug6c00ga1yjs31fwgynt',
  menuItemId: 'cmvhjug3w00g61yjs7gxjuya0',
  naanItemId: 'cmvhjug5700g81yjs0ftsyw6m',
  customerId: 'cmvhjuhgi00hl1yjsasvwg6c5',
  zoneId: 'cmvhjuhlm00hu1yjspc206mkr',
};
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(`${HOUSE}/login`);
await page.locator('input[name="email"]').fill('qa-karahi-owner@example.com');
await page.locator('input[name="password"]').fill('QaRestaurant!Owner2026');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'));
const address = await page.evaluate(async (customerId) => {
  const response = await fetch('/api/trpc/restaurantDelivery.createAddress', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: { customerId, label: 'Home', recipientName: 'Sana Guest', phone: '+923001112233', addressLine1: '14 Sea View', locality: 'Clifton', countryCode: 'PK' } }),
  });
  return { status: response.status, text: (await response.text()).slice(0, 240) };
}, ids.customerId);
console.log('address', address.status, address.text.slice(0, 180));
await page.evaluate((branchId) => {
  const form = document.createElement('form');
  form.method = 'POST'; form.action = '/api/restaurant/devices/browser-enroll';
  for (const [name, value] of Object.entries({ name: 'QA Pay', branchId, kind: 'POS', confirmation: 'confirmed' })) {
    const input = document.createElement('input'); input.name = name; input.value = String(value); form.append(input);
  }
  document.body.append(form); form.submit();
}, ids.branchId);
await page.waitForURL(/\/pos/);
const naan = await page.evaluate(() => {
  const match = document.documentElement.innerHTML;
  return match.includes('Garlic') ? 'page' : '';
});
void naan;
const flow = await page.evaluate(async (ids) => {
  const out: Array<{ id: string; status: number; note: string }> = [];
  let session = '';
  async function call(id: string, path: string, body: unknown, key?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers['idempotency-key'] = key;
    if (session) headers['x-terminal-session'] = session;
    const response = await fetch(path, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
    const raw = await response.text();
    if (!session) {
      try { session = JSON.parse(raw).sessionToken || session; } catch { /* not a session response */ }
    }
    const text = raw.replace(/"sessionToken":"[^"]+"/g, '"sessionToken":"[redacted]"');
    out.push({ id, status: response.status, note: text.slice(0, 260) });
    return text;
  }
  await call('establish', '/api/restaurant/terminal/establish', {});
  await call('unlock', '/api/restaurant/terminal/unlock', { staffProfileId: ids.staffId, type: 'PIN', secret: '4821' });
  await call('PAY-03', '/api/restaurant/checkout/tender', { billId: ids.billId, tender: { type: 'CASH', amount: '970.00', cashReceived: '2000.00' } }, `pay-${Date.now()}`);
  const cardOrder = await call('card-open', '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId: ids.publicationId }, `card-open-${Date.now()}`);
  let cardOrderId = '';
  try { cardOrderId = JSON.parse(cardOrder).orderId || ''; } catch { cardOrderId = ''; }
  await call('card-item', '/api/restaurant/orders/add-item', { orderId: cardOrderId, menuItemId: ids.naanItemId }, `card-item-${Date.now()}`);
  await call('card-fire', '/api/restaurant/orders/fire', { orderId: cardOrderId }, `card-fire-${Date.now()}`);
  const cardBill = await call('card-bill', '/api/restaurant/checkout/bill', { orderId: cardOrderId, split: { kind: 'NONE' } }, `card-bill-${Date.now()}`);
  let cardBillId = '';
  let cardTotal = '120.00';
  try { const parsed = JSON.parse(cardBill); cardBillId = parsed.billIds?.[0] ?? ''; } catch { cardBillId = ''; }
  await call('PAY-04', '/api/restaurant/checkout/tender', { billId: cardBillId, tender: { type: 'CARD', amount: cardTotal, tipAmount: '20.00' } }, `card-${Date.now()}`);
  const early = await call('MNU-03-before', '/api/restaurant/orders/open', { channel: 'DELIVERY', customerId: ids.customerId, publicationId: ids.publicationId }, `del-early-${Date.now()}`);
  void early;
  return out;
}, ids);
writeFileSync('/workspace/qa/restaurants/evidence/pos-pay.json', JSON.stringify({ address, flow }, null, 2));
for (const row of flow) console.log(row.status, row.id, row.note.slice(0, 150));
await page.screenshot({ path: '/workspace/qa/restaurants/evidence/pos-pay.png' });
await browser.close();
