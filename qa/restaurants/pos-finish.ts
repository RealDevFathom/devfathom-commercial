import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const ids = {
  branchId: 'cmvhhcldp000m1yjs2sc9obnz',
  staffId: 'cmvhhclfk004o1yjs8ekhf7z5',
  jobRoleId: 'cmvhhclf000361yjssb1hecpy',
  billId: 'cmvhkt5ds0027chjsijqnsxuk',
  cardBillId: 'cmvhkzgrp004hchjs0bg2q17v',
  cardTenderId: 'cmvhkzgtr004mchjsxn4713ro',
  compBillId: 'cmvhkzhly005jchjsp0yj93he',
  compLineId: 'cmvhkzhm3005kchjsoz6uwifc',
  publicationId: 'cmvhjug6c00ga1yjs31fwgynt',
  karahiId: 'cmvhjug3w00g61yjs7gxjuya0',
  naanId: 'cmvhjug5700g81yjs0ftsyw6m',
  kdsItemId: 'cmvhkzgjf0048chjskiqxbjtg',
  stationId: 'cmvhjughs00gq1yjsrw6ss058',
};
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(45000);
await page.goto(`${HOUSE}/login`);
await page.locator('input[name="email"]').fill('qa-karahi-owner@example.com');
await page.locator('input[name="password"]').fill('QaRestaurant!Owner2026');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'));

