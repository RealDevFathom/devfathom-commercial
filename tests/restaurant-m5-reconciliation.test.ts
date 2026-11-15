/**
 * WHA-62 — independent M5 reconciliation through the real terminal REST handlers.
 *
 * Requires TEST_DATABASE_URL. The suite is explicitly skipped when the migrated,
 * disposable test database is unavailable.
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
  expect(D(String(actual)).toString()).toBe(D(expected).toString());

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

type Device = { deviceId: string; secret: string };

const suffix = randomBytes(6).toString('hex');
const PIN = '424242';
const orgId = `org_wha62_recon_${suffix}`;
const ids = {
  branch: `branch_recon_${suffix}`,
  role: `role_recon_${suffix}`,
  operatorUser: `user_recon_op_${suffix}`,
  managerUser: `user_recon_mgr_${suffix}`,
  operator: `staff_recon_op_${suffix}`,
  manager: `staff_recon_mgr_${suffix}`,
  product: `product_recon_${suffix}`,
};

let deps: Deps;
let registerA: Device;
let registerB: Device;

const key = (label: string) => `${label}_${suffix}_${randomBytes(3).toString('hex')}`;
const utcDate = (date: string) => new Date(`${date}T00:00:00.000Z`);

/** Terminal order commands require the composer proof issued at unlock. */
const composerProofs = new Map<string, string>();

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
  const established = await call(deps.terminal.establish, { secret: device.secret });
  expect(established.status).toBe(201);
  const session = established.json.sessionToken as string;
  const unlocked = await call(deps.terminal.unlock, {
    secret: device.secret,
    session,
    body: { staffProfileId: ids.operator, type: 'PIN', secret: PIN },
  });
  expect(unlocked.status).toBe(200);
  expect(unlocked.json.composerProof).toEqual(expect.any(String));
  composerProofs.set(session, unlocked.json.composerProof as string);
  return session;
}

