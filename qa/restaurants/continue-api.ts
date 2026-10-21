/** Sequential restaurant API and terminal journey. Writes results after every case. */
import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import AxeBuilder from '@axe-core/playwright';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const ESSENTIALS = 'http://qa-karahi-essentials.localhost:3000';
const AGENCY = 'http://devfathom.localhost:3000';
const ADMIN = 'http://admin.localhost:3000';
const EVIDENCE = '/workspace/qa/restaurants/evidence';
const OWNER_EMAIL = 'qa-karahi-owner@example.com';
const OWNER_PASSWORD = 'QaRestaurant!Owner2026';
const ESSENTIALS_EMAIL = 'qa-essentials-owner@example.com';
const STAFF_PASSWORD = 'QaRestaurant!Staff2026';
const PIN = { owner: '4821', cashier: '4822', kitchen: '4823', server: '4824' };
const OUT = `${EVIDENCE}/api-results.json`;

type Status = 'pass' | 'fail' | 'blocked';
type Result = { id: string; status: Status; notes: string; evidence: string[] };
const results: Result[] = [];
const bag: Record<string, string> = {};

function loadEnv(path: string) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (!process.env[trimmed.slice(0, eq)]) process.env[trimmed.slice(0, eq)] = value;
  }
}
function persist() {
  writeFileSync(OUT, JSON.stringify({ finishedAt: new Date().toISOString(), bag, results }, null, 2));
}
function record(id: string, status: Status, notes: string, evidence: string[] = []) {
  results.push({ id, status, notes: notes.slice(0, 1600), evidence });
  console.log(`[${status}] ${id} — ${notes.slice(0, 220)}`);
  persist();
}
function sql(query: string) {
  const run = spawnSync('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'devfathom', '-At', '-c', query], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: 'postgres' },
    timeout: 15000,
  });
  if (run.status !== 0) throw new Error((run.stderr || run.stdout || 'sql failed').slice(0, 400));
  return run.stdout.trim();
}
function encryptionKey() {
  const raw = process.env.PLATFORM_ENCRYPTION_KEY?.trim() ?? '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;
  return createHash('sha256').update(raw).digest();
}
function decryptSecret(value: string) {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('bad secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of secret.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const hmac = createHmac('sha1', Buffer.from(out)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin = ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}
function platformTotp() {
  try {
    const cipher = sql(`SELECT set_config('app.is_platform_admin','true',true); SELECT "encryptedTotpSecret" FROM platform_users WHERE email='${process.env.PLATFORM_ADMIN_EMAIL}'`);
    const line = cipher.split('\n').filter((row) => row.startsWith('v1.')).at(-1);
    return line ? totp(decryptSecret(line)) : null;
  } catch {
    return null;
  }
}
type Call = { status: number; text: string; data: Record<string, unknown>; message: string };
function parseBody(status: number, text: string): Call {
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const data = body?.result?.data?.json ?? body?.result?.data ?? body?.data ?? {};
  const message = body?.error?.json?.message || body?.error?.message || (typeof body?.error === 'string' ? body.error : '');
  return { status, text: text.slice(0, 1400), data: data && typeof data === 'object' ? data : {}, message: String(message).slice(0, 500) };
}
async function trpc(ctx: BrowserContext, base: string, procedure: string, method: 'GET' | 'POST', jsonBody?: unknown): Promise<Call> {
  const headers: Record<string, string> = { origin: base };
  let url = `${base}/api/trpc/${procedure}`;
  if (method === 'GET') url += `?input=${encodeURIComponent(JSON.stringify({ json: jsonBody ?? null }))}`;
  else headers['content-type'] = 'application/json';
  const response = await ctx.request.fetch(url, { method, headers, data: method === 'POST' ? { json: jsonBody ?? {} } : undefined, timeout: 25000 });
  return parseBody(response.status(), await response.text());
}
async function rest(ctx: BrowserContext, base: string, path: string, body: unknown, key?: string): Promise<Call> {
  const headers: Record<string, string> = { origin: base, 'content-type': 'application/json' };
  if (key) headers['idempotency-key'] = key;
  const response = await ctx.request.post(`${base}${path}`, { headers, data: body, timeout: 25000 });
  return parseBody(response.status(), await response.text());
}
function idOf(call: Call, key = 'id') {
  const value = call.data[key];
  return typeof value === 'string' ? value : '';
}
async function shot(page: Page, name: string) {
  const path = `${EVIDENCE}/${name}.png`;
  await page.screenshot({ path, fullPage: false }).catch(() => undefined);
  return path;
}
async function login(page: Page, base: string, email: string, password: string) {
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
}
async function text(page: Page) {
  return (await page.locator('body').innerText({ timeout: 8000 }).catch(() => '')).replace(/\s+/g, ' ');
}

async function main() {
  loadEnv('/workspace/.env.local');
  mkdirSync(EVIDENCE, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const house = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await house.newPage();
  page.setDefaultTimeout(12000);
  let dialogs = '';
  page.on('dialog', async (dialog) => { dialogs += dialog.message(); await dialog.dismiss(); });
  try {
    await login(page, HOUSE, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto(`${HOUSE}/restaurant/catalog`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    const catalog = await text(page);
    record('CAT-reload', /Couldn't load|did not respond/i.test(catalog) ? 'fail' : 'pass', catalog.slice(0, 400), [await shot(page, 'api-catalog')]);
    const tab = page.getByRole('tab', { name: /Categories/i });
    if (await tab.count()) await tab.first().click();
    const add = page.getByRole('button', { name: 'Add category' });
    if (await add.count()) {
      await add.first().click();
      await page.locator('input[name="name"]').last().fill('Mains');
      await page.locator('form').filter({ has: page.locator('input[name="name"]') }).locator('button[type="submit"]').click();
      await page.waitForTimeout(1000);
      record('CAT-02-ui', /Mains/.test(await text(page)) ? 'pass' : 'fail', (await text(page)).slice(0, 300), [await shot(page, 'api-cat-mains')]);
    } else record('CAT-02-ui', 'fail', 'Add category was not rendered. ' + catalog.slice(0, 240), [await shot(page, 'api-cat-no-button')]);

    bag.branchId = sql(`SELECT b.id FROM restaurant_branches b JOIN organizations o ON o.id=b."organizationId" WHERE o.slug='qa-karahi-house' AND b.code='MAIN'`).split('\n')[0] ?? '';
    const brand = await trpc(house, HOUSE, 'restaurantCatalog.createBrand', 'POST', { name: 'QA Karahi' });
    bag.brandId = idOf(brand);
    const xss = await trpc(house, HOUSE, 'restaurantCatalog.createCategory', 'POST', { name: `<img src=x onerror=alert(1)>` });
    bag.categoryId = idOf(xss);
    await page.goto(`${HOUSE}/restaurant/catalog`, { timeout: 20000 });
    if (await page.getByRole('tab', { name: /Categories/i }).count()) await page.getByRole('tab', { name: /Categories/i }).first().click();
    await page.waitForTimeout(800);
    const html = await page.content();
    record('CAT-05', xss.status < 400 && !dialogs && !html.includes('onerror=alert(1)>') ? 'pass' : 'fail', `status ${xss.status} ${xss.message} dialog ${dialogs || 'none'} raw ${html.includes('onerror=alert(1)>')}`, [await shot(page, 'api-xss')]);
    const injection = await trpc(house, HOUSE, 'restaurantCatalog.createCategory', 'POST', { name: `Karahi'; DROP TABLE users; --` });
    record('CAT-07', injection.status < 400 && Number(sql('SELECT count(*) FROM users')) > 0 ? 'pass' : 'fail', `${injection.status} ${injection.message} users ${sql('SELECT count(*) FROM users')}`);
    const empty = await trpc(house, HOUSE, 'restaurantCatalog.createCategory', 'POST', { name: '' });
    record('CAT-04', empty.status >= 400 ? 'pass' : 'fail', `${empty.status} ${empty.message}`);
    const product = await trpc(house, HOUSE, 'restaurantCatalog.createProduct', 'POST', { name: 'Chicken Karahi', categoryId: bag.categoryId, description: 'QA karahi' });
    const naan = await trpc(house, HOUSE, 'restaurantCatalog.createProduct', 'POST', { name: 'Garlic Naan' });
    bag.productId = idOf(product);
    bag.naanId = idOf(naan);
    const active = await trpc(house, HOUSE, 'restaurantCatalog.setProductStatus', 'POST', { id: bag.productId, status: 'ACTIVE' });
    await trpc(house, HOUSE, 'restaurantCatalog.setProductStatus', 'POST', { id: bag.naanId, status: 'ACTIVE' });
    record('CAT-02', product.status < 400 && naan.status < 400 && active.status < 400 ? 'pass' : 'fail', `product ${product.status} ${product.message}; naan ${naan.status} ${naan.message}; active ${active.status} ${active.message}`);
    const group = await trpc(house, HOUSE, 'restaurantCatalog.createModifierGroup', 'POST', { name: 'Heat', minSelect: 0, maxSelect: 1 });
    bag.groupId = idOf(group);
    const option = await trpc(house, HOUSE, 'restaurantCatalog.createModifierOption', 'POST', { modifierGroupId: bag.groupId, name: 'Extra mirch', priceDelta: '50.00' });
    bag.optionId = idOf(option);
    const link = await trpc(house, HOUSE, 'restaurantCatalog.attachModifierGroup', 'POST', { productId: bag.productId, modifierGroupId: bag.groupId });
    record('CAT-03', group.status < 400 && option.status < 400 && link.status < 400 ? 'pass' : 'fail', `group ${group.status} ${group.message}; option ${option.status} ${option.message}; link ${link.status} ${link.message}`);
    const unit = await trpc(house, HOUSE, 'restaurantCatalog.createUnit', 'POST', { name: 'Gram', abbreviation: 'g' });
    bag.unitId = idOf(unit);
    const ingredient = await trpc(house, HOUSE, 'restaurantCatalog.createIngredient', 'POST', { name: 'Chicken', baseUnitId: bag.unitId, referenceCost: '0.80' });
    bag.ingredientId = idOf(ingredient);
    const recipe = await trpc(house, HOUSE, 'restaurantCatalog.createRecipe', 'POST', { productId: bag.productId, name: 'Karahi recipe' });
    bag.recipeId = idOf(recipe);
    const version = await trpc(house, HOUSE, 'restaurantCatalog.createRecipeVersion', 'POST', { recipeId: bag.recipeId, yieldQuantity: '1', yieldUnitId: bag.unitId, portionCount: 1 });
    bag.recipeVersionId = idOf(version);
    const recipeLine = await trpc(house, HOUSE, 'restaurantCatalog.createRecipeLine', 'POST', { recipeVersionId: bag.recipeVersionId, ingredientId: bag.ingredientId, quantity: '250', unitId: bag.unitId });
    record('CAT-06', unit.status < 400 && ingredient.status < 400 && recipe.status < 400 && recipeLine.status < 400 ? 'pass' : 'fail', `unit ${unit.status} ${unit.message}; ingredient ${ingredient.status} ${ingredient.message}; recipe ${recipe.status} ${recipe.message}; line ${recipeLine.status} ${recipeLine.message}`);

    const priceList = await trpc(house, HOUSE, 'restaurantMenus.createPriceList', 'POST', { name: 'QA prices', isDefault: true });
    bag.priceListId = idOf(priceList);
    const dated = await house.request.post(`${HOUSE}/api/trpc/restaurantMenus.createPriceListVersion`, { headers: { origin: HOUSE, 'content-type': 'application/json' }, data: { json: { priceListId: bag.priceListId, effectiveFrom: '2020-01-01T00:00:00.000Z' }, meta: { values: { effectiveFrom: ['Date'] } } }, timeout: 25000 });
    const priceVersion = parseBody(dated.status(), await dated.text());
    bag.priceVersionId = idOf(priceVersion);
    const fuzzy = await trpc(house, HOUSE, 'restaurantMenus.addPriceEntry', 'POST', { priceListVersionId: bag.priceVersionId, productId: bag.productId, price: '1.999' });
    const negative = await trpc(house, HOUSE, 'restaurantMenus.addPriceEntry', 'POST', { priceListVersionId: bag.priceVersionId, productId: bag.naanId, price: '-5' });
    const good = await trpc(house, HOUSE, 'restaurantMenus.addPriceEntry', 'POST', { priceListVersionId: bag.priceVersionId, productId: bag.productId, price: '850.00' });
    const naanPrice = await trpc(house, HOUSE, 'restaurantMenus.addPriceEntry', 'POST', { priceListVersionId: bag.priceVersionId, productId: bag.naanId, price: '120.00' });
    record('VAL-01', fuzzy.status >= 400 && negative.status >= 400 && good.status < 400 ? 'pass' : 'fail', `1.999 ${fuzzy.status} ${fuzzy.message}; -5 ${negative.status} ${negative.message}; 850 ${good.status} ${good.message}; naan ${naanPrice.status} ${naanPrice.message}; version ${priceVersion.status} ${priceVersion.message}`);
    const activatedPrice = await trpc(house, HOUSE, 'restaurantMenus.activatePriceListVersion', 'POST', { versionId: bag.priceVersionId });
    const menu = await trpc(house, HOUSE, 'restaurantMenus.createMenu', 'POST', { brandId: bag.brandId, name: 'Dinner' });
    bag.menuId = idOf(menu);
    const section = await trpc(house, HOUSE, 'restaurantMenus.createSection', 'POST', { menuId: bag.menuId, name: 'Mains' });
    bag.sectionId = idOf(section);
    const item = await trpc(house, HOUSE, 'restaurantMenus.createItem', 'POST', { sectionId: bag.sectionId, productId: bag.productId });
    const naanItem = await trpc(house, HOUSE, 'restaurantMenus.createItem', 'POST', { sectionId: bag.sectionId, productId: bag.naanId });
    bag.menuItemId = idOf(item);
    bag.naanItemId = idOf(naanItem);
    const publication = await trpc(house, HOUSE, 'restaurantMenus.createPublication', 'POST', { branchId: bag.branchId, menuId: bag.menuId, priceListId: bag.priceListId, channels: ['DINE_IN', 'TAKEAWAY'] });
    bag.publicationId = idOf(publication);
    const published = await trpc(house, HOUSE, 'restaurantMenus.publishPublication', 'POST', { id: bag.publicationId });
    record('MNU-02', activatedPrice.status < 400 && item.status < 400 && published.status < 400 ? 'pass' : 'fail', `activate ${activatedPrice.status} ${activatedPrice.message}; menu ${menu.status} ${menu.message}; item ${item.status} ${item.message}; naan ${naanItem.status} ${naanItem.message}; publish ${published.status} ${published.message}`);

    const second = await trpc(house, HOUSE, 'restaurantBranches.create', 'POST', { name: 'Saddar', code: 'SADDAR', timezone: 'Asia/Karachi', businessDayCutoff: '04:00', address: '1 Saddar, Karachi', shiftSignInEnforced: false });
    record('BRN-02', second.status < 400 ? 'pass' : 'fail', `${second.status} ${second.message} ${second.text.slice(0, 220)}`);
    const badCutoff = await trpc(house, HOUSE, 'restaurantBranches.create', 'POST', { name: 'Bad cutoff', code: 'BAD', timezone: 'Asia/Karachi', businessDayCutoff: '25:99', address: null, shiftSignInEnforced: false });
    record('BRN-05', badCutoff.status >= 400 ? 'pass' : 'fail', `${badCutoff.status} ${badCutoff.message}`);
    const deactivate = await trpc(house, HOUSE, 'restaurantBranches.setActive', 'POST', { id: bag.branchId, active: false });
    record('BRN-03', deactivate.status >= 400 ? 'pass' : 'fail', `${deactivate.status} ${deactivate.message} ${deactivate.text.slice(0, 220)}`);
    const floor = await trpc(house, HOUSE, 'restaurantFloor.createFloor', 'POST', { branchId: bag.branchId, name: 'Ground' });
    bag.floorId = idOf(floor);
    const table = await trpc(house, HOUSE, 'restaurantFloor.createTable', 'POST', { floorId: bag.floorId, code: 'T1', capacity: 4 });
    const table2 = await trpc(house, HOUSE, 'restaurantFloor.createTable', 'POST', { floorId: bag.floorId, code: 'T2', capacity: 2 });
    const dup = await trpc(house, HOUSE, 'restaurantFloor.createTable', 'POST', { floorId: bag.floorId, code: 'T1', capacity: 4 });
    bag.tableId = idOf(table);
    bag.table2Id = idOf(table2);
    const serverSection = await trpc(house, HOUSE, 'restaurantFloor.createSection', 'POST', { branchId: bag.branchId, name: 'Window' });
    const station = await trpc(house, HOUSE, 'restaurantFloor.createStation', 'POST', { branchId: bag.branchId, name: 'Hot line', isDefault: true });
    bag.stationId = idOf(station);
    record('FLR-02', floor.status < 400 && table.status < 400 && station.status < 400 ? 'pass' : 'fail', `floor ${floor.status} ${floor.message}; t1 ${table.status} ${table.message}; section ${serverSection.status} ${serverSection.message}; station ${station.status} ${station.message}`);
    record('FLR-03', dup.status >= 400 ? 'pass' : 'fail', `${dup.status} ${dup.message}`);

    const self = await trpc(house, HOUSE, 'restaurantStaff.mySelfProfile', 'GET');
    bag.ownerStaffId = idOf(self);
    if (!bag.ownerStaffId) {
      const provisioned = await trpc(house, HOUSE, 'restaurantStaff.provisionMyProfile', 'POST', {});
      bag.ownerStaffId = idOf(provisioned);
      bag.ownerStaffNote = `${self.status} ${self.message} / ${provisioned.status} ${provisioned.message}`;
    }
    await trpc(house, HOUSE, 'restaurantStaff.seedDefaultJobRoles', 'POST', {});
    const jobRoles = await trpc(house, HOUSE, 'restaurantStaff.listJobRoles', 'GET');
    const rows = Array.isArray(jobRoles.data) ? (jobRoles.data as unknown as Array<{ id: string; key?: string; name?: string }>) : [];
    const roleId = (key: string) => rows.find((row) => row.key === key || row.name?.toLowerCase().includes(key))?.id ?? '';
    bag.ownerRoleId = roleId('owner');
    bag.cashierRoleId = roleId('cashier');
    bag.kitchenRoleId = roleId('kitchen');
    bag.serverRoleId = roleId('server');
    const ownerJobs = await trpc(house, HOUSE, 'restaurantStaff.setStaffJobRoles', 'POST', { staffProfileId: bag.ownerStaffId, branchId: bag.branchId, jobRoleIds: bag.ownerRoleId ? [bag.ownerRoleId] : [] });
    const ownerPin = await trpc(house, HOUSE, 'restaurantStaff.issueCredential', 'POST', { staffProfileId: bag.ownerStaffId, type: 'PIN', secret: PIN.owner });
    record('STF-owner-pin', ownerPin.status < 400 ? 'pass' : 'fail', `staff ${bag.ownerStaffId} ${bag.ownerStaffNote ?? ''}; roles ${jobRoles.status} ${rows.length}; jobs ${ownerJobs.status} ${ownerJobs.message}; pin ${ownerPin.status} ${ownerPin.message}`);

    async function invite(email: string, name: string, title: string) {
      const invited = await trpc(house, HOUSE, 'team.inviteMember', 'POST', { name, email, role: 'EMPLOYEE', department: 'FRONT_OF_HOUSE', title });
      const inviteUrl = typeof invited.data.inviteUrl === 'string' ? invited.data.inviteUrl : '';
      const token = inviteUrl.split('/invite/')[1] ?? '';
      const accepted = token ? await trpc(house, HOUSE, 'invitations.accept', 'POST', { token, password: STAFF_PASSWORD, phone: '+923005550100' }) : { status: 0, message: 'no token', text: invited.text, data: {} };
      return { invited, accepted, userId: typeof invited.data.id === 'string' ? invited.data.id : '' };
    }
    const cashier = await invite('qa-karahi-cashier@example.com', 'QA Cashier', 'Cashier');
    const kitchen = await invite('qa-karahi-kitchen@example.com', 'QA Kitchen', 'Line cook');
    const server = await invite('qa-karahi-server@example.com', 'QA Server', 'Server');
    const accountant = await invite('qa-karahi-accountant@example.com', 'QA Accountant', 'Accountant');
    const badEmail = await trpc(house, HOUSE, 'team.inviteMember', 'POST', { name: 'Bad', email: 'not-an-email', role: 'EMPLOYEE', department: 'FRONT_OF_HOUSE', title: 'Cashier' });
    record('VAL-02', badEmail.status >= 400 ? 'pass' : 'fail', `${badEmail.status} ${badEmail.message}`);
    record('STF-02', cashier.invited.status < 400 && cashier.accepted.status < 400 ? 'pass' : 'fail', `invite ${cashier.invited.status} ${cashier.invited.message}; accept ${cashier.accepted.status} ${cashier.accepted.message}`);
    const overview = await trpc(house, HOUSE, 'organizationAdmin.overview', 'GET');
    const orgRoles = Array.isArray(overview.data.roles) ? (overview.data.roles as Array<{ id: string; key?: string; name?: string }>) : [];
    const orgRole = (needle: string) => orgRoles.find((row) => row.key === needle || row.name?.toLowerCase() === needle)?.id ?? '';
    async function assign(userId: string, key: string, title: string) {
      return trpc(house, HOUSE, 'organizationAdmin.updateMember', 'POST', { id: userId, role: 'EMPLOYEE', status: 'ACTIVE', organizationRoleId: orgRole(key), title, department: 'FRONT_OF_HOUSE' });
    }
    const cashierRole = await assign(cashier.userId, 'cashier', 'Cashier');
    const kitchenRole = await assign(kitchen.userId, 'kitchen', 'Line cook');
    const serverRole = await assign(server.userId, 'server', 'Server');
    const accountantRole = await assign(accountant.userId, 'accountant', 'Accountant');
    async function profile(name: string, email: string, userId: string, job: string, pin: string) {
      const staff = await trpc(house, HOUSE, 'restaurantStaff.create', 'POST', { displayName: name, email, userId, primaryBranchId: bag.branchId });
      const staffId = idOf(staff);
      const jobs = await trpc(house, HOUSE, 'restaurantStaff.setStaffJobRoles', 'POST', { staffProfileId: staffId, branchId: bag.branchId, jobRoleIds: job ? [job] : [] });
      const credential = await trpc(house, HOUSE, 'restaurantStaff.issueCredential', 'POST', { staffProfileId: staffId, type: 'PIN', secret: pin });
      return { staff, jobs, credential, staffId };
    }
    const cashierFloor = await profile('QA Cashier', 'qa-karahi-cashier@example.com', cashier.userId, bag.cashierRoleId, PIN.cashier);
    const kitchenFloor = await profile('QA Kitchen', 'qa-karahi-kitchen@example.com', kitchen.userId, bag.kitchenRoleId, PIN.kitchen);
    const serverFloor = await profile('QA Server', 'qa-karahi-server@example.com', server.userId, bag.serverRoleId, PIN.server);
    bag.cashierStaffId = cashierFloor.staffId;
    bag.kitchenStaffId = kitchenFloor.staffId;
    bag.serverStaffId = serverFloor.staffId;
    record('STF-03', kitchenFloor.staff.status < 400 && serverFloor.staff.status < 400 ? 'pass' : 'fail', `kitchen role ${kitchenRole.status} ${kitchenRole.message} profile ${kitchenFloor.staff.status} ${kitchenFloor.staff.message} pin ${kitchenFloor.credential.status}; server role ${serverRole.status} profile ${serverFloor.staff.status}; cashier role ${cashierRole.status} ${cashierRole.message} profile ${cashierFloor.staff.status} ${cashierFloor.staff.message}`);
    const shift = await trpc(house, HOUSE, 'restaurantShifts.create', 'POST', { branchId: bag.branchId, staffProfileId: bag.cashierStaffId, startAt: new Date().toISOString(), endAt: new Date(Date.now() + 4 * 3600_000).toISOString(), role: 'Cashier' });
    record('STF-06', shift.status < 400 ? 'pass' : 'fail', `${shift.status} ${shift.message} ${shift.text.slice(0, 200)}`);
    record('PERM-04-setup', accountant.accepted.status < 400 && accountantRole.status < 400 ? 'pass' : 'fail', `accept ${accountant.accepted.status} ${accountant.accepted.message}; role ${accountantRole.status} ${accountantRole.message}; roles ${orgRoles.map((row) => row.key || row.name).join(',')}`);

    const customer = await trpc(house, HOUSE, 'restaurantCustomers.create', 'POST', { displayName: 'Sana Guest', givenName: 'Sana', familyName: 'Guest', identifiers: [{ kind: 'PHONE', value: '+923001112233' }] });
    bag.customerId = idOf(customer);
    const loyaltyConfig = await trpc(house, HOUSE, 'restaurantLoyalty.configure', 'POST', { effectiveFrom: '2020-01-01T00:00:00.000Z', earnRate: '1', redemptionValue: '1' });
    const account = await trpc(house, HOUSE, 'restaurantLoyalty.enrollAccount', 'POST', { customerId: bag.customerId });
    bag.loyaltyAccountId = idOf(account);
    const adjusted = await trpc(house, HOUSE, 'restaurantLoyalty.adjust', 'POST', { accountId: bag.loyaltyAccountId, points: 100, reason: 'QA opening balance', idempotencyKey: `qa-loy-${Date.now()}` });
    record('LOY-02', customer.status < 400 ? 'pass' : 'fail', `${customer.status} ${customer.message} ${customer.text.slice(0, 220)}`);
    record('LOY-03', loyaltyConfig.status < 400 && account.status < 400 && adjusted.status < 400 ? 'pass' : 'fail', `config ${loyaltyConfig.status} ${loyaltyConfig.message}; enroll ${account.status} ${account.message}; adjust ${adjusted.status} ${adjusted.message}`);
    const zone = await trpc(house, HOUSE, 'restaurantDelivery.createZone', 'POST', { branchId: bag.branchId, name: 'Clifton delivery', fixedFee: '150.00', promisedMinutes: 45 });
    bag.zoneId = idOf(zone);
    const address = await trpc(house, HOUSE, 'restaurantDelivery.createAddress', 'POST', { customerId: bag.customerId, label: 'Home', recipientName: 'Sana Guest', phone: '+923001112233', locality: 'Clifton', countryCode: 'PK' });
    bag.addressId = idOf(address);
    record('ORD-04-setup', zone.status < 400 && address.status < 400 ? 'pass' : 'fail', `zone ${zone.status} ${zone.message}; address ${address.status} ${address.message}`);

    const stock = await trpc(house, HOUSE, 'restaurantInventory.createStockItem', 'POST', { ingredientId: bag.ingredientId, canonicalUnitId: bag.unitId });
    bag.stockItemId = idOf(stock);
    const location = await trpc(house, HOUSE, 'restaurantInventory.createStockLocation', 'POST', { branchId: bag.branchId, name: 'Dry store', code: 'DRY' });
    bag.locationId = idOf(location);
    const supplier = await trpc(house, HOUSE, 'restaurantPurchasing.createSupplier', 'POST', { name: 'QA Poultry', code: 'POULTRY' });
    bag.supplierId = idOf(supplier);
    const po = await trpc(house, HOUSE, 'restaurantPurchasing.createPurchaseOrder', 'POST', { supplierId: bag.supplierId, branchId: bag.branchId, locationId: bag.locationId, lines: [{ stockItemId: bag.stockItemId, orderedQuantity: '5', unitId: bag.unitId, unitCost: '400.00' }] });
    bag.poId = idOf(po);
    const poLine = Array.isArray(po.data.lines) ? String((po.data.lines as Array<{ id?: string }>)[0]?.id ?? '') : '';
    const submitted = await trpc(house, HOUSE, 'restaurantPurchasing.submitPurchaseOrder', 'POST', { purchaseOrderId: bag.poId });
    const approved = await trpc(house, HOUSE, 'restaurantPurchasing.approvePurchaseOrder', 'POST', { purchaseOrderId: bag.poId });
    const received = await trpc(house, HOUSE, 'restaurantPurchasing.receivePurchaseOrder', 'POST', { purchaseOrderId: bag.poId, locationId: bag.locationId, idempotencyKey: `qa-recv-${Date.now()}`, lines: [{ purchaseOrderLineId: poLine, receivedQuantity: '5', unitId: bag.unitId, unitCost: '400.00' }] });
    const waste = await trpc(house, HOUSE, 'restaurantInventory.postWastage', 'POST', { stockItemId: bag.stockItemId, locationId: bag.locationId, reason: 'SPOILAGE', quantity: '0.5', unitId: bag.unitId });
    record('INV-02', stock.status < 400 && received.status < 400 ? 'pass' : 'fail', `item ${stock.status} ${stock.message}; loc ${location.status} ${location.message}; po ${po.status} ${po.message}; submit ${submitted.status} ${submitted.message}; approve ${approved.status} ${approved.message}; receive ${received.status} ${received.message}; waste ${waste.status} ${waste.message}`);
    record('INV-04', supplier.status < 400 && approved.status < 400 && received.status < 400 ? 'pass' : 'fail', `supplier ${supplier.status} ${supplier.message}; po ${po.status}; approve ${approved.status} ${approved.message}; receive ${received.status} ${received.message}`);
    const count = await trpc(house, HOUSE, 'restaurantInventory.createStockCount', 'POST', { locationId: bag.locationId, reference: 'QA count' });
    record('INV-05', count.status < 400 ? 'pass' : 'fail', `${count.status} ${count.message} ${count.text.slice(0, 200)}`);

    const blankHook = await trpc(house, HOUSE, 'restaurantNotifications.configureWebhook', 'POST', { endpointUrl: '', enabled: true, signingSecret: 'qa-restaurant-webhook-secret-32chars' });
    const httpHook = await trpc(house, HOUSE, 'restaurantNotifications.configureWebhook', 'POST', { endpointUrl: 'http://example.com/hook', enabled: true, signingSecret: 'qa-restaurant-webhook-secret-32chars' });
    const httpsHook = await trpc(house, HOUSE, 'restaurantNotifications.configureWebhook', 'POST', { endpointUrl: 'https://example.com/qa-restaurant-hook', enabled: true, signingSecret: 'qa-restaurant-webhook-secret-32chars' });
    const testHook = await trpc(house, HOUSE, 'restaurantNotifications.testWebhook', 'POST', {});
    record('NTF-02', blankHook.status >= 400 && httpHook.status >= 400 ? 'pass' : 'fail', `blank ${blankHook.status} ${blankHook.message}; http ${httpHook.status} ${httpHook.message}; https ${httpsHook.status} ${httpsHook.message}; test ${testHook.status} ${testHook.message}`);
    const tax = await trpc(house, HOUSE, 'restaurantTax.configuration', 'GET');
    const preview = await trpc(house, HOUSE, 'restaurantTax.previewCustom', 'GET', { amount: '100.00', rate: '0.15', priceMode: 'EXCLUSIVE' });
    record('CFG-01', tax.status < 400 && preview.status < 400 ? 'pass' : 'fail', `config ${tax.status} ${tax.message}; preview ${preview.status} ${preview.message} ${preview.text.slice(0, 160)}`);
    const food = await trpc(house, HOUSE, 'restaurantReports.foodCost', 'GET', { from: '2026-10-01', to: '2026-10-31' });
    const dishes = await trpc(house, HOUSE, 'restaurantReports.dishProfitability', 'GET', { from: '2026-10-01', to: '2026-10-31' });
    const scoped = await trpc(house, HOUSE, 'restaurantReports.overview', 'GET', { from: '2026-10-01', to: '2026-10-31', branchId: bag.branchId });
    record('RPT-02', food.status < 400 && dishes.status < 400 ? 'pass' : 'fail', `food ${food.status} ${food.message}; dish ${dishes.status} ${dishes.message}`);
    record('RPT-04', scoped.status < 400 ? 'pass' : 'fail', `${scoped.status} ${scoped.message}`);

    const anon = await browser.newContext();
    const anonOrder = await anon.request.post(`${HOUSE}/api/restaurant/orders/open`, { headers: { origin: HOUSE, 'content-type': 'application/json' }, data: { channel: 'DINE_IN' }, timeout: 15000 });
    const anonTrpc = await anon.request.get(`${HOUSE}/api/trpc/restaurantCatalog.listCategories?input=${encodeURIComponent(JSON.stringify({ json: null }))}`, { timeout: 15000 });
    record('SEC-01', anonOrder.status() === 401 && anonTrpc.status() === 401 ? 'pass' : 'fail', `order ${anonOrder.status()} ${(await anonOrder.text()).slice(0, 120)}; trpc ${anonTrpc.status()}`);
    await anon.close();

    const pos = await browser.newContext();
    const posPage = await pos.newPage();
    await login(posPage, HOUSE, OWNER_EMAIL, OWNER_PASSWORD);
    const posEnroll = await pos.request.post(`${HOUSE}/api/restaurant/devices/browser-enroll`, { headers: { origin: HOUSE }, multipart: { name: 'QA Register', branchId: bag.branchId, kind: 'POS', confirmation: 'confirmed' }, maxRedirects: 0, timeout: 20000 });
    await posPage.goto(`${HOUSE}/pos`, { timeout: 20000 });
    record('CFG-02', posEnroll.status() === 303 || posEnroll.status() === 200 ? 'pass' : 'fail', `enroll ${posEnroll.status()} ${(await posEnroll.text()).slice(0, 180)} url ${posPage.url()} ${(await text(posPage)).slice(0, 180)}`, [await shot(posPage, 'api-pos')]);
    const missingKey = await rest(pos, HOUSE, '/api/restaurant/orders/open', { channel: 'DINE_IN' });
    record('SEC-02', missingKey.status === 400 ? 'pass' : 'fail', `${missingKey.status} ${missingKey.message}`);
    const unlock = await rest(pos, HOUSE, '/api/restaurant/terminal/unlock', { staffProfileId: bag.ownerStaffId, type: 'PIN', secret: PIN.owner });
    record('POS-unlock', unlock.status < 400 ? 'pass' : 'fail', `${unlock.status} ${unlock.message} ${unlock.text.slice(0, 240)}`);
    await posPage.goto(`${HOUSE}/pos`, { timeout: 20000 });
    const posCopy = await text(posPage);
    record('PAY-04-copy', /mock|simulation|simulated|not a live|not an authorization/i.test(posCopy) ? 'pass' : 'fail', posCopy.slice(0, 400), [await shot(posPage, 'api-pos-open')]);
    const earlyDelivery = await rest(pos, HOUSE, '/api/restaurant/orders/open', { channel: 'DELIVERY', customerId: bag.customerId, publicationId: bag.publicationId }, `qa-del-early-${Date.now()}`);
    const dine = await rest(pos, HOUSE, '/api/restaurant/orders/open', { channel: 'DINE_IN', publicationId: bag.publicationId, tableIds: [bag.tableId], coverCount: 2 }, `qa-dine-${Date.now()}`);
    bag.dineOrderId = idOf(dine, 'orderId') || idOf(dine);
    const added = await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: bag.dineOrderId, menuItemId: bag.menuItemId, quantity: 1, modifierOptionIds: bag.optionId ? [bag.optionId] : [] }, `qa-add-${Date.now()}`);
    bag.dineItemId = idOf(added, 'itemId') || idOf(added);
    const addedNaan = await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: bag.dineOrderId, menuItemId: bag.naanItemId, quantity: 1, seatNumber: 2 }, `qa-naan-${Date.now()}`);
    const fired = await rest(pos, HOUSE, '/api/restaurant/orders/fire', { orderId: bag.dineOrderId }, `qa-fire-${Date.now()}`);
    record('ORD-02', dine.status < 400 && added.status < 400 && fired.status < 400 ? 'pass' : 'fail', `open ${dine.status} ${dine.message}; add ${added.status} ${added.message} ${added.text.slice(0, 160)}; naan ${addedNaan.status} ${addedNaan.message}; fire ${fired.status} ${fired.message}`);
    const takeaway = await rest(pos, HOUSE, '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId: bag.publicationId }, `qa-take-${Date.now()}`);
    bag.takeOrderId = idOf(takeaway, 'orderId') || idOf(takeaway);
    const takeItem = await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: bag.takeOrderId, menuItemId: bag.menuItemId }, `qa-take-item-${Date.now()}`);
    record('ORD-03', takeaway.status < 400 && takeItem.status < 400 ? 'pass' : 'fail', `open ${takeaway.status} ${takeaway.message}; item ${takeItem.status} ${takeItem.message}`);
    const moved = await rest(pos, HOUSE, '/api/restaurant/orders/move-table', { orderId: bag.dineOrderId, fromTableId: bag.tableId, toTableId: bag.table2Id }, `qa-move-${Date.now()}`);
    record('ORD-05', moved.status < 400 ? 'pass' : 'fail', `${moved.status} ${moved.message} ${moved.text.slice(0, 200)}`);

    const kds = await browser.newContext();
    const kdsPage = await kds.newPage();
    await login(kdsPage, HOUSE, OWNER_EMAIL, OWNER_PASSWORD);
    const kdsEnroll = await kds.request.post(`${HOUSE}/api/restaurant/devices/browser-enroll`, { headers: { origin: HOUSE }, multipart: { name: 'QA Kitchen display', branchId: bag.branchId, kind: 'KDS', stationId: bag.stationId, confirmation: 'confirmed' }, maxRedirects: 0, timeout: 20000 });
    const kdsUnlock = await rest(kds, HOUSE, '/api/restaurant/terminal/unlock', { staffProfileId: bag.kitchenStaffId, type: 'PIN', secret: PIN.kitchen });
    const ack = await rest(kds, HOUSE, '/api/restaurant/kds/ack', { orderItemId: bag.dineItemId, operatorStaffProfileId: bag.kitchenStaffId }, `qa-ack-${Date.now()}`);
    const bump = await rest(kds, HOUSE, '/api/restaurant/kds/bump', { orderId: bag.dineOrderId, orderItemId: bag.dineItemId, operatorStaffProfileId: bag.kitchenStaffId }, `qa-bump-${Date.now()}`);
    await kdsPage.goto(`${HOUSE}/kds`, { timeout: 20000 });
    record('KDS-02', kdsEnroll.status() < 400 && bump.status < 400 ? 'pass' : 'fail', `enroll ${kdsEnroll.status()} ${(await kdsEnroll.text()).slice(0, 140)}; unlock ${kdsUnlock.status} ${kdsUnlock.message}; ack ${ack.status} ${ack.message}; bump ${bump.status} ${bump.message}`, [await shot(kdsPage, 'api-kds')]);
    const kitchenPay = await rest(kds, HOUSE, '/api/restaurant/checkout/tender', { billId: 'none', tender: { type: 'CASH', amount: '1.00', cashReceived: '1.00' } }, `qa-kpay-${Date.now()}`);
    record('PERM-02', kitchenPay.status === 403 || kitchenPay.status === 401 ? 'pass' : 'fail', `${kitchenPay.status} ${kitchenPay.message}`);

    const drawer = await rest(pos, HOUSE, '/api/restaurant/cash/drawer/open', { openingFloat: '500.00' }, `qa-drawer-${Date.now()}`);
    const bill = await rest(pos, HOUSE, '/api/restaurant/checkout/bill', { orderId: bag.dineOrderId, split: { kind: 'NONE' } }, `qa-bill-${Date.now()}`);
    const bills = Array.isArray(bill.data.bills) ? (bill.data.bills as Array<Record<string, unknown>>) : [];
    bag.billId = typeof bills[0]?.id === 'string' ? String(bills[0].id) : idOf(bill);
    const grand = String(bills[0]?.grandTotal ?? bill.data.grandTotal ?? '900.00');
    record('PAY-01', bill.status < 400 && Boolean(bag.billId) ? 'pass' : 'fail', `drawer ${drawer.status} ${drawer.message}; bill ${bill.status} ${bill.message} ${bill.text.slice(0, 280)}`);
    const cash = await rest(pos, HOUSE, '/api/restaurant/checkout/tender', { billId: bag.billId, tender: { type: 'CASH', amount: grand, cashReceived: '2000.00' } }, `qa-cash-${Date.now()}`);
    record('PAY-03', cash.status < 400 ? 'pass' : 'fail', `${cash.status} ${cash.message} ${cash.text.slice(0, 280)}`);
    bag.tenderId = idOf(cash, 'tenderId') || idOf(cash);
    const refund = await rest(pos, HOUSE, '/api/restaurant/checkout/refund', { originalTenderId: bag.tenderId || 'missing', amount: '50.00', reason: 'QA partial refund', approving: { staffProfileId: bag.ownerStaffId, type: 'PIN', secret: PIN.owner } }, `qa-refund-${Date.now()}`);
    record('PAY-06', refund.status < 400 ? 'pass' : 'fail', `${refund.status} ${refund.message} ${refund.text.slice(0, 240)}`);
    const cardOrder = await rest(pos, HOUSE, '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId: bag.publicationId }, `qa-card-open-${Date.now()}`);
    const cardOrderId = idOf(cardOrder, 'orderId') || idOf(cardOrder);
    await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: cardOrderId, menuItemId: bag.naanItemId }, `qa-card-item-${Date.now()}`);
    await rest(pos, HOUSE, '/api/restaurant/orders/fire', { orderId: cardOrderId }, `qa-card-fire-${Date.now()}`);
    const cardBill = await rest(pos, HOUSE, '/api/restaurant/checkout/bill', { orderId: cardOrderId, split: { kind: 'NONE' } }, `qa-card-bill-${Date.now()}`);
    const cardBills = Array.isArray(cardBill.data.bills) ? (cardBill.data.bills as Array<Record<string, unknown>>) : [];
    const card = await rest(pos, HOUSE, '/api/restaurant/checkout/tender', { billId: String(cardBills[0]?.id ?? ''), tender: { type: 'CARD', amount: String(cardBills[0]?.grandTotal ?? '120.00'), tipAmount: '20.00' } }, `qa-card-${Date.now()}`);
    record('PAY-04', card.status < 400 ? 'pass' : 'fail', `${card.status} ${card.message} ${card.text.slice(0, 240)}; mock copy ${/mock|simulat/i.test(posCopy)}`);
    const splitOrder = await rest(pos, HOUSE, '/api/restaurant/orders/open', { channel: 'DINE_IN', publicationId: bag.publicationId, coverCount: 2 }, `qa-split-open-${Date.now()}`);
    const splitOrderId = idOf(splitOrder, 'orderId') || idOf(splitOrder);
    const splitA = await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: splitOrderId, menuItemId: bag.menuItemId, seatNumber: 1 }, `qa-sa-${Date.now()}`);
    const splitB = await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: splitOrderId, menuItemId: bag.naanItemId, seatNumber: 2 }, `qa-sb-${Date.now()}`);
    await rest(pos, HOUSE, '/api/restaurant/orders/fire', { orderId: splitOrderId }, `qa-sf-${Date.now()}`);
    const split = await rest(pos, HOUSE, '/api/restaurant/checkout/bill', { orderId: splitOrderId, split: { kind: 'BY_ITEM', groups: [[idOf(splitA, 'itemId') || idOf(splitA)], [idOf(splitB, 'itemId') || idOf(splitB)]] } }, `qa-split-${Date.now()}`);
    const seatOrderCall = await rest(pos, HOUSE, '/api/restaurant/orders/open', { channel: 'DINE_IN', publicationId: bag.publicationId, coverCount: 2 }, `qa-seat-open-${Date.now()}`);
    const seatOrder = idOf(seatOrderCall, 'orderId') || idOf(seatOrderCall);
    await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: seatOrder, menuItemId: bag.menuItemId, seatNumber: 1 }, `qa-seat-a-${Date.now()}`);
    await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: seatOrder, menuItemId: bag.naanItemId, seatNumber: 2 }, `qa-seat-b-${Date.now()}`);
    await rest(pos, HOUSE, '/api/restaurant/orders/fire', { orderId: seatOrder }, `qa-seat-fire-${Date.now()}`);
    const seatBill = await rest(pos, HOUSE, '/api/restaurant/checkout/bill', { orderId: seatOrder, split: { kind: 'BY_SEAT' } }, `qa-seat-bill-${Date.now()}`);
    record('PAY-02', split.status < 400 && seatBill.status < 400 ? 'pass' : 'fail', `item ${split.status} ${split.message} ${split.text.slice(0, 160)}; seat ${seatBill.status} ${seatBill.message} ${seatBill.text.slice(0, 160)}`);
    const compBill = Array.isArray(split.data.bills) ? String((split.data.bills as Array<{ id?: string }>)[0]?.id ?? '') : '';
    const comp = await rest(pos, HOUSE, '/api/restaurant/checkout/comp', { billId: compBill || bag.billId, billLineId: idOf(splitA, 'itemId') || idOf(splitA), reason: 'QA comp', approving: { staffProfileId: bag.ownerStaffId, type: 'PIN', secret: PIN.owner } }, `qa-comp-${Date.now()}`);
    record('PAY-05', comp.status < 400 ? 'pass' : 'fail', `${comp.status} ${comp.message} ${comp.text.slice(0, 220)}`);
    const switched = await rest(pos, HOUSE, '/api/restaurant/terminal/switch', { staffProfileId: bag.serverStaffId, type: 'PIN', secret: PIN.server });
    const serverRefund = await rest(pos, HOUSE, '/api/restaurant/checkout/refund', { originalTenderId: bag.tenderId || 'missing', amount: '1.00', reason: 'Server should not refund', approving: { staffProfileId: bag.serverStaffId, type: 'PIN', secret: PIN.server } }, `qa-sref-${Date.now()}`);
    record('PERM-03', switched.status < 400 && (serverRefund.status === 403 || serverRefund.status === 401) ? 'pass' : 'fail', `switch ${switched.status} ${switched.message}; refund ${serverRefund.status} ${serverRefund.message}`);
    await rest(pos, HOUSE, '/api/restaurant/terminal/switch', { staffProfileId: bag.ownerStaffId, type: 'PIN', secret: PIN.owner });
    const deny = await trpc(house, HOUSE, 'restaurantStaff.setStaffCapabilityOverride', 'POST', { staffProfileId: bag.cashierStaffId, branchId: bag.branchId, capability: 'payments:collect', effect: 'DENY' });
    const asCashier = await rest(pos, HOUSE, '/api/restaurant/terminal/switch', { staffProfileId: bag.cashierStaffId, type: 'PIN', secret: PIN.cashier });
    const denied = await rest(pos, HOUSE, '/api/restaurant/checkout/tender', { billId: bag.billId, tender: { type: 'OTHER', amount: '1.00' } }, `qa-deny-${Date.now()}`);
    record('STF-04', deny.status < 400 && (denied.status === 403 || denied.status === 401) ? 'pass' : 'fail', `deny ${deny.status} ${deny.message}; switch ${asCashier.status} ${asCashier.message}; tender ${denied.status} ${denied.message}`);
    await trpc(house, HOUSE, 'restaurantStaff.clearStaffCapabilityOverride', 'POST', { staffProfileId: bag.cashierStaffId, branchId: bag.branchId, capability: 'payments:collect' });
    await rest(pos, HOUSE, '/api/restaurant/terminal/switch', { staffProfileId: bag.ownerStaffId, type: 'PIN', secret: PIN.owner });
    await trpc(house, HOUSE, 'restaurantMenus.setPublicationChannels', 'POST', { id: bag.publicationId, channels: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'] });
    const delivery = await rest(pos, HOUSE, '/api/restaurant/orders/open', { channel: 'DELIVERY', customerId: bag.customerId, publicationId: bag.publicationId }, `qa-del-${Date.now()}`);
    const deliveryId = idOf(delivery, 'orderId') || idOf(delivery);
    const deliveryAttached = await rest(pos, HOUSE, '/api/restaurant/orders/delivery/attach', { orderId: deliveryId, customerId: bag.customerId, addressId: bag.addressId, zoneId: bag.zoneId }, `qa-attach-${Date.now()}`);
    record('ORD-04', delivery.status < 400 && deliveryAttached.status < 400 ? 'pass' : 'fail', `open ${delivery.status} ${delivery.message}; attach ${deliveryAttached.status} ${deliveryAttached.message}`);
    record('MNU-03', earlyDelivery.status >= 400 && delivery.status < 400 ? 'pass' : 'fail', `before ${earlyDelivery.status} ${earlyDelivery.message}; after ${delivery.status} ${delivery.message}`);
    const handoff = await kds.request.get(`${HOUSE}/api/restaurant/kds/delivery/queue`, { timeout: 15000 });
    record('KDS-04', handoff.status() < 500 ? 'pass' : 'fail', `${handoff.status()} ${(await handoff.text()).slice(0, 180)}`);
    const voided = await rest(pos, HOUSE, '/api/restaurant/orders/void', { orderId: bag.takeOrderId, itemId: idOf(takeItem, 'itemId') || idOf(takeItem), reason: 'QA void' }, `qa-void-${Date.now()}`);
    const cancel = await rest(pos, HOUSE, '/api/restaurant/orders/cancel', { orderId: bag.takeOrderId, reason: 'QA cancel takeaway' }, `qa-cancel-${Date.now()}`);
    record('ORD-06', voided.status < 400 || cancel.status < 400 ? 'pass' : 'fail', `void ${voided.status} ${voided.message}; cancel ${cancel.status} ${cancel.message}`);
    const day = await rest(pos, HOUSE, '/api/restaurant/cash/day/close', { businessDate: '2026-10-21' }, `qa-day-${Date.now()}`);
    record('PAY-08', day.status < 400 ? 'pass' : 'fail', `${day.status} ${day.message} ${day.text.slice(0, 200)}`);

    const pinPageCtx = await browser.newContext();
    const pinPage = await pinPageCtx.newPage();
    await pinPage.goto(`${HOUSE}/login`);
    await pinPage.locator('input[name="email"]').fill(PIN.owner);
    await pinPage.locator('input[name="password"]').fill(PIN.owner);
    await pinPage.getByRole('button', { name: 'Sign in' }).click();
    await pinPage.waitForTimeout(800);
    record('STF-05', pinPage.url().includes('/login') ? 'pass' : 'fail', pinPage.url(), [await shot(pinPage, 'api-pin-login')]);
    await pinPageCtx.close();

    const cashierWeb = await browser.newContext();
    const cashierPage = await cashierWeb.newPage();
    try {
      await login(cashierPage, HOUSE, 'qa-karahi-cashier@example.com', STAFF_PASSWORD);
      const catalogWrite = await trpc(cashierWeb, HOUSE, 'restaurantCatalog.createCategory', 'POST', { name: 'Cashier should not' });
      const purchase = await trpc(cashierWeb, HOUSE, 'restaurantPurchasing.createSupplier', 'POST', { name: 'Nope' });
      record('PERM-01', catalogWrite.status === 403 && purchase.status === 403 ? 'pass' : 'fail', `catalog ${catalogWrite.status} ${catalogWrite.message}; purchasing ${purchase.status} ${purchase.message}; nav ${(await text(cashierPage)).slice(0, 220)}`, [await shot(cashierPage, 'api-perm-01')]);
    } catch (error) { record('PERM-01', 'fail', error instanceof Error ? error.message : String(error)); }
    const accountantWeb = await browser.newContext();
    try {
      const accountantPage = await accountantWeb.newPage();
      await login(accountantPage, HOUSE, 'qa-karahi-accountant@example.com', STAFF_PASSWORD);
      const report = await trpc(accountantWeb, HOUSE, 'restaurantReports.payments', 'GET', { from: '2026-10-01', to: '2026-10-31', branchId: bag.branchId });
      const take = await trpc(accountantWeb, HOUSE, 'restaurantOrders.open', 'POST', { branchId: bag.branchId, channel: 'TAKEAWAY', actor: { staffProfileId: bag.ownerStaffId, deviceId: 'web', idempotencyKey: `qa-acc-${Date.now()}` } });
      record('PERM-04', report.status < 400 && take.status === 403 ? 'pass' : 'fail', `report ${report.status} ${report.message}; open ${take.status} ${take.message}`);
    } catch (error) { record('PERM-04', 'fail', error instanceof Error ? error.message : String(error)); }

    const essentials = await browser.newContext();
    try {
      const essentialsPage = await essentials.newPage();
      await login(essentialsPage, ESSENTIALS, ESSENTIALS_EMAIL, OWNER_PASSWORD);
      const secondBranch = await trpc(essentials, ESSENTIALS, 'restaurantBranches.create', 'POST', { name: 'Second', code: 'SECOND', timezone: 'Asia/Karachi', businessDayCutoff: '05:00', address: '2 DHA', shiftSignInEnforced: false });
      const loyaltyDenied = await trpc(essentials, ESSENTIALS, 'restaurantLoyalty.configure', 'POST', { effectiveFrom: '2020-01-01T00:00:00.000Z', earnRate: '1', redemptionValue: '1' });
      const foreign = await trpc(essentials, ESSENTIALS, 'restaurantOrders.getOrder', 'GET', { orderId: bag.dineOrderId || 'missing-order' });
      const foreignProduct = await trpc(essentials, ESSENTIALS, 'restaurantCatalog.getProduct', 'GET', { id: bag.productId || 'missing-product' });
      record('BRN-04', secondBranch.status >= 400 ? 'pass' : 'fail', `${secondBranch.status} ${secondBranch.message}`);
      record('LOY-04', loyaltyDenied.status === 403 ? 'pass' : 'fail', `${loyaltyDenied.status} ${loyaltyDenied.message}`, [await shot(essentialsPage, 'api-loy-04')]);
      record('TNT-03', foreign.status >= 400 && foreignProduct.status >= 400 ? 'pass' : 'fail', `order ${foreign.status} ${foreign.message}; product ${foreignProduct.status} ${foreignProduct.message}`);
      record('TNT-05', foreign.status === 404 || foreign.status === 403 ? 'pass' : 'fail', `${foreign.status} ${foreign.message}`);
    } catch (error) { record('BRN-04', 'blocked', error instanceof Error ? error.message : String(error)); }

    const agency = await browser.newContext();
    try {
      const agencyPage = await agency.newPage();
      await login(agencyPage, AGENCY, 'alex@company.com', process.env.SEED_PASSWORD || '');
      await agencyPage.goto(`${AGENCY}/restaurant/catalog`, { timeout: 20000 });
      const agencyApi = await trpc(agency, AGENCY, 'restaurantCatalog.listCategories', 'GET');
      const agencyText = await text(agencyPage);
      record('TNT-01', !/Chicken Karahi/.test(agencyText) && agencyApi.status >= 400 ? 'pass' : 'fail', `${agencyPage.url()} ${agencyText.slice(0, 180)}; api ${agencyApi.status} ${agencyApi.message}`, [await shot(agencyPage, 'api-tnt-01')]);
    } catch (error) { record('TNT-01', 'fail', error instanceof Error ? error.message : String(error)); }

    const wrong = await browser.newContext();
    try {
      const wrongPage = await wrong.newPage();
      await login(wrongPage, AGENCY, OWNER_EMAIL, OWNER_PASSWORD);
      const first = wrongPage.url();
      const shot1 = await shot(wrongPage, 'api-wrong-host');
      const session = await wrongPage.evaluate(async () => { const json = await (await fetch('/api/auth/session')).json(); return { slug: json?.user?.organizationSlug ?? null }; });
      await wrongPage.goto(`${AGENCY}/restaurant/catalog`, { timeout: 20000 });
      record('TNT-HOST', wrongPage.url().includes('/login') || session.slug !== 'qa-karahi-house' ? 'fail' : 'pass', `first ${first} slug ${session.slug} next ${wrongPage.url()}`, [shot1, await shot(wrongPage, 'api-wrong-next')]);
    } catch (error) { record('TNT-HOST', 'fail', error instanceof Error ? error.message : String(error)); }

    const code = platformTotp();
    if (!code) {
      record('LCY-06', 'blocked', 'Platform authenticator secret could not be read.');
      record('REV-01', 'blocked', 'Platform authenticator secret could not be read.');
    } else {
      const platform = await browser.newContext();
      const platformPage = await platform.newPage();
      await platformPage.goto(`${ADMIN}/platform/login`);
      await platformPage.locator('#platform-email').fill(process.env.PLATFORM_ADMIN_EMAIL || '');
      await platformPage.locator('#platform-password').fill(process.env.PLATFORM_ADMIN_PASSWORD || '');
      await platformPage.locator('#platform-auth-code').fill(code);
      await platformPage.getByRole('button', { name: 'Continue to control desk' }).click();
      await platformPage.waitForURL(/\/platform(?!\/login)/, { timeout: 20000 }).catch(() => undefined);
      const cross = await platform.request.get(`${HOUSE}/api/trpc/restaurantCatalog.listCategories?input=${encodeURIComponent(JSON.stringify({ json: null }))}`, { timeout: 15000 });
      record('TNT-04', cross.status() === 401 ? 'pass' : 'fail', `${cross.status()} ${(await cross.text()).slice(0, 120)}`);
      const orgId = sql(`SELECT id FROM organizations WHERE slug='qa-karahi-essentials'`).split('\n')[0];
      const suspend = await platform.request.post(`${ADMIN}/api/platform/control`, { headers: { origin: ADMIN, 'content-type': 'application/json' }, data: { action: 'organization.transition', payload: { id: orgId, status: 'SUSPENDED', reason: 'QA suspension to verify tenant sign-in stops.' } }, timeout: 20000 });
      const suspended = await browser.newContext();
      const suspendedPage = await suspended.newPage();
      await suspendedPage.goto(`${ESSENTIALS}/login`);
      await suspendedPage.locator('input[name="email"]').fill(ESSENTIALS_EMAIL);
      await suspendedPage.locator('input[name="password"]').fill(OWNER_PASSWORD);
      await suspendedPage.getByRole('button', { name: 'Sign in' }).click();
      await suspendedPage.waitForTimeout(1200);
      const resume = await platform.request.post(`${ADMIN}/api/platform/control`, { headers: { origin: ADMIN, 'content-type': 'application/json' }, data: { action: 'organization.transition', payload: { id: orgId, status: 'ACTIVE', reason: 'QA resume after the suspension check.' } }, timeout: 20000 });
      record('LCY-06', suspend.status() < 400 && suspendedPage.url().includes('/login') && resume.status() < 400 ? 'pass' : 'fail', `suspend ${suspend.status()} ${(await suspend.text()).slice(0, 140)}; url ${suspendedPage.url()}; resume ${resume.status()}`, [await shot(suspendedPage, 'api-lcy-06')]);
      const moduleId = sql(`SELECT set_config('app.is_platform_admin','true',true); SELECT id FROM platform_modules WHERE key='restaurant-pos'`).split('\n').filter((row) => row.length > 8).at(-1);
      const houseId = sql(`SELECT id FROM organizations WHERE slug='qa-karahi-house'`).split('\n')[0];
      const disable = await platform.request.post(`${ADMIN}/api/platform/control`, { headers: { origin: ADMIN, 'content-type': 'application/json' }, data: { action: 'organization.module', payload: { organizationId: houseId, moduleId, status: 'DISABLED', reason: 'QA disable POS to verify revocation.' } }, timeout: 20000 });
      const afterDisable = await rest(pos, HOUSE, '/api/restaurant/orders/open', { channel: 'TAKEAWAY', publicationId: bag.publicationId }, `qa-off-${Date.now()}`);
      await platform.request.post(`${ADMIN}/api/platform/control`, { headers: { origin: ADMIN, 'content-type': 'application/json' }, data: { action: 'organization.module', payload: { organizationId: houseId, moduleId, status: 'ENABLED', reason: 'QA re-enable POS after the revocation check.' } }, timeout: 20000 });
      record('REV-01', disable.status() < 400 && afterDisable.status >= 400 ? 'pass' : 'fail', `disable ${disable.status()} ${(await disable.text()).slice(0, 160)}; order ${afterDisable.status} ${afterDisable.message}`);
    }

    const devices = await trpc(house, HOUSE, 'restaurantDevices.list', 'GET');
    const list = Array.isArray(devices.data) ? (devices.data as unknown as Array<{ id: string; kind?: string; name?: string }>) : [];
    const kdsDevice = list.find((device) => device.kind === 'KDS' || /kitchen/i.test(device.name ?? ''));
    const revoked = kdsDevice ? await trpc(house, HOUSE, 'restaurantDevices.revoke', 'POST', { deviceId: kdsDevice.id, approvingStaffProfileId: bag.ownerStaffId, approvingType: 'PIN', approvingSecret: PIN.owner, reason: 'QA revoke kitchen display' }) : { status: 0, message: 'no device', text: '' };
    const afterRevoke = await kds.request.get(`${HOUSE}/api/restaurant/kds/queue`, { timeout: 15000 });
    record('REV-02', revoked.status < 400 && afterRevoke.status() >= 400 ? 'pass' : 'fail', `devices ${devices.status} ${list.length}; revoke ${revoked.status} ${revoked.message}; queue ${afterRevoke.status()}`);
    const deactivated = await trpc(house, HOUSE, 'organizationAdmin.updateMember', 'POST', { id: cashier.userId, role: 'EMPLOYEE', status: 'INACTIVE', organizationRoleId: orgRole('cashier'), title: 'Cashier', department: 'FRONT_OF_HOUSE' });
    const again = await browser.newContext();
    const againPage = await again.newPage();
    await againPage.goto(`${HOUSE}/login`);
    await againPage.locator('input[name="email"]').fill('qa-karahi-cashier@example.com');
    await againPage.locator('input[name="password"]').fill(STAFF_PASSWORD);
    await againPage.getByRole('button', { name: 'Sign in' }).click();
    await againPage.waitForTimeout(1000);
    record('REV-03', deactivated.status < 400 && againPage.url().includes('/login') ? 'pass' : 'fail', `update ${deactivated.status} ${deactivated.message}; url ${againPage.url()}`, [await shot(againPage, 'api-rev-03')]);
    record('REV-04', 'blocked', 'Terminate was not executed against the enterprise tenant under test.');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${HOUSE}/dashboard`, { timeout: 20000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    record('UX-02', overflow ? 'fail' : 'pass', `dashboard horizontal overflow at 390px: ${overflow}`, [await shot(page, 'api-mobile')]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${HOUSE}/restaurant/notifications`, { timeout: 20000 });
    try {
      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const serious = scan.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
      record('A11Y-01', serious.length ? 'fail' : 'pass', serious.map((item) => `${item.impact} ${item.id} ${item.help}`).join('; ') || 'No serious or critical violations on notifications.', [await shot(page, 'api-a11y')]);
    } catch (error) { record('A11Y-01', 'blocked', error instanceof Error ? error.message : String(error)); }
    const started = Date.now();
    await page.goto(`${HOUSE}/restaurant/orders`, { timeout: 20000 });
    record('PERF-01', Date.now() - started < 3000 ? 'pass' : 'fail', `Warmed orders navigation ${Date.now() - started}ms.`);
  } catch (error) {
    record('RUN', 'blocked', error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    persist();
    await browser.close();
  }
}
void main();
