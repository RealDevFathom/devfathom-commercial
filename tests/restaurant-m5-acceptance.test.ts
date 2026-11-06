/**
 * WHA-62 — M5 acceptance flows through actual terminal REST route handlers.
 *
 * Requires TEST_DATABASE_URL. The DB battery is explicitly skipped when unavailable.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';
import { ensureRestaurantTaxProfile } from '@/lib/test-support/restaurant-tax-profile';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const D = (value: string | Prisma.Decimal) => new Prisma.Decimal(value);
const sum = (values: readonly Prisma.Decimal[]) =>
  values.reduce((total, value) => total.plus(value), D('0'));
const eqMoney = (actual: unknown, expected: string | Prisma.Decimal) =>
  expect(D(String(actual)).equals(expected)).toBe(true);

type RouteModule = {
  GET?: (request: Request) => Promise<Response>;
  POST?: (request: Request) => Promise<Response>;
};

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  hashOperatorCredential: (typeof import('@/lib/restaurant/operator-credentials'))['hashOperatorCredential'];
  routes: Record<string, RouteModule>;
  terminal: { establish: RouteModule; unlock: RouteModule };
};

type Device = { branchId: string; deviceId: string; secret: string };

const suffix = randomBytes(6).toString('hex');
const PIN = '424242';
const orgId = `org_wha62_accept_${suffix}`;
const ids = {
  splitBranch: `branch_split_${suffix}`,
  moneyBranch: `branch_money_${suffix}`,
  crossBranch: `branch_cross_${suffix}`,
  receiptBranch: `branch_receipt_${suffix}`,
  role: `role_accept_${suffix}`,
  operatorUser: `user_accept_op_${suffix}`,
  managerUser: `user_accept_mgr_${suffix}`,
  operator: `staff_accept_op_${suffix}`,
  manager: `staff_accept_mgr_${suffix}`,
  product: `product_accept_${suffix}`,
};

let deps: Deps;
const devices = new Map<string, Device>();
const composerProofs = new Map<string, string>();
const currentBusinessDate = () => new Date().toISOString().slice(0, 10);
const previousBusinessDate = (date: string) => {
  const previous = new Date(`${date}T00:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
};

const key = (label: string) => `${label}_${suffix}_${randomBytes(3).toString('hex')}`;
const utcDate = (date: string) => new Date(`${date}T00:00:00.000Z`);

async function call(
  route: RouteModule,
  options: {
    method?: 'GET' | 'POST';
    secret?: string;
    session?: string;
    key?: string;
    body?: unknown;
    query?: Record<string, string>;
  }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const method = options.method ?? 'POST';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.secret) headers.authorization = `Bearer ${options.secret}`;
  if (options.session) headers['x-terminal-session'] = options.session;
  const composerProof = options.session ? composerProofs.get(options.session) : undefined;
  if (composerProof) headers['x-pos-composer-proof'] = composerProof;
  if (options.key) headers['idempotency-key'] = options.key;
  const url = new URL('https://tenant.test/api/restaurant/probe');
  for (const [name, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(name, value);
  }
  const response = await (method === 'GET' ? route.GET! : route.POST!)(
    new Request(url, {
      method,
      headers,
      body:
        method === 'GET' || options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  );
  return {
    status: response.status,
    json: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function unlock(device: Device): Promise<string> {
  await deps.withTenantDb(orgId, (tx) =>
    tx.restaurantStaffProfile.updateMany({
      where: { id: { in: [ids.operator, ids.manager] } },
      data: { primaryBranchId: device.branchId },
    })
  );
  const established = await call(deps.terminal.establish, { secret: device.secret });
  expect(established.status).toBe(201);
  const session = established.json.sessionToken as string;
  const unlocked = await call(deps.terminal.unlock, {
    secret: device.secret,
    session,
    body: { staffProfileId: ids.operator, type: 'PIN', secret: PIN },
  });
  expect(unlocked.status).toBe(200);
  composerProofs.set(session, unlocked.json.composerProof as string);
  return session;
}

async function seedOrder(
  branchId: string,
  deviceId: string,
  businessDate: string,
  orderNumber: number,
  prices: readonly string[]
): Promise<{ orderId: string; itemIds: string[] }> {
  return deps.withTenantDb(orgId, async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId,
        orderNumber,
        businessDate: utcDate(businessDate),
        status: 'SERVED',
        channel: 'DINE_IN',
        staffProfileId: ids.operator,
        deviceId,
      },
      select: { id: true },
    });
    const itemIds: string[] = [];
    for (const price of prices) {
      const item = await tx.restaurantOrderItem.create({
        data: {
          orderId: order.id,
          productId: ids.product,
          name: 'Acceptance item',
          unitPrice: price,
          quantity: 1,
          status: 'SERVED',
        },
        select: { id: true },
      });
      itemIds.push(item.id);
    }
    return { orderId: order.id, itemIds };
  });
}

/** The POS parks a served order for payment before checkout (closeForPayment); the
 * final tender then closes it. A still-SERVED order is active and blocks the day close. */
