/**
 * WHA-136 / M8 correction E — a failed terminal money mutation must be ROLLED BACK
 * before it is mapped to an HTTP status.
 *
 * `withTerminalAuth` owns the request's PostgreSQL transaction and a nested
 * `$transaction` on the scoped client opens no savepoint, so a route factory that caught
 * its domain error inside that callback and returned an error `Response` committed every
 * write the failed command had already made. WHA-132 turned that into money corruption:
 * `compLine` appends a loyalty release and THEN validates the co-authorization, and
 * `cutBills` releases + voids the old bills and THEN plans the split.
 *
 * These checks drive `withTerminalAuth` + `moneyMutationRoute` over real `Request`
 * objects: the production bill route and a test-only adapter for the retained comp
 * domain. The public MVP comp endpoint is tested separately as a side-effect-free denial:
 *
 *   - a comp refused at its co-authorization leaves the loyalty release, the bill, the
 *     line, the ledger, the co-authorization table and the money idempotency key exactly
 *     as they were, and answers the unchanged 400;
 *   - a re-cut refused at split planning leaves the old bill OPEN with its discount, the
 *     ledger untouched, no co-authorization and no new bills;
 *   - the retry of the SAME idempotency key then succeeds, exactly once — proving the
 *     failed attempt burnt no key (before the fix the committed key made the retry replay
 *     a command that never happened);
 *   - the request-wide rollback is witnessed on a row the FAILED COMMAND never touched:
 *     the device check-in written by the transport itself is gone too;
 *   - a route that RETURNS an error response still commits, deliberately — the durable
 *     failed-attempt counter behind an invalid approver credential is brute-force
 *     evidence and must survive its own 401 (only a THROW rolls back);
 *   - the boundary itself is regressed with a synthetic handler, so any FUTURE factory
 *     built on `withTerminalAuth` inherits the same ordering.
 *
 * Requires TEST_DATABASE_URL: a migrated throwaway database reached through an
 * unprivileged (NOSUPERUSER / NOBYPASSRLS) role, never DATABASE_URL. `beforeAll` asserts
 * that role, so the tenant-scoped assertions cannot pass by bypassing row level security.
 * Every read filters by a per-run-unique id.
 */
