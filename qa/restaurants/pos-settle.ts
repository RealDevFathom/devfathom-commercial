import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const ids = {
  branchId: 'cmvhhcldp000m1yjs2sc9obnz',
  staffId: 'cmvhhclfk004o1yjs8ekhf7z5',
  billId: 'cmvhkt5ds0027chjsijqnsxuk',
  orderId: 'cmvhkt52y001cchjsuh40tmvw',
  publicationId: 'cmvhjug6c00ga1yjs31fwgynt',
  karahiId: 'cmvhjug3w00g61yjs7gxjuya0',
  naanId: 'cmvhjug5700g81yjs0ftsyw6m',
  customerId: 'cmvhjuhgi00hl1yjsasvwg6c5',
  zoneId: 'cmvhjuhlm00hu1yjspc206mkr',
  addressId: 'cmvhkwz2t002lchjs9n9thrb9',
};
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(60000);
await page.goto(`${HOUSE}/login`);
await page.locator('input[name="email"]').fill('qa-karahi-owner@example.com');
await page.locator('input[name="password"]').fill('QaRestaurant!Owner2026');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'));

const prep = await page.evaluate(async (ids) => {
  async function trpc(proc: string, json: unknown) {
    const response = await fetch(`/api/trpc/${proc}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json }),
    });
    const text = (await response.text()).slice(0, 400);
    return { status: response.status, text };
  }
  const tax = await trpc('restaurantTax.publishCustom', {
    branchId: ids.branchId,
    profileName: 'QA Sindh GST',
    jurisdictionCode: 'PK-SD',
    effectiveFrom: '2026-10-01',
    priceMode: 'EXCLUSIVE',
    rates: [
      { paymentCategory: 'CASH', rate: '0.15' },
      { paymentCategory: 'CARD', rate: '0.15' },
      { paymentCategory: 'OTHER', rate: '0.15' },
    ],
    approvalReference: 'QA-TAX-2026-10',
    accountantConfirmation: true,
    replaceOpenProfile: false,
    idempotencyKey: 'qa-tax-karahi-20261021',
  });
  const channels = await trpc('restaurantMenus.setPublicationChannels', {
    id: ids.publicationId,
    channels: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
  });
  return { tax, channels };
}, ids);
console.log('tax', prep.tax.status, prep.tax.text.slice(0, 180));
console.log('channels', prep.channels.status, prep.channels.text.slice(0, 160));

await page.evaluate((branchId) => {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/restaurant/devices/browser-enroll';
  for (const [name, value] of Object.entries({ name: 'QA Settle', branchId, kind: 'POS', confirmation: 'confirmed' })) {
    const input = document.createElement('input');
    input.name = name;
    input.value = String(value);
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}, ids.branchId);
await page.waitForURL(/\/pos/);

const flow = await page.evaluate(async (ids) => {
  const out: Array<{ id: string; status: number; note: string }> = [];
  let session = '';
  async function call(id: string, path: string, body: unknown, key?: string, method = 'POST') {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (key) headers['idempotency-key'] = key;
    if (session) headers['x-terminal-session'] = session;
    const response = await fetch(path, {
      method,
      credentials: 'include',
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    if (!session) {
      try { session = JSON.parse(raw).sessionToken || session; } catch { /* ignore */ }
    }
    const text = raw.replace(/"sessionToken":"[^"]+"/g, '"sessionToken":"[redacted]"');
    out.push({ id, status: response.status, note: text.slice(0, 320) });
    return text;
  }
  await call('establish', '/api/restaurant/terminal/establish', {});
  await call('unlock', '/api/restaurant/terminal/unlock', { staffProfileId: ids.staffId, type: 'PIN', secret: '4821' });
  await call('drawer', '/api/restaurant/cash/drawer/open', { openingFloat: '500.00' }, `drawer-${Date.now()}`);
  const summary = await call('summary', `/api/restaurant/checkout/summary?orderId=${ids.orderId}`, null, undefined, 'GET');
  let due = '970.00';
  try {
    const bills = JSON.parse(summary).bills as Array<{ id: string; remainingDue: string }>;
    due = bills.find((bill) => bill.id === ids.billId)?.remainingDue || due;
  } catch { /* keep fallback */ }
  await call('PAY-03', '/api/restaurant/checkout/tender', {
    billId: ids.billId,
    tender: { type: 'CASH', amount: due, cashReceived: '5000.00' },
  }, `pay-cash-${Date.now()}`);

  const cardOrder = await call('card-open', '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId: ids.publicationId }, `card-open-${Date.now()}`);
  let cardOrderId = '';
  try { cardOrderId = JSON.parse(cardOrder).orderId || ''; } catch { cardOrderId = ''; }
  await call('card-item', '/api/restaurant/orders/add-item', { orderId: cardOrderId, menuItemId: ids.naanId }, `card-item-${Date.now()}`);
  await call('card-fire', '/api/restaurant/orders/fire', { orderId: cardOrderId }, `card-fire-${Date.now()}`);
  const cardBill = await call('card-bill', '/api/restaurant/checkout/bill', { orderId: cardOrderId, split: { kind: 'NONE' } }, `card-bill-${Date.now()}`);
  let cardBillId = '';
  try { cardBillId = JSON.parse(cardBill).billIds?.[0] || ''; } catch { cardBillId = ''; }
  const cardSummary = await call('card-summary', `/api/restaurant/checkout/summary?orderId=${cardOrderId}`, null, undefined, 'GET');
  let cardDue = '138.00';
  try {
    const bills = JSON.parse(cardSummary).bills as Array<{ id: string; remainingDue: string }>;
    cardDue = bills.find((bill) => bill.id === cardBillId)?.remainingDue || cardDue;
  } catch { /* fallback */ }
  const cardTender = await call('PAY-04', '/api/restaurant/checkout/tender', {
    billId: cardBillId,
    tender: { type: 'CARD', amount: cardDue, tipAmount: '20.00' },
  }, `pay-card-${Date.now()}`);
  let tenderId = '';
  try { tenderId = JSON.parse(cardTender).tenderId || ''; } catch { tenderId = ''; }
  await call('PAY-07', '/api/restaurant/checkout/refund', {
    originalTenderId: tenderId,
    amount: cardDue,
    tipRefundAmount: '20.00',
    kind: 'REFUND',
    reason: 'QA card refund',
    approving: { staffProfileId: ids.staffId, type: 'PIN', secret: '4821' },
  }, `refund-${Date.now()}`);

  const delivery = await call('ORD-04', '/api/restaurant/orders/open', {
    channel: 'DELIVERY', customerId: ids.customerId, publicationId: ids.publicationId,
  }, `del-open-${Date.now()}`);
  let deliveryId = '';
  try { deliveryId = JSON.parse(delivery).orderId || ''; } catch { deliveryId = ''; }
  await call('ORD-04-item', '/api/restaurant/orders/add-item', { orderId: deliveryId, menuItemId: ids.naanId }, `del-item-${Date.now()}`);
  await call('ORD-04-attach', '/api/restaurant/orders/delivery/attach', {
    orderId: deliveryId, customerId: ids.customerId, addressId: ids.addressId, zoneId: ids.zoneId,
  }, `del-attach-${Date.now()}`);

  const split = await call('PAY-05-open', '/api/restaurant/orders/open', { channel: 'DINE_IN', publicationId: ids.publicationId }, `split-open-${Date.now()}`);
  let splitId = '';
  try { splitId = JSON.parse(split).orderId || ''; } catch { splitId = ''; }
  const a = await call('split-a', '/api/restaurant/orders/add-item', { orderId: splitId, menuItemId: ids.karahiId }, `split-a-${Date.now()}`);
  const b = await call('split-b', '/api/restaurant/orders/add-item', { orderId: splitId, menuItemId: ids.naanId }, `split-b-${Date.now()}`);
  let aId = '';
  let bId = '';
  try { aId = JSON.parse(a).itemId || ''; bId = JSON.parse(b).itemId || ''; } catch { /* ignore */ }
  await call('split-fire', '/api/restaurant/orders/fire', { orderId: splitId }, `split-fire-${Date.now()}`);
  await call('PAY-05', '/api/restaurant/checkout/bill', {
    orderId: splitId, split: { kind: 'BY_ITEM', groups: [[aId], [bId]] },
  }, `split-bill-${Date.now()}`);
  await call('PAY-06', '/api/restaurant/checkout/bill', { orderId: splitId, split: { kind: 'BY_SEAT' } }, `seat-bill-${Date.now()}`);

  const cancel = await call('ORD-06-open', '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId: ids.publicationId }, `cancel-open-${Date.now()}`);
  let cancelId = '';
  try { cancelId = JSON.parse(cancel).orderId || ''; } catch { cancelId = ''; }
  await call('ORD-06', '/api/restaurant/orders/cancel', { orderId: cancelId, reason: 'QA guest left' }, `cancel-${Date.now()}`);
  return out;
}, ids);

writeFileSync('/workspace/qa/restaurants/evidence/pos-settle.json', JSON.stringify({ prep, flow }, null, 2));
for (const row of flow) console.log(row.status, row.id, row.note.slice(0, 160));
await page.screenshot({ path: '/workspace/qa/restaurants/evidence/pos-settle.png' });
await browser.close();