async function seedOrder(
  deviceId: string,
  businessDate: string,
  orderNumber: number,
  prices: readonly string[]
): Promise<string> {
  return deps.withTenantDb(orgId, async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId: ids.branch,
        orderNumber,
        businessDate: utcDate(businessDate),
        status: 'SERVED',
        channel: 'DINE_IN',
        staffProfileId: ids.operator,
        deviceId,
      },
      select: { id: true },
    });
    for (const price of prices) {
      await tx.restaurantOrderItem.create({
        data: {
          orderId: order.id,
          productId: ids.product,
          name: 'Reconciliation item',
          unitPrice: price,
          quantity: 1,
          status: 'SERVED',
        },
      });
    }
    return order.id;
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, credentials, ...routeModules] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/app/api/restaurant/checkout/bill/route'),
    import('@/app/api/restaurant/checkout/tender/route'),
    import('@/app/api/restaurant/checkout/refund/route'),
    import('@/app/api/restaurant/cash/drawer/open/route'),
    import('@/app/api/restaurant/cash/drawer/movement/route'),
    import('@/app/api/restaurant/cash/drawer/close/route'),
    import('@/app/api/restaurant/cash/day/close/route'),
    import('@/app/api/restaurant/terminal/establish/route'),
    import('@/app/api/restaurant/terminal/unlock/route'),
    import('@/app/api/restaurant/orders/close/route'),
  ]);
  const [
    bill,
    tender,
    refund,
    drawerOpen,
    drawerMovement,
    drawerClose,
    dayClose,
    establish,
    unlockRoute,
    orderClose,
  ] = routeModules as RouteModule[];
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: devices.enrollDevice,
    hashOperatorCredential: credentials.hashOperatorCredential,
    routes: {
      bill,
      tender,
      refund,
      drawerOpen,
      drawerMovement,
      drawerClose,
      dayClose,
      orderClose,
    },
    terminal: { establish, unlock: unlockRoute },
  };

  // ACTIVE and entitled to `restaurant-pos`: the terminal transport answers 403
  // before the handler when the module is disabled (WHA-192).
  await deps.withPlatformDb(async (tx) => {
    await tx.organization.create({
      data: {
        id: orgId,
        slug: `wha62-recon-${suffix}`,
        legalName: 'WHA-62 Reconciliation Test',
        displayName: 'WHA-62 Reconciliation',
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
    await tx.organizationLimit.create({
      data: {
        organizationId: orgId,
        key: 'pos.concurrentRegisters.max',
        value: 2,
        source: 'WHA-1044_TEST',
      },
    });
  });
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: {
        id: ids.branch,
        name: 'Reconciliation Branch',
        timezone: 'UTC',
        businessDayCutoff: '00:00',
      },
    });
    await ensureRestaurantTaxProfile(tx, orgId, ids.branch);
    await tx.restaurantProduct.create({ data: { id: ids.product, name: 'Reconciliation item' } });
    await tx.organizationRole.create({
      data: {
        id: ids.role,
        key: `money_recon_${suffix}`,
        name: 'Money reconciliation',
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
          primaryBranchId: ids.branch,
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

  const enroll = (name: string) =>
    deps.withTenantDb(orgId, async (tx) => {
      const { device, secret } = await deps.enrollDevice(tx, { branchId: ids.branch, name });
      return { deviceId: device.id, secret };
    });
  registerA = await enroll('Register A');
  registerB = await enroll('Register B');
}, 60_000);

describeIfDatabase('WHA-62 M5 reconciliation headline battery (real REST + DB)', () => {
  it('reconciles orders, drawer ledgers, close totals, and tender children independently', async () => {
    const sessionA = await unlock(registerA);
    const sessionB = await unlock(registerB);

    const openedA = await call(deps.routes.drawerOpen, {
      secret: registerA.secret,
      session: sessionA,
      key: key('open_a'),
      body: { openingFloat: '100.00' },
    });
    const openedB = await call(deps.routes.drawerOpen, {
      secret: registerB.secret,
      session: sessionB,
      key: key('open_b'),
      body: { openingFloat: '50.00' },
    });
    expect(openedA.status).toBe(200);
    expect(openedB.status).toBe(200);
    const businessDate = openedA.json.businessDate as string;
    expect(openedB.json.businessDate).toBe(businessDate);
    const drawerA = openedA.json.drawerSessionId as string;
    const drawerB = openedB.json.drawerSessionId as string;

    const orderIds = [
      await seedOrder(registerA.deviceId, businessDate, 101, ['10.01', '5.02']),
      await seedOrder(registerB.deviceId, businessDate, 202, ['12.34', '7.66']),
      await seedOrder(registerB.deviceId, businessDate, 303, ['9.00']),
    ];

    const cut = async (device: Device, session: string, orderId: string, split: unknown) => {
      const response = await call(deps.routes.bill, {
        secret: device.secret,
        session,
        key: key('bill'),
        body: { orderId, split },
      });
      expect(response.status).toBe(200);
      return response.json.billIds as string[];
    };
    const bills1 = await cut(registerA, sessionA, orderIds[0]!, { kind: 'NONE' });
    const bills2 = await cut(registerB, sessionB, orderIds[1]!, {
      kind: 'BY_ITEM',
      groups: await deps.withTenantDb(orgId, async (tx) => {
        const items = await tx.restaurantOrderItem.findMany({
          where: { orderId: orderIds[1] },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        return items.map((item) => [item.id]);
      }),
    });
    const bills3 = await cut(registerB, sessionB, orderIds[2]!, { kind: 'NONE' });

    const tender = async (
      device: Device,
      session: string,
      billId: string,
      body: Record<string, unknown>
    ) => {
      const response = await call(deps.routes.tender, {
        secret: device.secret,
        session,
        key: key('tender'),
        body: { billId, tender: body },
      });
      expect(response.status).toBe(200);
      expect(response.json.settled).toBe(true);
      return response.json;
    };
    await tender(registerA, sessionA, bills1[0]!, {
      type: 'CASH',
      amount: '15.03',
      cashReceived: '20.00',
    });
    await tender(registerB, sessionB, bills2[0]!, {
      type: 'CARD',
      amount: '12.34',
      tipAmount: '2.00',
    });
    await tender(registerB, sessionB, bills2[1]!, {
      type: 'CASH',
      amount: '7.66',
      cashReceived: '10.00',
    });
    const refundable = await tender(registerB, sessionB, bills3[0]!, {
      type: 'CASH',
      amount: '9.00',
      cashReceived: '9.00',
    });
    const refunded = await call(deps.routes.refund, {
      secret: registerB.secret,
      session: sessionB,
      key: key('refund'),
      body: {
        originalTenderId: refundable.tenderId,
        amount: '4.00',
        reason: 'partial guest refund',
        approving: { staffProfileId: ids.manager, type: 'PIN', secret: PIN },
      },
    });
    expect(refunded.status).toBe(200);
    eqMoney(refunded.json.amount, '4.00');

    // Day close refuses active orders; finish each paid order as the terminal does.
    for (const [device, session, orderId] of [
      [registerA, sessionA, orderIds[0]!],
      [registerB, sessionB, orderIds[1]!],
      [registerB, sessionB, orderIds[2]!],
    ] as const) {
      const closedOrder = await call(deps.routes.orderClose, {
        secret: device.secret,
        session,
        key: key('order_close'),
        body: { orderId },
      });
      expect(closedOrder.status, JSON.stringify(closedOrder.json)).toBe(200);
    }
    const orderStatuses = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOrder.findMany({ where: { id: { in: orderIds } }, select: { status: true } })
    );
    expect(orderStatuses.map((order) => order.status)).toEqual(['CLOSED', 'CLOSED', 'CLOSED']);

    for (const [kind, amount] of [
      ['PAID_IN', '3.00'],
      ['PAID_OUT', '1.25'],
      ['DROP', '10.00'],
    ] as const) {
      const movement = await call(deps.routes.drawerMovement, {
        secret: registerA.secret,
        session: sessionA,
        key: key(kind.toLowerCase()),
        body: { drawerSessionId: drawerA, kind, amount, reason: `reconciliation ${kind}` },
      });
      expect(movement.status).toBe(200);
    }

    const closedA = await call(deps.routes.drawerClose, {
      secret: registerA.secret,
      session: sessionA,
      key: key('close_a'),
      body: { drawerSessionId: drawerA, countedCash: '106.50' },
    });
    const closedB = await call(deps.routes.drawerClose, {
      secret: registerB.secret,
      session: sessionB,
      key: key('close_b'),
      body: { drawerSessionId: drawerB, countedCash: '62.66' },
    });
    expect(closedA.status).toBe(200);
    expect(closedB.status).toBe(200);
    eqMoney(closedA.json.expectedCash, '106.78');
    eqMoney(closedB.json.expectedCash, '62.66');

    const cutClose = await call(deps.routes.dayClose, {
      secret: registerA.secret,
      session: sessionA,
      key: key('day_close'),
      body: { businessDate },
    });
    expect(cutClose.status).toBe(200);
    const dailyCloseId = cutClose.json.dailyCloseId as string;

    const raw = await deps.withTenantDb(orgId, async (tx) => ({
      orders: await tx.restaurantOrder.findMany({
        where: { id: { in: orderIds } },
        select: {
          id: true,
          items: {
            select: {
              unitPrice: true,
              quantity: true,
              modifiers: { select: { priceDelta: true } },
            },
          },
          bills: { select: { status: true, grandTotal: true } },
        },
      }),
      bills: await tx.restaurantBill.findMany({
        where: { branchId: ids.branch, businessDate: utcDate(businessDate) },
        select: {
          status: true,
          subtotal: true,
          taxTotal: true,
          serviceChargeTotal: true,
          deliveryFeeTotal: true,
          compTotal: true,
          discountTotal: true,
          roundingAdjustment: true,
          grandTotal: true,
        },
      }),
      tenders: await tx.restaurantTender.findMany({
        where: { businessDate: utcDate(businessDate), bill: { branchId: ids.branch } },
        select: { type: true, amount: true, tipAmount: true },
      }),
      refunds: await tx.restaurantRefund.findMany({
        where: { businessDate: utcDate(businessDate), bill: { branchId: ids.branch } },
        select: {
          amount: true,
          taxRefundAmount: true,
          serviceChargeRefundAmount: true,
          deliveryFeeRefundAmount: true,
        },
      }),
      drawers: await tx.restaurantDrawerSession.findMany({
        where: { branchId: ids.branch, businessDate: utcDate(businessDate) },
        select: {
          expectedCash: true,
          countedCash: true,
          movements: { select: { kind: true, amount: true } },
        },
      }),
      close: await tx.restaurantDailyClose.findUnique({
        where: { id: dailyCloseId },
        select: {
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
          tenderTotals: {
            select: { tenderType: true, amount: true, tipAmount: true, count: true },
          },
        },
      }),
    }));

    for (const order of raw.orders) {
      const derivedOrderTotal = sum(
        order.items.map((item) =>
          item.unitPrice
            .plus(sum(item.modifiers.map((modifier) => modifier.priceDelta)))
            .times(item.quantity)
        )
      );
      const billedTotal = sum(
        order.bills.filter((bill) => bill.status !== 'VOID').map((bill) => bill.grandTotal)
      );
      eqMoney(billedTotal, derivedOrderTotal);
    }

    const signs: Record<string, string> = {
      OPENING_FLOAT: '1',
      CASH_SALE: '1',
      CASH_REFUND: '-1',
      PAID_IN: '1',
      PAID_OUT: '-1',
      DROP: '-1',
      CLOSING_COUNT: '0',
    };
    const movementFold = sum(
      raw.drawers.flatMap((drawer) =>
        drawer.movements.map((movement) => movement.amount.times(signs[movement.kind]!))
      )
    );
    const storedDrawerExpected = sum(raw.drawers.map((drawer) => D(drawer.expectedCash ?? '0')));
    eqMoney(movementFold, storedDrawerExpected);
    expect(
      raw.drawers
        .flatMap((drawer) => drawer.movements)
        .filter((row) => row.kind === 'CLOSING_COUNT')
    ).toHaveLength(2);

    const settledBills = raw.bills.filter((bill) => bill.status === 'SETTLED');
    const voidBills = raw.bills.filter((bill) => bill.status === 'VOID');
    for (const bill of settledBills) {
      eqMoney(
        bill.subtotal
          .plus(bill.taxTotal)
          .plus(bill.serviceChargeTotal)
          .plus(bill.deliveryFeeTotal)
          .minus(bill.compTotal)
          .minus(bill.discountTotal)
          .plus(bill.roundingAdjustment),
        bill.grandTotal
      );
    }
    const expected = {
      grossSales: sum(settledBills.map((bill) => bill.subtotal)),
      compTotal: sum(settledBills.map((bill) => bill.compTotal)),
      discountTotal: sum(settledBills.map((bill) => bill.discountTotal)),
      taxTotal: sum(settledBills.map((bill) => bill.taxTotal)).minus(
        sum(raw.refunds.map((refund) => refund.taxRefundAmount))
      ),
      serviceChargeTotal: sum(settledBills.map((bill) => bill.serviceChargeTotal)).minus(
        sum(raw.refunds.map((refund) => refund.serviceChargeRefundAmount))
      ),
      tipTotal: sum(raw.tenders.map((tenderRow) => tenderRow.tipAmount)),
      refundTotal: sum(
        raw.refunds.map((refundRow) => refundRow.amount.minus(refundRow.deliveryFeeRefundAmount))
      ),
      voidTotal: sum(voidBills.map((bill) => bill.grandTotal)),
      cashExpected: movementFold,
      cashCounted: sum(raw.drawers.map((drawer) => D(drawer.countedCash ?? '0'))),
    };
    const refundedSales = sum(
      raw.refunds.map((refundRow) =>
        refundRow.amount
          .minus(refundRow.taxRefundAmount)
          .minus(refundRow.serviceChargeRefundAmount)
          .minus(refundRow.deliveryFeeRefundAmount)
      )
    );
    const netSales = expected.grossSales
      .minus(expected.compTotal)
      .minus(expected.discountTotal)
      .minus(refundedSales);
    const cashVariance = expected.cashCounted.minus(expected.cashExpected);
    expect(raw.close).not.toBeNull();
    eqMoney(raw.close!.grossSales, expected.grossSales);
    eqMoney(raw.close!.netSales, netSales);
    eqMoney(raw.close!.taxTotal, expected.taxTotal);
    eqMoney(raw.close!.serviceChargeTotal, expected.serviceChargeTotal);
    eqMoney(raw.close!.tipTotal, expected.tipTotal);
    eqMoney(raw.close!.compTotal, expected.compTotal);
    eqMoney(raw.close!.discountTotal, '0');
    eqMoney(raw.close!.discountTotal, expected.discountTotal);
    eqMoney(raw.close!.refundTotal, expected.refundTotal);
    eqMoney(raw.close!.voidTotal, expected.voidTotal);
    eqMoney(raw.close!.cashExpected, expected.cashExpected);
    eqMoney(raw.close!.cashCounted, expected.cashCounted);
    eqMoney(raw.close!.cashVariance, cashVariance);

    const tenderAggregates = new Map<
      string,
      { amount: Prisma.Decimal; tipAmount: Prisma.Decimal; count: number }
    >();
    for (const tenderRow of raw.tenders) {
      const current = tenderAggregates.get(tenderRow.type) ?? {
        amount: D('0'),
        tipAmount: D('0'),
        count: 0,
      };
      tenderAggregates.set(tenderRow.type, {
        amount: current.amount.plus(tenderRow.amount),
        tipAmount: current.tipAmount.plus(tenderRow.tipAmount),
        count: current.count + 1,
      });
    }
    expect(raw.close!.tenderTotals).toHaveLength(tenderAggregates.size);
    for (const [tenderType, aggregate] of tenderAggregates) {
      const child = raw.close!.tenderTotals.find((row) => row.tenderType === tenderType);
      expect(child).toBeTruthy();
      eqMoney(child!.amount, aggregate.amount);
      eqMoney(child!.tipAmount, aggregate.tipAmount);
      expect(child!.count).toBe(aggregate.count);
    }
  }, 60_000);
});