import { createHash, randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';

import { beginMoneyIdempotent, recordMoneyResult } from './drawer-sessions';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

/** Assert a money value by Decimal VALUE (never a float, never an epsilon). */
const eqMoney = (actual: unknown, expected: string) =>
  expect(
    new Prisma.Decimal(String(actual)).equals(expected),
    `${String(actual)} ≠ ${expected}`
  ).toBe(true);

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha136_${suffix}`;
const PIN = '515151';
const TODAY = new Date().toISOString().slice(0, 10);
const businessDate = new Date(`${TODAY}T00:00:00.000Z`);

type RouteModule = {
  GET?: (r: Request) => Promise<Response>;
  POST?: (r: Request) => Promise<Response>;
};

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  enrollDevice: (typeof import('./devices'))['enrollDevice'];
  hashOperatorCredential: (typeof import('./operator-credentials'))['hashOperatorCredential'];
  loyalty: typeof import('./loyalty');
  bills: typeof import('./bills');
  terminalAuth: typeof import('./terminal-auth');
  routes: {
    bill: RouteModule;
    comp: RouteModule;
    retainedComp: RouteModule;
    establish: RouteModule;
    unlock: RouteModule;
  };
};

let deps: Deps;

const ctx = {
  branch: `branch_${suffix}`,
  product: `product_${suffix}`,
  roleAll: `role_all_${suffix}`,
  operator: `staff_op_${suffix}`,
  manager: `staff_mgr_${suffix}`,
  /** A second approver, sacrificed to the invalid-credential check so its durable
   * failed-attempt counter cannot perturb any other case. */
  approver2: `staff_ap2_${suffix}`,
  deviceId: '',
  deviceSecret: '',
  session: '',
};

/** Drive a production route module over a real Request, exactly as HTTP would. */
async function call(
  route: RouteModule,
  opts: { key?: string; body?: unknown; session?: string; secret?: string }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  headers.authorization = `Bearer ${opts.secret ?? ctx.deviceSecret}`;
  const session = opts.session ?? ctx.session;
  if (session) headers['x-terminal-session'] = session;
  if (opts.key) headers['idempotency-key'] = opts.key;
  const request = new Request('https://tenant.test/api/restaurant/probe', {
    method: 'POST',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await route.POST!(request);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

let orderSeq = 0;

/** A billable (SERVED) order for `customerId`, one item per price. */
async function seedOrder(customerId: string | null, prices: string[]) {
  orderSeq += 1;
  const orderNumber = orderSeq;
  return deps.withTenantDb(orgId, async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId: ctx.branch,
        orderNumber,
        businessDate,
        status: 'SERVED',
        channel: 'DINE_IN',
        staffProfileId: ctx.operator,
        deviceId: ctx.deviceId,
        customerId,
      },
      select: { id: true },
    });
    for (const unitPrice of prices) {
      await tx.restaurantOrderItem.create({
        data: {
          orderId: order.id,
          productId: ctx.product,
          name: 'Widget',
          unitPrice,
          quantity: 1,
          status: 'SERVED',
        },
      });
    }
    return order.id;
  });
}

const readBill = (billId: string) =>
  deps.withTenantDb(orgId, (tx) =>
    tx.restaurantBill.findUniqueOrThrow({
      where: { id: billId },
      select: {
        status: true,
        subtotal: true,
        compTotal: true,
        discountTotal: true,
        grandTotal: true,
      },
    })
  );

const readLines = (billId: string) =>
  deps.withTenantDb(orgId, (tx) =>
    tx.restaurantBillLine.findMany({
      where: { billId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, lineSubtotal: true, compAmount: true, compReason: true },
    })
  );

/** The ledger for one account, in append order — the whole of it, so a stray entry shows. */
const ledger = (accountId: string) =>
  deps.withTenantDb(orgId, (tx) =>
    tx.loyaltyPointsEntry.findMany({
      where: { accountId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { kind: true, points: true, billId: true, reversesEntryId: true },
    })
  );

/** Every row a failed money command could have left behind, tenant-wide. */
async function tenantCounts() {
  return deps.withTenantDb(orgId, async (tx) => ({
    bills: await tx.restaurantBill.count(),
    billLines: await tx.restaurantBillLine.count(),
    ledger: await tx.loyaltyPointsEntry.count(),
    coAuths: await tx.restaurantCoAuthorization.count(),
    idempotencyKeys: await tx.restaurantMoneyIdempotencyKey.count(),
  }));
}

const idempotencyKeyRow = (key: string) =>
  deps.withTenantDb(orgId, (tx) =>
    tx.restaurantMoneyIdempotencyKey.findUnique({
      where: { deviceId_key: { deviceId: ctx.deviceId, key } },
      select: { key: true, commandType: true, resultRef: true },
    })
  );

const deviceLastSeen = async (): Promise<number | null> => {
  const row = await deps.withTenantDb(orgId, (tx) =>
    tx.restaurantRegisteredDevice.findUniqueOrThrow({
      where: { id: ctx.deviceId },
      select: { lastSeenAt: true },
    })
  );
  return row.lastSeenAt === null ? null : row.lastSeenAt.getTime();
};

const failedAttempts = (staffProfileId: string) =>
  deps.withTenantDb(orgId, async (tx) => {
    const row = await tx.restaurantOperatorCredential.findFirstOrThrow({
      where: { staffProfileId },
      select: { failedAttempts: true },
    });
    return row.failedAttempts;
  });

/** A guest with a funded loyalty account. */
async function seedGuest(label: string, points: number) {
  const customerId = `cust_${label}_${suffix}`;
  await deps.withTenantDb(orgId, (tx) =>
    tx.restaurantCustomer.create({ data: { id: customerId, displayName: label } })
  );
  const db = deps.createTenantDb(orgId);
  const account = await deps.loyalty.enrollLoyaltyAccount(db, {
    customerId,
    activeCustomersMax: 50,
  });
  await deps.loyalty.adjustLoyaltyPoints(db, {
    accountId: account.id,
    points,
    actorId: ctx.operator,
    reason: 'opening balance for the rollback battery',
    idempotencyKey: `seed:${label}:${suffix}`,
  });
  return { customerId, accountId: account.id };
}

const uniqueKey = (label: string) => `${label}-${suffix}-${randomBytes(3).toString('hex')}`;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, credentials, loyalty, bills, terminalAuth, ...routeMods] =
    await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./devices'),
      import('./operator-credentials'),
      import('./loyalty'),
      import('./bills'),
      import('./terminal-auth'),
      import('@/app/api/restaurant/checkout/bill/route'),
      import('@/app/api/restaurant/checkout/comp/route'),
      import('@/app/api/restaurant/terminal/establish/route'),
      import('@/app/api/restaurant/terminal/unlock/route'),
      import('@/lib/test-support/retained-comp-route'),
    ]);
  const [bill, comp, establish, unlock, retainedComp] = routeMods as RouteModule[];

  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    createTenantDb: scopedDb.createTenantDb,
    enrollDevice: devices.enrollDevice,
    hashOperatorCredential: credentials.hashOperatorCredential,
    loyalty,
    bills,
    terminalAuth,
    routes: {
      bill: bill!,
      comp: comp!,
      retainedComp: retainedComp!,
      establish: establish!,
      unlock: unlock!,
    },
  };

  // The tenant-scoped assertions below are only meaningful under enforced row level
  // security; refuse a privileged connection rather than pass vacuously.
  await assertRlsEnforcingRole(deps.withPlatformDb);

  await deps.withPlatformDb(async (tx) => {
    await tx.organization.create({
      data: {
        id: orgId,
        slug: `wha136-${suffix}`,
        legalName: 'WHA136 Rollback Co',
        displayName: 'WHA136 Rollback',
        status: 'ACTIVE',
        // DEV-961: these approvals use PINs, which apply while the authenticator is off.
        requireApprovalAuthenticator: false,
      },
    });
    await seedDepartments(tx, [orgId], ['LEADERSHIP']);
    const posModule = await ensurePlatformModule(tx, 'restaurant-pos', {
      name: 'POS',
      category: 'Operations',
    });
    await tx.organizationModule.create({
      data: { organizationId: orgId, moduleId: posModule.id },
    });
  });

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({ data: { id: ctx.branch, name: 'Rollback' } });
    await tx.restaurantProduct.create({ data: { id: ctx.product, name: 'Widget' } });
    await tx.organizationRole.create({
      data: {
        id: ctx.roleAll,
        key: `all_${suffix}`,
        name: 'Money Full',
        permissions: { create: [{ capability: '*', effect: 'ALLOW' }] },
      },
    });
    for (const [staffId, tag] of [
      [ctx.operator, 'op'],
      [ctx.manager, 'mgr'],
      [ctx.approver2, 'ap2'],
    ] as const) {
      const userId = `user_${tag}_${suffix}`;
      await tx.user.create({
        data: {
          id: userId,
          name: `User ${tag}`,
          email: `${tag}_${suffix}@test.local`,
          department: 'LEADERSHIP',
          title: 'Operator',
          organizationRoleId: ctx.roleAll,
        },
      });
      await tx.restaurantStaffProfile.create({
        data: {
          id: staffId,
          displayName: `Staff ${tag}`,
          primaryBranchId: ctx.branch,
          status: 'ACTIVE',
          userId,
        },
      });
      await tx.restaurantOperatorCredential.create({
        data: {
          staffProfileId: staffId,
          type: 'PIN',
          credentialHash: await deps.hashOperatorCredential('PIN', PIN),
        },
      });
    }
  });

  // One point = one currency unit, so every released cent is a whole point.
  await deps.loyalty.configureLoyaltyProgram(deps.createTenantDb(orgId), {
    effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    earnRate: '0',
    redemptionValue: '1.00',
  });

  const enrolled = await deps.withTenantDb(orgId, (tx) =>
    deps.enrollDevice(tx, { branchId: ctx.branch, name: 'pos-rollback' })
  );
  ctx.deviceId = enrolled.device.id;
  ctx.deviceSecret = enrolled.secret;

  const established = await call(deps.routes.establish, { session: '' });
  expect(established.status).toBe(201);
  ctx.session = established.json.sessionToken as string;
  const unlocked = await call(deps.routes.unlock, {
    body: { staffProfileId: ctx.operator, type: 'PIN', secret: PIN },
  });
  expect(unlocked.status).toBe(200);
});

describeIfDatabase('WHA-136 terminal money mutations roll back before HTTP mapping', () => {
  /** A redeemed, open bill: subtotal 20.00, discount 15.00, grandTotal 5.00. Comping
   * either 10.00 line therefore needs a 5.00 release out of the redemption. */
  async function seedRedeemedBill(label: string) {
    const guest = await seedGuest(label, 1000);
    const orderId = await seedOrder(guest.customerId, ['10.00', '10.00']);
    const cut = await call(deps.routes.bill, {
      key: uniqueKey(`cut-${label}`),
      body: { orderId, split: { kind: 'NONE' } },
    });
    expect(cut.status).toBe(200);
    const billId = (cut.json.billIds as string[])[0]!;
    const redeemed = await deps.loyalty.redeemLoyaltyPoints(deps.createTenantDb(orgId), {
      accountId: guest.accountId,
      billId,
      points: 15,
      actorId: ctx.operator,
      idempotencyKey: `redeem:${label}:${suffix}`,
    });
    eqMoney(redeemed.value, '15.00');
    const bill = await readBill(billId);
    eqMoney(bill.discountTotal, '15.00');
    eqMoney(bill.grandTotal, '5.00');
    return { ...guest, orderId, billId };
  }

  describe('public MVP comp denial', () => {
    it.each(['self approval', 'manager approval', 'invalid PIN'])(
      'preserves a redeemed bill and all persistence with %s, including on retry',
      async (approval) => {
        const seeded = await seedRedeemedBill(`mvp-${approval.replaceAll(' ', '-')}`);
        const snapshot = async () => ({
          bill: await readBill(seeded.billId),
          lines: await readLines(seeded.billId),
          ledger: await ledger(seeded.accountId),
          counts: await tenantCounts(),
          balance: await deps.loyalty.loyaltyBalance(deps.createTenantDb(orgId), seeded.accountId),
          attempts: await failedAttempts(ctx.approver2),
          lastSeen: await deviceLastSeen(),
        });
        const before = await snapshot();
        const key = uniqueKey('mvp-comp');
        const body = {
          billId: seeded.billId,
          billLineId: before.lines[0]!.id,
          reason: 'kitchen error',
          approving: {
            staffProfileId:
              approval === 'self approval'
                ? ctx.operator
                : approval === 'invalid PIN'
                  ? ctx.approver2
                  : ctx.manager,
            type: 'PIN',
            secret: approval === 'invalid PIN' ? '999999' : PIN,
          },
        };

        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(await call(deps.routes.comp, { key, body })).toEqual({
            status: 403,
            json: { error: 'Complimentary items are not available in this version.' },
          });
          expect(await snapshot()).toEqual(before);
          expect(await idempotencyKeyRow(key)).toBeNull();
        }
      }
    );
  });

  describe('retained comp domain refused after a would-be loyalty release', () => {
    it('commits nothing — bill, line, ledger, co-authorization and idempotency key are untouched', async () => {
      const seeded = await seedRedeemedBill('comp');
      const lines = await readLines(seeded.billId);
      const before = {
        bill: await readBill(seeded.billId),
        ledger: await ledger(seeded.accountId),
        counts: await tenantCounts(),
        balance: await deps.loyalty.loyaltyBalance(deps.createTenantDb(orgId), seeded.accountId),
        lastSeen: await deviceLastSeen(),
      };
      expect(before.balance).toBe(985);

      // The acting operator presents THEMSELVES as the approving manager. The credential
      // check passes (their own PIN, and they hold `coauth:approve`), so the command runs:
      // it releases 5.00 of redemption first and only then refuses the self-approval.
      const key = uniqueKey('comp-selfapprove');
      const refused = await call(deps.routes.retainedComp, {
        key,
        body: {
          billId: seeded.billId,
          billLineId: lines[0]!.id,
          reason: 'kitchen error',
          approving: { staffProfileId: ctx.operator, type: 'PIN', secret: PIN },
        },
      });
      expect(refused.status).toBe(400);
      expect(String(refused.json.error)).toMatch(/second identity/);

      const after = await readBill(seeded.billId);
      eqMoney(after.discountTotal, '15.00');
      eqMoney(after.grandTotal, '5.00');
      eqMoney(after.compTotal, '0.00');
      expect(after.status).toBe('OPEN');
      eqMoney(before.bill.grandTotal, String(after.grandTotal));

      const afterLines = await readLines(seeded.billId);
      eqMoney(afterLines[0]!.compAmount, '0.00');
      expect(afterLines[0]!.compReason).toBeNull();

      // The release never happened: no ADJUSTMENT entry, balance unmoved.
      expect(await ledger(seeded.accountId)).toEqual(before.ledger);
      expect(await deps.loyalty.loyaltyBalance(deps.createTenantDb(orgId), seeded.accountId)).toBe(
        985
      );
      expect(await tenantCounts()).toEqual(before.counts);

      // The key was not burnt, so the retry is a first run and not a replay.
      expect(await idempotencyKeyRow(key)).toBeNull();

      // Witness the rollback on a row the FAILED COMMAND never touched: the transport's
      // own device check-in is inside the same transaction, so it is gone too.
      expect(await deviceLastSeen()).toBe(before.lastSeen);
    });

    it('lets a corrected retry of the SAME idempotency key succeed exactly once', async () => {
      const seeded = await seedRedeemedBill('retry');
      const lines = await readLines(seeded.billId);
      const key = uniqueKey('comp-retry');

      const refused = await call(deps.routes.retainedComp, {
        key,
        body: {
          billId: seeded.billId,
          billLineId: lines[0]!.id,
          reason: 'kitchen error',
          approving: { staffProfileId: ctx.operator, type: 'PIN', secret: PIN },
        },
      });
      expect(refused.status).toBe(400);

      // Same key, now with a genuine second identity.
      const accepted = await call(deps.routes.retainedComp, {
        key,
        body: {
          billId: seeded.billId,
          billLineId: lines[0]!.id,
          reason: 'kitchen error',
          approving: { staffProfileId: ctx.manager, type: 'PIN', secret: PIN },
        },
      });
      expect(accepted.status).toBe(200);
      expect(accepted.json.replayed).toBe(false);
      eqMoney(accepted.json.releasedDiscount, '5.00');

      const bill = await readBill(seeded.billId);
      eqMoney(bill.compTotal, '10.00');
      eqMoney(bill.discountTotal, '10.00');
      eqMoney(bill.grandTotal, '0.00');
      // subtotal = grandTotal + compTotal + discountTotal stays exact.
      eqMoney(bill.subtotal, '20.00');
      expect(await deps.loyalty.loyaltyBalance(deps.createTenantDb(orgId), seeded.accountId)).toBe(
        990
      );

      // Exactly once: the comp released 5.00 one time, not twice.
      const releases = (await ledger(seeded.accountId)).filter(
        (entry) => entry.kind === 'ADJUSTMENT' && entry.billId === seeded.billId
      );
      expect(releases.map((entry) => entry.points)).toEqual([5]);
      expect(await idempotencyKeyRow(key)).toMatchObject({ commandType: 'bill.comp' });

      // And a third call on that key is now a genuine replay that writes nothing.
      const counts = await tenantCounts();
      const replay = await call(deps.routes.retainedComp, {
        key,
        body: {
          billId: seeded.billId,
          billLineId: lines[0]!.id,
          reason: 'kitchen error',
          approving: { staffProfileId: ctx.manager, type: 'PIN', secret: PIN },
        },
      });
      expect(replay.status).toBe(200);
      expect(replay.json.replayed).toBe(true);
      eqMoney(replay.json.releasedDiscount, '5.00');
      expect(await tenantCounts()).toEqual(counts);
    });
  });

  describe('re-cut refused after a would-be release and void', () => {
    it('leaves the old bill OPEN with its discount, and writes no ledger, co-authorization or key', async () => {
      const seeded = await seedRedeemedBill('recut');
      const before = {
        ledger: await ledger(seeded.accountId),
        counts: await tenantCounts(),
        lastSeen: await deviceLastSeen(),
      };

      // A valid co-authorization, so the re-cut passes the guard, releases the 15.00
      // redemption and VOIDS the live bill — and only then fails planning on an item id
      // that is not on this order.
      const key = uniqueKey('recut-bad-split');
      const refused = await call(deps.routes.bill, {
        key,
        body: {
          orderId: seeded.orderId,
          split: { kind: 'BY_ITEM', groups: [[`not_an_item_${suffix}`]] },
          recut: {
            reason: 'guest wants separate bills',
            approving: { staffProfileId: ctx.manager, type: 'PIN', secret: PIN },
          },
        },
      });
      expect(refused.status).toBe(400);
      expect(String(refused.json.error)).toMatch(/not a billable/);

      const bill = await readBill(seeded.billId);
      expect(bill.status).toBe('OPEN');
      eqMoney(bill.discountTotal, '15.00');
      eqMoney(bill.grandTotal, '5.00');

      expect(await ledger(seeded.accountId)).toEqual(before.ledger);
      expect(await deps.loyalty.loyaltyBalance(deps.createTenantDb(orgId), seeded.accountId)).toBe(
        985
      );
      // No void record, no fresh bill, no co-authorization, no burnt key.
      expect(await tenantCounts()).toEqual(before.counts);
      expect(await idempotencyKeyRow(key)).toBeNull();
      expect(await deviceLastSeen()).toBe(before.lastSeen);

      // The order still has exactly its one live bill.
      const live = await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantBill.findMany({
          where: { orderId: seeded.orderId, status: { not: 'VOID' } },
          select: { id: true },
        })
      );
      expect(live.map((row) => row.id)).toEqual([seeded.billId]);
    });

    it('lets the corrected re-cut succeed on the same key and hand the points back once', async () => {
      const seeded = await seedRedeemedBill('recut-ok');
      const key = uniqueKey('recut-retry');
      const body = (groups: string[][]) => ({
        orderId: seeded.orderId,
        split: { kind: 'BY_ITEM', groups },
        recut: {
          reason: 'guest wants separate bills',
          approving: { staffProfileId: ctx.manager, type: 'PIN', secret: PIN },
        },
      });

      const refused = await call(deps.routes.bill, {
        key,
        body: body([[`not_an_item_${suffix}`]]),
      });
      expect(refused.status).toBe(400);

      const items = await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantOrderItem.findMany({
          where: { orderId: seeded.orderId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      );
      const accepted = await call(deps.routes.bill, {
        key,
        body: body([[items[0]!.id], [items[1]!.id]]),
      });
      expect(accepted.status).toBe(200);
      expect(accepted.json.replayed).toBe(false);
      expect((accepted.json.billIds as string[]).length).toBe(2);

      // The old bill is now the VOID record, with the discount rolled off it, and the
      // guest's 15 points are back — released exactly once.
      const voided = await readBill(seeded.billId);
      expect(voided.status).toBe('VOID');
      eqMoney(voided.discountTotal, '0.00');
      expect(await deps.loyalty.loyaltyBalance(deps.createTenantDb(orgId), seeded.accountId)).toBe(
        1000
      );
      const releases = (await ledger(seeded.accountId)).filter(
        (entry) => entry.kind === 'ADJUSTMENT' && entry.billId === seeded.billId
      );
      expect(releases.map((entry) => entry.points)).toEqual([15]);
    });
  });

  describe('a RETURNED error response still commits (only a throw rolls back)', () => {
    it('keeps the durable failed-attempt counter and the device check-in behind an invalid approver credential', async () => {
      const seeded = await seedRedeemedBill('badcred');
      const lines = await readLines(seeded.billId);
      const before = {
        attempts: await failedAttempts(ctx.approver2),
        lastSeen: await deviceLastSeen(),
        counts: await tenantCounts(),
      };
      expect(before.attempts).toBe(0);

      const key = uniqueKey('comp-badcred');
      const refused = await call(deps.routes.retainedComp, {
        key,
        body: {
          billId: seeded.billId,
          billLineId: lines[0]!.id,
          reason: 'kitchen error',
          approving: { staffProfileId: ctx.approver2, type: 'PIN', secret: '999999' },
        },
      });
      expect(refused.status).toBe(401);

      // The brute-force evidence is the whole point of the counter: it must SURVIVE the
      // 401 it caused. `resolveApprover` RETURNS this response, it does not throw.
      expect(await failedAttempts(ctx.approver2)).toBe(1);
      expect(await deviceLastSeen()).not.toBe(before.lastSeen);
      // The command never ran, so no money row was written either way.
      expect(await tenantCounts()).toEqual(before.counts);
      expect(await idempotencyKeyRow(key)).toBeNull();
      const bill = await readBill(seeded.billId);
      eqMoney(bill.grandTotal, '5.00');
    });
  });

  describe('the boundary itself, so future factories inherit it', () => {
    /** A synthetic money route: write a row, then throw. Any factory layered on
     * `withTerminalAuth` reaches the transport this way. */
    function throwingRoute(
      marker: string,
      error: unknown,
      mapError?: (err: unknown) => Response | null
    ) {
      return deps.terminalAuth.withTerminalAuth(
        async (routeCtx) => {
          await routeCtx.db.restaurantCustomer.create({
            data: { id: marker, displayName: 'must not survive' },
          });
          throw error;
        },
        mapError ? { mapError } : {}
      );
    }

    const customerExists = async (id: string) =>
      (await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantCustomer.findUnique({ where: { id }, select: { id: true } })
      )) !== null;

    it('maps a domain error to its status only AFTER the transaction is rolled back', async () => {
      const marker = `synthetic_mapped_${suffix}`;
      const error = new deps.bills.BillCommandError(
        'Only an OPEN bill can be comped.',
        'BILL_NOT_OPEN'
      );
      const { moneyErrorResponse } = await import('./checkout-routes');
      const handler = throwingRoute(marker, error, moneyErrorResponse);

      const res = await handler(
        new Request('https://tenant.test/api/restaurant/probe', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ctx.deviceSecret}`,
            'x-terminal-session': ctx.session,
            'idempotency-key': uniqueKey('synthetic'),
            'content-type': 'application/json',
          },
          body: '{}',
        })
      );
      // The public contract is unchanged: BILL_NOT_OPEN is still a 409.
      expect(res.status).toBe(409);
      expect(await customerExists(marker)).toBe(false);
    });

    it('answers a generic 500 for an unmapped error and still commits nothing', async () => {
      const marker = `synthetic_unmapped_${suffix}`;
      const handler = throwingRoute(marker, new Error('boom'));

      const res = await handler(
        new Request('https://tenant.test/api/restaurant/probe', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ctx.deviceSecret}`,
            'x-terminal-session': ctx.session,
            'content-type': 'application/json',
          },
          body: '{}',
        })
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(await customerExists(marker)).toBe(false);
    });

    it('preserves the operator binding and idle timestamp after a refused catering operation', async () => {
      await deps.withPlatformDb(async (tx) => {
        const core = await ensurePlatformModule(tx, 'restaurant-core', {
          name: 'Restaurant core',
          category: 'Operations',
        });
        await tx.organizationModule.create({ data: { organizationId: orgId, moduleId: core.id } });
      });
      const established = await call(deps.routes.establish, { session: '' });
      const session = established.json.sessionToken as string;
      const sessionId = (established.json.session as { id: string }).id;
      expect(
        (
          await call(deps.routes.unlock, {
            session,
            body: { staffProfileId: ctx.operator, type: 'PIN', secret: PIN },
          })
        ).status
      ).toBe(200);
      const binding = () =>
        deps.withTenantDb(orgId, (tx) =>
          tx.restaurantTerminalSession.findUniqueOrThrow({ where: { id: sessionId } })
        );
      const before = await binding();
      const route = await import('@/app/api/restaurant/catering/money/route');
      const res = await call(route, {
        session,
        key: uniqueKey('catering-denial'),
        body: {
          cateringOrderId: 'synthetic-order',
          quoteRevisionId: 'synthetic-quote',
          kind: 'DEPOSIT',
          amount: '1.00',
          currency: 'USD',
          source: 'OPERATOR_ATTESTED',
          externalEvidenceSource: 'Synthetic fixture',
          externalEvidenceReference: uniqueKey('fixture'),
        },
      });
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('CAPABILITY_DENIED');
      expect(await binding()).toMatchObject({
        activeStaffProfileId: ctx.operator,
        endedAt: null,
        lastActivityAt: before.lastActivityAt,
      });
    });

    it('commits a handler that returns normally', async () => {
      const marker = `synthetic_ok_${suffix}`;
      const handler = deps.terminalAuth.withTerminalAuth(async (routeCtx) => {
        await routeCtx.db.restaurantCustomer.create({
          data: { id: marker, displayName: 'survives' },
        });
        return Response.json({ ok: true });
      });

      const res = await handler(
        new Request('https://tenant.test/api/restaurant/probe', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ctx.deviceSecret}`,
            'x-terminal-session': ctx.session,
            'content-type': 'application/json',
          },
          body: '{}',
        })
      );
      expect(res.status).toBe(200);
      expect(await customerExists(marker)).toBe(true);
    });
  });
});

