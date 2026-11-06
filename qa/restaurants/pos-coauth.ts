import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const managerId = 'cmvhl1tkv005xchjsjecd9zz9';
const ids = {
  branchId: 'cmvhhcldp000m1yjs2sc9obnz',
  staffId: 'cmvhhclfk004o1yjs8ekhf7z5',
  jobRoleId: 'cmvhhclf000361yjssb1hecpy',
  billId: 'cmvhkt5ds0027chjsijqnsxuk',
  cardTenderId: 'cmvhkzgtr004mchjsxn4713ro',
  compBillId: 'cmvhkzhly005jchjsp0yj93he',
  compLineId: 'cmvhkzhm3005kchjsoz6uwifc',
  managerId,
};
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(45000);
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
    const text = await response.text();
    return { status: response.status, text: text.slice(0, 280) };
  }
  const roles = await trpc('restaurantStaff.setStaffJobRoles', {
    staffProfileId: ids.managerId,
    branchId: ids.branchId,
    jobRoleIds: [ids.jobRoleId],
  });
  const pin = await trpc('restaurantStaff.issueCredential', {
    staffProfileId: ids.managerId,
    type: 'PIN',
    secret: '7391',
  });
  return { roles, pin };
}, ids);
console.log('roles', prep.roles.status, prep.roles.text.slice(0, 140));
console.log('pin', prep.pin.status, prep.pin.text.slice(0, 140));

await page.evaluate((branchId) => {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/restaurant/devices/browser-enroll';
  for (const [name, value] of Object.entries({ name: 'QA Coauth', branchId, kind: 'POS', confirmation: 'confirmed' })) {
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
  async function call(id: string, path: string, body: unknown, key?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers['idempotency-key'] = key;
    if (session) headers['x-terminal-session'] = session;
    const response = await fetch(path, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
    const raw = await response.text();
    if (!session) {
      try { session = JSON.parse(raw).sessionToken || session; } catch { /* ignore */ }
    }
    out.push({ id, status: response.status, note: raw.replace(/"sessionToken":"[^"]+"/g, '"sessionToken":"[redacted]"').replace(/7391/g, '[pin]').slice(0, 320) });
  }
  await call('establish', '/api/restaurant/terminal/establish', {});
  await call('unlock', '/api/restaurant/terminal/unlock', { staffProfileId: ids.staffId, type: 'PIN', secret: '4821' });
  await call('drawer', '/api/restaurant/cash/drawer/open', { openingFloat: '100.00' }, `co-drawer-${Date.now()}`);
  await call('PAY-03c', '/api/restaurant/checkout/tender', {
    billId: ids.billId,
    tender: { type: 'CASH', amount: '145.50', cashReceived: '200.00' },
  }, `tax-due-${Date.now()}`);
  await call('PAY-07', '/api/restaurant/checkout/refund', {
    originalTenderId: ids.cardTenderId,
    amount: '120.00',
    tipRefundAmount: '20.00',
    kind: 'REFUND',
    reason: 'QA card refund',
    approving: { staffProfileId: ids.managerId, type: 'PIN', secret: '7391' },
  }, `refund-${Date.now()}`);
  await call('PAY-comp', '/api/restaurant/checkout/comp', {
    billId: ids.compBillId,
    billLineId: ids.compLineId,
    reason: 'QA guest complaint',
    approving: { staffProfileId: ids.managerId, type: 'PIN', secret: '7391' },
  }, `comp-${Date.now()}`);
  return out;
}, ids);
writeFileSync('/workspace/qa/restaurants/evidence/pos-coauth.json', JSON.stringify({ prep, flow }, null, 2));
for (const row of flow) console.log(row.status, row.id, row.note.slice(0, 180));
await page.screenshot({ path: '/workspace/qa/restaurants/evidence/pos-coauth.png' });
await browser.close();