const staff = await page.evaluate(async (ids) => {
  async function trpc(proc: string, json: unknown) {
    const response = await fetch(`/api/trpc/${proc}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json }),
    });
    return { status: response.status, text: (await response.text()).slice(0, 360) };
  }
  const created = await trpc('restaurantStaff.create', {
    displayName: 'QA Floor Manager',
    primaryBranchId: ids.branchId,
    status: 'ACTIVE',
  });
  let managerId = '';
  try { managerId = JSON.parse(created.text).result.data.json.id || ''; } catch { managerId = ''; }
  const roles = managerId
    ? await trpc('restaurantStaff.setStaffJobRoles', {
        staffProfileId: managerId,
        branchId: ids.branchId,
        jobRoleIds: [ids.jobRoleId],
      })
    : { status: 0, text: 'no manager' };
  const pin = managerId
    ? await trpc('restaurantStaff.issueCredential', {
        staffProfileId: managerId,
        type: 'PIN',
        secret: '7391',
      })
    : { status: 0, text: 'no manager' };
  return { created, roles, pin, managerId };
}, ids);
console.log('staff', staff.created.status, staff.managerId, staff.roles.status, staff.pin.status);

await page.evaluate((branchId) => {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/restaurant/devices/browser-enroll';
  for (const [name, value] of Object.entries({ name: 'QA Finish', branchId, kind: 'POS', confirmation: 'confirmed' })) {
    const input = document.createElement('input');
    input.name = name;
    input.value = String(value);
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}, ids.branchId);
await page.waitForURL(/\/pos/);

const flow = await page.evaluate(async (args) => {
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
    const text = raw.replace(/"sessionToken":"[^"]+"/g, '"sessionToken":"[redacted]"').replace(/7391/g, '[pin]');
    out.push({ id, status: response.status, note: text.slice(0, 360) });
    return text;
  }
  await call('establish', '/api/restaurant/terminal/establish', {});
  await call('unlock', '/api/restaurant/terminal/unlock', { staffProfileId: args.staffId, type: 'PIN', secret: '4821' });
  await call('drawer', '/api/restaurant/cash/drawer/open', { openingFloat: '200.00' }, `fin-drawer-${Date.now()}`);
  const summary = await call('summary-after-partial', `/api/restaurant/checkout/summary?orderId=cmvhkt52y001cchjsuh40tmvw`, null, undefined, 'GET');
  let due = '145.50';
  try {
    const bills = JSON.parse(summary).bills as Array<{ id: string; remainingDue: string }>;
    due = bills.find((bill) => bill.id === args.billId)?.remainingDue || due;
  } catch { /* fallback */ }
  await call('PAY-03b', '/api/restaurant/checkout/tender', {
    billId: args.billId,
    tender: { type: 'CASH', amount: due, cashReceived: due },
  }, `pay-rest-${Date.now()}`);
  await call('PAY-02', `/api/restaurant/checkout/receipt?billId=${args.billId}`, null, undefined, 'GET');
  await call('PAY-07', '/api/restaurant/checkout/refund', {
    originalTenderId: args.cardTenderId,
    amount: '120.00',
    tipRefundAmount: '20.00',
    kind: 'REFUND',
    reason: 'QA card refund',
    approving: { staffProfileId: args.managerId, type: 'PIN', secret: '7391' },
  }, `refund-${Date.now()}`);
  await call('PAY-08-comp', '/api/restaurant/checkout/comp', {
    billId: args.compBillId,
    billLineId: args.compLineId,
    reason: 'QA guest complaint',
    approving: { staffProfileId: args.managerId, type: 'PIN', secret: '7391' },
  }, `comp-${Date.now()}`);

  const seat = await call('PAY-06-open', '/api/restaurant/orders/open', { channel: 'DINE_IN', publicationId: args.publicationId }, `seat-open-${Date.now()}`);
  let seatOrder = '';
  try { seatOrder = JSON.parse(seat).orderId || ''; } catch { seatOrder = ''; }
  await call('seat-1', '/api/restaurant/orders/add-item', { orderId: seatOrder, menuItemId: args.karahiId, seatNumber: 1 }, `seat-1-${Date.now()}`);
  await call('seat-2', '/api/restaurant/orders/add-item', { orderId: seatOrder, menuItemId: args.naanId, seatNumber: 2 }, `seat-2-${Date.now()}`);
  await call('seat-fire', '/api/restaurant/orders/fire', { orderId: seatOrder }, `seat-fire-${Date.now()}`);
  await call('PAY-06', '/api/restaurant/checkout/bill', { orderId: seatOrder, split: { kind: 'BY_SEAT' } }, `seat-bill-${Date.now()}`);

  const voidOpen = await call('ORD-void-open', '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId: args.publicationId }, `void-open-${Date.now()}`);
  let voidOrder = '';
  try { voidOrder = JSON.parse(voidOpen).orderId || ''; } catch { voidOrder = ''; }
  const voidItem = await call('void-item', '/api/restaurant/orders/add-item', { orderId: voidOrder, menuItemId: args.naanId }, `void-item-${Date.now()}`);
  let voidItemId = '';
  try { voidItemId = JSON.parse(voidItem).itemId || ''; } catch { voidItemId = ''; }
  await call('ORD-void', '/api/restaurant/orders/void', {
    orderId: voidOrder, itemId: voidItemId, reason: 'QA wrong item',
  }, `void-${Date.now()}`);

  await call('PAY-day-preview', '/api/restaurant/cash/day/preview?businessDate=2026-10-21', null, undefined, 'GET');
  await call('PAY-day-close', '/api/restaurant/cash/day/close', { businessDate: '2026-10-21' }, `close-${Date.now()}`);
  return out;
}, { ...ids, managerId: staff.managerId });

writeFileSync('/workspace/qa/restaurants/evidence/pos-finish.json', JSON.stringify({ staff: { created: staff.created, roles: staff.roles, pin: staff.pin, managerId: staff.managerId }, flow }, null, 2));
for (const row of flow) console.log(row.status, row.id, row.note.slice(0, 170));
await page.screenshot({ path: '/workspace/qa/restaurants/evidence/pos-finish.png' });
await page.context().close();

const kdsPage = await (await browser.newContext()).newPage();
kdsPage.setDefaultTimeout(45000);
await kdsPage.goto(`${HOUSE}/login`);
await kdsPage.locator('input[name="email"]').fill('qa-karahi-owner@example.com');
await kdsPage.locator('input[name="password"]').fill('QaRestaurant!Owner2026');
await kdsPage.getByRole('button', { name: 'Sign in' }).click();
await kdsPage.waitForURL((url) => !url.pathname.startsWith('/login'));
await kdsPage.evaluate((args) => {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/restaurant/devices/browser-enroll';
  for (const [name, value] of Object.entries({ name: 'QA Hot line', branchId: args.branchId, kind: 'KDS', stationId: args.stationId, confirmation: 'confirmed' })) {
    const input = document.createElement('input');
    input.name = name;
    input.value = String(value);
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}, ids);
await kdsPage.waitForURL(/\/kds/);
const kds = await kdsPage.evaluate(async (args) => {
  const out: Array<{ id: string; status: number; note: string }> = [];
  let session = '';
  async function call(id: string, path: string, body: unknown, key?: string, method = 'POST') {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['content-type'] = 'application/json';
    if (key) headers['idempotency-key'] = key;
    if (session) headers['x-terminal-session'] = session;
    const response = await fetch(path, { method, credentials: 'include', headers, body: method === 'GET' ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    if (!session) {
      try { session = JSON.parse(raw).sessionToken || session; } catch { /* ignore */ }
    }
    const text = raw.replace(/"sessionToken":"[^"]+"/g, '"sessionToken":"[redacted]"');
    out.push({ id, status: response.status, note: text.slice(0, 300) });
    return text;
  }
  await call('kds-establish', '/api/restaurant/terminal/establish', {});
  await call('kds-unlock', '/api/restaurant/terminal/unlock', { staffProfileId: args.staffId, type: 'PIN', secret: '4821' });
  await call('KDS-queue', '/api/restaurant/kds/queue?limit=5', null, undefined, 'GET');
  await call('KDS-02', '/api/restaurant/kds/ack', { orderItemId: args.kdsItemId, operatorStaffProfileId: args.staffId }, `ack-${Date.now()}`);
  await call('KDS-03', '/api/restaurant/kds/bump', { orderItemId: args.kdsItemId, operatorStaffProfileId: args.staffId }, `bump-${Date.now()}`);
  return out;
}, ids);
writeFileSync('/workspace/qa/restaurants/evidence/kds.json', JSON.stringify(kds, null, 2));
for (const row of kds) console.log(row.status, row.id, row.note.slice(0, 160));
await kdsPage.screenshot({ path: '/workspace/qa/restaurants/evidence/kds.png' });
await browser.close();