describeIfDatabase('WHA-331 canonical frozen money idempotency', () => {
  const canonical = (bytes: string) => ({
    bytes,
    hash: createHash('sha256').update(bytes, 'utf8').digest('hex'),
  });
  const actor = (key: string) => ({
    staffProfileId: ctx.operator,
    deviceId: ctx.deviceId,
    idempotencyKey: key,
  });

  it('returns the exact frozen result before any live bill or configuration lookup', async () => {
    const key = uniqueKey('canonical-replay');
    const request = canonical('{"amount":"12.34","billId":"gone"}');
    const frozen = { status: 'SETTLED', total: '12.34', evidence: ['rule-deleted-later'] };

    await deps.withTenantDb(orgId, async (tx) => {
      expect(await beginMoneyIdempotent(tx, actor(key), 'tax.settle', request)).toEqual({
        replay: false,
      });
      await recordMoneyResult(tx, actor(key), 'settlement_ref', frozen);
    });

    await deps.withTenantDb(orgId, async (tx) => {
      const replay = await beginMoneyIdempotent(tx, actor(key), 'tax.settle', request);
      expect(replay).toMatchObject({ replay: true, resultRef: 'settlement_ref' });
      if (!replay.replay) throw new Error('expected replay');
      expect(replay.resultPayload).toEqual(frozen);
    });
  });

  it('rejects the same key with different canonical bytes and writes nothing', async () => {
    const key = uniqueKey('canonical-conflict');
    await deps.withTenantDb(orgId, async (tx) => {
      await beginMoneyIdempotent(tx, actor(key), 'tax.settle', canonical('{"amount":"1.00"}'));
      await recordMoneyResult(tx, actor(key), 'settlement_ref', { total: '1.00' });
    });
    const before = await tenantCounts();

    await expect(
      deps.withTenantDb(orgId, (tx) =>
        beginMoneyIdempotent(tx, actor(key), 'tax.settle', canonical('{"amount":"2.00"}'))
      )
    ).rejects.toMatchObject({ reason: 'TAX_SETTLEMENT_CONFLICT' });
    expect(await tenantCounts()).toEqual(before);
  });

  it('rejects a payload-less legacy key owned by a different money command', async () => {
    const key = uniqueKey('legacy-cross-command');
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantMoneyIdempotencyKey.create({
        data: {
          deviceId: ctx.deviceId,
          key,
          commandType: 'cash.day_close',
          resultRef: 'legacy_close_ref',
        },
      })
    );
    const before = await tenantCounts();

    await expect(
      deps.withTenantDb(orgId, (tx) =>
        beginMoneyIdempotent(tx, actor(key), 'tender.card', canonical('{"amount":"12.50"}'))
      )
    ).rejects.toMatchObject({ reason: 'TAX_SETTLEMENT_CONFLICT' });
    expect(await tenantCounts()).toEqual(before);
    expect(await idempotencyKeyRow(key)).toMatchObject({
      commandType: 'cash.day_close',
      resultRef: 'legacy_close_ref',
    });
  });

  it('allows exactly one finalization and preserves the winner payload', async () => {
    const key = uniqueKey('canonical-finalize');
    const request = canonical('{"amount":"7.00"}');
    await deps.withTenantDb(orgId, (tx) =>
      beginMoneyIdempotent(tx, actor(key), 'tax.settle', request)
    );

    const attempts = await Promise.allSettled([
      deps.withTenantDb(orgId, (tx) =>
        recordMoneyResult(tx, actor(key), 'winner-a', { winner: 'a' })
      ),
      deps.withTenantDb(orgId, (tx) =>
        recordMoneyResult(tx, actor(key), 'winner-b', { winner: 'b' })
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);

    await deps.withTenantDb(orgId, async (tx) => {
      const replay = await beginMoneyIdempotent(tx, actor(key), 'tax.settle', request);
      if (!replay.replay) throw new Error('expected replay');
      expect([
        { resultRef: 'winner-a', resultPayload: { winner: 'a' } },
        { resultRef: 'winner-b', resultPayload: { winner: 'b' } },
      ]).toContainEqual({ resultRef: replay.resultRef, resultPayload: replay.resultPayload });
    });
  });

  it('rolls back the key and financial write when finalization fails', async () => {
    const key = uniqueKey('canonical-rollback');
    const marker = `canonical_rollback_${suffix}`;
    await expect(
      deps.withTenantDb(orgId, async (tx) => {
        await beginMoneyIdempotent(tx, actor(key), 'tax.settle', canonical('{"amount":"9.00"}'));
        await tx.restaurantCustomer.create({ data: { id: marker, displayName: 'must roll back' } });
        await recordMoneyResult(tx, actor(key), 'settlement_ref', { total: '9.00' });
        throw new Error('injected after finalization');
      })
    ).rejects.toThrow('injected after finalization');

    expect(await idempotencyKeyRow(key)).toBeNull();
    expect(
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantCustomer.findUnique({ where: { id: marker }, select: { id: true } })
      )
    ).toBeNull();
  });
});