async function parkForPayment(device: Device, session: string, orderId: string): Promise<void> {
  const response = await call(deps.routes.orderClose, {
    secret: device.secret,
    session,
    key: key('park'),
    body: { orderId },
  });
  expect(response.status, JSON.stringify(response.json)).toBe(200);
}

async function cutBills(
  device: Device,
  session: string,
  orderId: string,
  split: unknown
): Promise<string[]> {
  const response = await call(deps.routes.bill, {
    secret: device.secret,
    session,
    key: key('bill'),
    body: { orderId, split },
  });
  expect(response.status).toBe(200);
  return response.json.billIds as string[];
}

async function cardTender(
  device: Device,
  session: string,
  billId: string,
  amount: string,
  tipAmount?: string
) {
  const response = await call(deps.routes.tender, {
    secret: device.secret,
    session,
    key: key('card'),
    body: { billId, tender: { type: 'CARD', amount, ...(tipAmount ? { tipAmount } : {}) } },
  });
  expect(response.status).toBe(200);
  expect(response.json.settled).toBe(true);
  return response.json;
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, deviceModule, credentials, ...routeModules] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/app/api/restaurant/checkout/bill/route'),
    // The public MVP comp endpoint denies every request (#454); the retained comp domain
    // is reachable only through the test-only transport.
    import('@/lib/test-support/retained-comp-route'),
    import('@/app/api/restaurant/checkout/tender/route'),
    import('@/app/api/restaurant/checkout/refund/route'),
    import('@/app/api/restaurant/cash/day/close/route'),
    import('@/app/api/restaurant/cash/day/correct/route'),
    import('@/app/api/restaurant/terminal/establish/route'),
    import('@/app/api/restaurant/terminal/unlock/route'),
    import('@/app/api/restaurant/orders/close/route'),
  ]);
  const [bill, comp, tender, refund, dayClose, dayCorrect, establish, unlockRoute, orderClose] =
    routeModules as RouteModule[];
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: deviceModule.enrollDevice,
    hashOperatorCredential: credentials.hashOperatorCredential,
    routes: { bill, comp, tender, refund, dayClose, dayCorrect, orderClose },
    terminal: { establish, unlock: unlockRoute },
  };

  // ACTIVE and entitled to `restaurant-pos`: the terminal transport answers 403
  // before the handler when the module is disabled (WHA-192).
  await deps.withPlatformDb(async (tx) => {
    await tx.organization.create({
      data: {
        id: orgId,
        slug: `wha62-accept-${suffix}`,
        legalName: 'WHA-62 Acceptance Test',
        displayName: 'WHA-62 Acceptance',
        status: 'ACTIVE',
      },
    });
    await seedDepartments(tx, [orgId], ['LEADERSHIP']);
    const posModule = await ensurePlatformModule(tx, 'restaurant-pos', {
      name: 'POS and Fulfilment',
      category: 'Operations',
    });
    await tx.organizationModule.create({
      data: {
        organizationId: orgId,
        moduleId: posModule.id,
        // Backdated: suites that travel to a past business date must stay
        // entitled — the override only applies once `startsAt` has passed.
        startsAt: new Date(0),
      },
    });
  });
  await deps.withTenantDb(orgId, async (tx) => {
    for (const [branchId, name] of [
      [ids.splitBranch, 'Split'],
      [ids.moneyBranch, 'Money'],
      [ids.crossBranch, 'Cross date'],
      [ids.receiptBranch, 'Receipts'],
    ] as const) {
      await tx.restaurantBranch.create({
        data: { id: branchId, name, timezone: 'UTC', businessDayCutoff: '00:00' },
      });
      await ensureRestaurantTaxProfile(tx, orgId, branchId);
    }
    await tx.restaurantProduct.create({ data: { id: ids.product, name: 'Acceptance item' } });
    await tx.organizationRole.create({
      data: {
        id: ids.role,
        key: `money_accept_${suffix}`,
        name: 'Money acceptance',
        permissions: { create: [{ capability: '*', effect: 'ALLOW' }] },
      },
    });
    for (const [userId, staffId, label] of [
      [ids.operatorUser, ids.operator, 'Operator'],
      [ids.managerUser, ids.manager, 'Manager'],
    ] as const) {
      await tx.user.create({
        data: {
          id: userId,
          name: label,
          email: `${label.toLowerCase()}_${suffix}@test.local`,
          department: 'LEADERSHIP',
          title: label,
          organizationRoleId: ids.role,
        },
      });
      await tx.restaurantStaffProfile.create({
        data: {
          id: staffId,
          displayName: label,
          primaryBranchId: ids.splitBranch,
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
      await tx.restaurantBranchAssignment.createMany({
        data: [ids.moneyBranch, ids.crossBranch, ids.receiptBranch].map((branchId) => ({
          branchId,
          userId,
        })),
      });
    }

    for (const branchId of [ids.splitBranch, ids.moneyBranch, ids.crossBranch, ids.receiptBranch]) {
      const { device, secret } = await deps.enrollDevice(tx, {
        branchId,
        name: `POS ${branchId}`,
      });
      devices.set(branchId, { branchId, deviceId: device.id, secret });
    }
  });
}, 60_000);

describeIfDatabase('WHA-62 M5 acceptance battery (real REST + DB)', () => {
  it('allocates adversarial odd-cent FRACTIONAL splits by 3 and 7 exactly and deterministically', async () => {
    const device = devices.get(ids.splitBranch)!;
    const session = await unlock(device);
    const businessDate = currentBusinessDate();
    for (const scenario of [
      { orderNumber: 31001, total: '10.01', count: 3, expected: ['3.34', '3.34', '3.33'] },
      {
        orderNumber: 71003,
        total: '10.03',
        count: 7,
        expected: ['1.44', '1.44', '1.43', '1.43', '1.43', '1.43', '1.43'],
      },
    ]) {
      const order = await seedOrder(
        ids.splitBranch,
        device.deviceId,
        businessDate,
        scenario.orderNumber,
        [scenario.total]
      );
      const billIds = await cutBills(device, session, order.orderId, {
        kind: 'FRACTIONAL',
        weights: Array.from({ length: scenario.count }, () => 1),
      });
      const rows = await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantBill.findMany({
          where: { id: { in: billIds } },
          select: {
            id: true,
            fractionNumerator: true,
            fractionDenominator: true,
            grandTotal: true,
          },
        })
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = billIds.map((id) => byId.get(id)!);
      expect(ordered).toHaveLength(scenario.count);
      ordered.forEach((row, index) => {
        expect(row.fractionNumerator).toBe(1);
        expect(row.fractionDenominator).toBe(scenario.count);
        eqMoney(row.grandTotal, scenario.expected[index]!);
      });
      eqMoney(sum(ordered.map((row) => row.grandTotal)), scenario.total);
    }
  }, 60_000);

  it('carries a zeroed comp and keeps tips distinct from service charges through close', async () => {
    const device = devices.get(ids.moneyBranch)!;
    const session = await unlock(device);
    const businessDate = currentBusinessDate();
    const compOrder = await seedOrder(ids.moneyBranch, device.deviceId, businessDate, 41001, [
      '8.01',
    ]);
    await parkForPayment(device, session, compOrder.orderId);
    const [compBillId] = await cutBills(device, session, compOrder.orderId, { kind: 'NONE' });
    const compLine = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantBillLine.findFirst({
        where: { billId: compBillId, orderItemId: compOrder.itemIds[0] },
        select: { id: true },
      })
    );
    const comp = await call(deps.routes.comp, {
      secret: device.secret,
      session,
      key: key('comp'),
      body: {
        billId: compBillId,
        billLineId: compLine!.id,
        reason: 'service recovery',
        approving: { staffProfileId: ids.manager, type: 'PIN', secret: PIN },
      },
    });
    expect(comp.status).toBe(200);

    const zeroed = await deps.withTenantDb(orgId, async (tx) => ({
      line: await tx.restaurantBillLine.findUnique({
        where: { id: compLine!.id },
        select: { lineSubtotal: true, compAmount: true, lineTotal: true },
      }),
      bill: await tx.restaurantBill.findUnique({
        where: { id: compBillId },
        select: { status: true, compTotal: true, grandTotal: true },
      }),
    }));
    eqMoney(zeroed.line!.lineSubtotal, '8.01');
    eqMoney(zeroed.line!.compAmount, '8.01');
    eqMoney(zeroed.line!.lineTotal, '0');
    eqMoney(zeroed.bill!.compTotal, '8.01');
    eqMoney(zeroed.bill!.grandTotal, '0');
    if (zeroed.bill!.status !== 'SETTLED') {
      const settlement = await call(deps.routes.tender, {
        secret: device.secret,
        session,
        key: key('zero_comp_settlement'),
        body: { billId: compBillId, tender: { type: 'OTHER', amount: '0.00' } },
      });
      expect(settlement.status).toBe(200);
      expect(settlement.json.settled).toBe(true);
      eqMoney(settlement.json.remainingDue, '0');
    }
    const settledComp = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantBill.findUnique({ where: { id: compBillId }, select: { status: true } })
    );
    expect(settledComp?.status).toBe('SETTLED');

    const tipOrder = await seedOrder(ids.moneyBranch, device.deviceId, businessDate, 41002, [
      '5.00',
    ]);
    await parkForPayment(device, session, tipOrder.orderId);
    const [tipBillId] = await cutBills(device, session, tipOrder.orderId, { kind: 'NONE' });
    await cardTender(device, session, tipBillId!, '5.00', '1.23');

    const close = await call(deps.routes.dayClose, {
      secret: device.secret,
      session,
      key: key('money_close'),
      body: { businessDate },
    });
    expect(close.status).toBe(200);
    const persisted = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantDailyClose.findUnique({
        where: { id: close.json.dailyCloseId as string },
        select: { compTotal: true, tipTotal: true, serviceChargeTotal: true },
      })
    );
    eqMoney(persisted!.compTotal, '8.01');
    eqMoney(persisted!.tipTotal, '1.23');
    eqMoney(persisted!.serviceChargeTotal, '0');
  }, 60_000);

  it('posts a D1 sale refund to D2 and preserves immutable close/correction chains', async () => {
    const device = devices.get(ids.crossBranch)!;
    const session = await unlock(device);
    const saleDate = previousBusinessDate(currentBusinessDate());
    const order = await seedOrder(ids.crossBranch, device.deviceId, saleDate, 51001, ['40.00']);
    await parkForPayment(device, session, order.orderId);
    const [billId] = await cutBills(device, session, order.orderId, { kind: 'NONE' });
    const sale = await cardTender(device, session, billId!, '40.00', '2.00');

    const d1CloseResponse = await call(deps.routes.dayClose, {
      secret: device.secret,
      session,
      key: key('d1_close'),
      body: { businessDate: saleDate },
    });
    expect(d1CloseResponse.status).toBe(200);
    const d1CloseId = d1CloseResponse.json.dailyCloseId as string;
    const selectClose = (id: string) =>
      deps.withTenantDb(orgId, (tx) =>
        tx.restaurantDailyClose.findUnique({
          where: { id },
          select: {
            id: true,
            organizationId: true,
            branchId: true,
            businessDate: true,
            supersedesCloseId: true,
            correctionReason: true,
            coAuthorizationId: true,
            cutByStaffProfileId: true,
            deviceId: true,
            grossSales: true,
            netSales: true,
            taxTotal: true,
            serviceChargeTotal: true,
            tipTotal: true,
            compTotal: true,
            discountTotal: true,
            refundTotal: true,
            voidTotal: true,
            cashExpected: true,
            cashCounted: true,
            cashVariance: true,
            createdAt: true,
            tenderTotals: {
              orderBy: { tenderType: 'asc' },
              select: {
                id: true,
                organizationId: true,
                dailyCloseId: true,
                tenderType: true,
                amount: true,
                tipAmount: true,
                count: true,
                createdAt: true,
              },
            },
          },
        })
      );
    const d1Before = await selectClose(d1CloseId);
    const d1Bytes = JSON.stringify(d1Before);

    const processingDateBefore = currentBusinessDate();
    const refund = await call(deps.routes.refund, {
      secret: device.secret,
      session,
      key: key('d2_refund'),
      body: {
        originalTenderId: sale.tenderId,
        amount: '15.00',
        reason: 'next-day adjustment',
        approving: { staffProfileId: ids.manager, type: 'PIN', secret: PIN },
      },
    });
    expect(refund.status).toBe(200);
    const processingDateAfter = currentBusinessDate();
    const refundDate = refund.json.businessDate as string;
    expect([processingDateBefore, processingDateAfter]).toContain(refundDate);
    expect(refundDate).not.toBe(saleDate);

    const d2CloseResponse = await call(deps.routes.dayClose, {
      secret: device.secret,
      session,
      key: key('d2_close'),
      body: { businessDate: refundDate },
    });
    expect(d2CloseResponse.status).toBe(200);
    const d2CloseId = d2CloseResponse.json.dailyCloseId as string;
    const d2Before = await selectClose(d2CloseId);
    eqMoney(d2Before!.refundTotal, '15.00');
    eqMoney(d2Before!.grossSales, '0');

    const missingManager = await call(deps.routes.dayCorrect, {
      secret: device.secret,
      session,
      key: key('missing_manager'),
      body: {
        businessDate: refundDate,
        supersedesCloseId: d2CloseId,
        reason: 'missing manager',
      },
    });
    expect(missingManager.status).toBe(400);
    const afterDeniedCount = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantDailyClose.count({
        where: { branchId: ids.crossBranch, businessDate: utcDate(refundDate) },
      })
    );
    expect(afterDeniedCount).toBe(1);

    const corrected = await call(deps.routes.dayCorrect, {
      secret: device.secret,
      session,
      key: key('correct'),
      body: {
        businessDate: refundDate,
        supersedesCloseId: d2CloseId,
        reason: 'manager recount',
        approving: { staffProfileId: ids.manager, type: 'PIN', secret: PIN },
      },
    });
    expect(corrected.status).toBe(200);
    expect(corrected.json.supersedesCloseId).toBe(d2CloseId);
    const correctedId = corrected.json.dailyCloseId as string;
    expect(correctedId).not.toBe(d2CloseId);
    expect(await selectClose(d2CloseId)).toEqual(d2Before);

    const stale = await call(deps.routes.dayCorrect, {
      secret: device.secret,
      session,
      key: key('stale'),
      body: {
        businessDate: refundDate,
        supersedesCloseId: d2CloseId,
        reason: 'stale retry',
        approving: { staffProfileId: ids.manager, type: 'PIN', secret: PIN },
      },
    });
    expect(stale.status).toBe(409);

    const chain = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantDailyClose.findMany({
        where: { branchId: ids.crossBranch, businessDate: utcDate(refundDate) },
        select: { id: true, supersedesCloseId: true, coAuthorizationId: true },
      })
    );
    expect(chain).toHaveLength(2);
    const superseded = new Set(
      chain.flatMap((row) => (row.supersedesCloseId ? [row.supersedesCloseId] : []))
    );
    const authoritative = chain.filter((row) => !superseded.has(row.id));
    expect(authoritative).toHaveLength(1);
    expect(authoritative[0]!.id).toBe(correctedId);
    expect(authoritative[0]!.coAuthorizationId).not.toBeNull();

    const d1After = await selectClose(d1CloseId);
    expect(JSON.stringify(d1After)).toBe(d1Bytes);
  }, 60_000);

  it('allocates unique monotonic receipts under concurrent REST settlement, apart from order numbers', async () => {
    const device = devices.get(ids.receiptBranch)!;
    const session = await unlock(device);
    const businessDate = currentBusinessDate();
    const orderNumbers = [9001, 7, 500, 42, 8100];
    const billIds: string[] = [];
    for (const orderNumber of orderNumbers) {
      const order = await seedOrder(ids.receiptBranch, device.deviceId, businessDate, orderNumber, [
        '12.50',
      ]);
      const [billId] = await cutBills(device, session, order.orderId, { kind: 'NONE' });
      billIds.push(billId!);
    }

    const first = await cardTender(device, session, billIds[0]!, '12.50');
    const second = await cardTender(device, session, billIds[1]!, '12.50');
    expect(second.receiptNumber as number).toBeGreaterThan(first.receiptNumber as number);

    const concurrent = await Promise.all(
      billIds.slice(2, 4).map((billId) =>
        call(deps.routes.tender, {
          secret: device.secret,
          session,
          key: key('concurrent_receipt'),
          body: { billId, tender: { type: 'CARD', amount: '12.50' } },
        })
      )
    );
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);

    const sameBillRace = await Promise.all(
      ['race_a', 'race_b'].map((label) =>
        call(deps.routes.tender, {
          secret: device.secret,
          session,
          key: key(label),
          body: { billId: billIds[4], tender: { type: 'CARD', amount: '12.50' } },
        })
      )
    );
    expect(sameBillRace.map((response) => response.status).sort()).toEqual([200, 409]);

    const receiptState = await deps.withTenantDb(orgId, async (tx) => ({
      bills: await tx.restaurantBill.findMany({
        where: { id: { in: billIds } },
        orderBy: { receiptNumber: 'asc' },
        select: {
          id: true,
          receiptNumber: true,
          order: { select: { orderNumber: true } },
          tenders: { select: { id: true } },
        },
      }),
      sequence: await tx.restaurantReceiptNumberSequence.findUnique({
        where: {
          branchId_businessDate: {
            branchId: ids.receiptBranch,
            businessDate: utcDate(businessDate),
          },
        },
        select: { nextNumber: true },
      }),
    }));
    const receipts = receiptState.bills.map((bill) => bill.receiptNumber!);
    expect(receipts).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(receipts).size).toBe(receipts.length);
    for (let index = 1; index < receipts.length; index += 1) {
      expect(receipts[index]).toBeGreaterThan(receipts[index - 1]!);
    }
    expect(receiptState.sequence?.nextNumber).toBe(5);
    expect(receiptState.bills.find((bill) => bill.id === billIds[4])!.tenders).toHaveLength(1);
    expect(receiptState.bills.every((bill) => bill.receiptNumber !== bill.order.orderNumber)).toBe(
      true
    );
    expect(receiptState.bills.map((bill) => bill.order.orderNumber)).not.toEqual(receipts);
  }, 60_000);
});
