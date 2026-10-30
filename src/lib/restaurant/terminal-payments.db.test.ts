/**
 * WHA-317 — accepted terminal events must have deterministic concurrent replay.
 *
 * Requires the isolated TEST_DATABASE_URL and an unprivileged runtime role. A
 * control transaction locks the bill row while two independent tenant-scoped
 * processTerminalEvent calls start. Before the advisory-lock correction both
 * callers pass the reconciliation pre-check, one later loses a unique-index
 * race and rejects. After it, the loser waits and returns the committed result
 * as a replay, with no duplicate money rows.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { ensureRestaurantTaxProfile } from '@/lib/test-support/restaurant-tax-profile';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgA = `org_wha317_a_${suffix}`;
const orgB = `org_wha317_b_${suffix}`;
const source = `provider_${suffix}`;
const terminalId = `terminal_${suffix}`;
const businessDate = new Date('2026-08-29T00:00:00.000Z');

type Deps = {
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  processTerminalEvent: (typeof import('./terminal-payments'))['processTerminalEvent'];
};

let deps: Deps;

const tenant = {
  a: {
    branchId: `branch_a_${suffix}`,
    staffId: `staff_a_${suffix}`,
    deviceId: `device_a_${suffix}`,
    orderId: `order_a_${suffix}`,
    billId: `bill_a_${suffix}`,
  },
  b: {
    branchId: `branch_b_${suffix}`,
    staffId: `staff_b_${suffix}`,
    deviceId: `device_b_${suffix}`,
    orderId: `order_b_${suffix}`,
    billId: `bill_b_${suffix}`,
  },
};

async function seedTenant(organizationId: string, ctx: (typeof tenant)['a' | 'b']) {
  await deps.withTenantDb(organizationId, async (tx) => {
    await tx.restaurantBranch.create({ data: { id: ctx.branchId, name: ctx.branchId } });
    await ensureRestaurantTaxProfile(tx, organizationId, ctx.branchId);
    await tx.restaurantStaffProfile.create({
      data: {
        id: ctx.staffId,
        displayName: ctx.staffId,
        primaryBranchId: ctx.branchId,
        status: 'ACTIVE',
      },
    });
    await tx.restaurantRegisteredDevice.create({
      data: {
        id: ctx.deviceId,
        branchId: ctx.branchId,
        name: ctx.deviceId,
        deviceSecretHash: randomBytes(32).toString('hex'),
      },
    });
    await tx.restaurantOrder.create({
      data: {
        id: ctx.orderId,
        branchId: ctx.branchId,
        orderNumber: 1,
        businessDate,
        status: 'SERVED',
        channel: 'DINE_IN',
        staffProfileId: ctx.staffId,
        deviceId: ctx.deviceId,
      },
    });
    const product = await tx.restaurantProduct.create({ data: { name: 'Replay test item' } });
    const item = await tx.restaurantOrderItem.create({
      data: {
        orderId: ctx.orderId,
        productId: product.id,
        name: product.name,
        unitPrice: '25.00',
        quantity: 1,
        status: 'SERVED',
      },
    });
    await tx.restaurantBill.create({
      data: {
        id: ctx.billId,
        orderId: ctx.orderId,
        branchId: ctx.branchId,
        businessDate,
        subtotal: '25.00',
        grandTotal: '25.00',
        openerStaffProfileId: ctx.staffId,
        deviceId: ctx.deviceId,
        lines: {
          create: {
            orderItemId: item.id,
            name: item.name,
            quantity: 1,
            unitPrice: '25.00',
            lineSubtotal: '25.00',
            lineTotal: '25.00',
          },
        },
      },
    });
    await tx.restaurantTerminalProviderConfig.create({
      data: {
        branchId: ctx.branchId,
        source,
        externalTerminalId: terminalId,
        deviceId: ctx.deviceId,
        mode: 'WEBHOOK',
      },
    });
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, terminalPayments] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./terminal-payments'),
  ]);
  deps = { ...scopedDb, processTerminalEvent: terminalPayments.processTerminalEvent };

  await assertRlsEnforcingRole(deps.withPlatformDb);
  await deps.withPlatformDb((tx) =>
    tx.organization.createMany({
      data: [
        {
          id: orgA,
          slug: `wha317-a-${suffix}`,
          legalName: 'WHA-317 A',
          displayName: 'WHA-317 A',
          status: 'ACTIVE',
        },
        {
          id: orgB,
          slug: `wha317-b-${suffix}`,
          legalName: 'WHA-317 B',
          displayName: 'WHA-317 B',
          status: 'ACTIVE',
        },
      ],
    })
  );
  await seedTenant(orgA, tenant.a);
  await seedTenant(orgB, tenant.b);
});

describeIfDatabase('terminal payment concurrent replay (real PostgreSQL)', () => {
  it('serializes two connections and returns one application plus one replay', async () => {
    const externalEventId = `event_${suffix}`;
    const input = {
      source,
      externalEventId,
      requiredMode: 'WEBHOOK' as const,
      event: {
        status: 'approved' as const,
        terminalId,
        reference: tenant.a.billId,
        amount: '25.00',
        tipAmount: '4.00',
        staffProfileId: tenant.a.staffId,
        providerReference: `provider_ref_${suffix}`,
      },
    };

    const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    const pending: Promise<unknown>[] = [];
    await blocker.connect();
    try {
      const {
        rows: [{ pid: blockerPid }],
      } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT set_config('app.current_organization_id', $1, true),
                set_config('app.is_platform_admin', 'false', true)`,
        [orgA]
      );
      await blocker.query('SELECT id FROM restaurant_bills WHERE id = $1 FOR UPDATE', [
        tenant.a.billId,
      ]);

      const first = deps.processTerminalEvent(deps.createTenantDb(orgA), input);
      const second = deps.processTerminalEvent(deps.createTenantDb(orgA), input);
      pending.push(first, second);
      let firstSettled = false;
      let secondSettled = false;
      void first.then(
        () => {
          firstSettled = true;
        },
        () => {
          firstSettled = true;
        }
      );
      void second.then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        }
      );
      // Observe the actual blocking chain: one delivery waits for our bill
      // lock, while the duplicate waits for that delivery's advisory lock.
      // Unsettled promises alone could still be waiting to acquire connections.
      await expect
        .poll(
          async () => {
            const { rows } = await blocker.query<{ waiting: boolean }>(
              `SELECT EXISTS (
                 SELECT 1 FROM pg_locks applying
                 JOIN pg_locks replay
                   ON replay.locktype = applying.locktype
                  AND replay.database = applying.database
                  AND replay.classid = applying.classid
                  AND replay.objid = applying.objid
                  AND replay.objsubid = applying.objsubid
                 WHERE applying.locktype = 'advisory' AND applying.granted
                   AND NOT replay.granted
                   AND $1::int = ANY(pg_blocking_pids(applying.pid))
                   AND applying.pid = ANY(pg_blocking_pids(replay.pid))
                   AND applying.pid <> replay.pid
               ) AS waiting`,
              [blockerPid]
            );
            return rows[0]?.waiting;
          },
          { timeout: 5_000, interval: 20 }
        )
        .toBe(true);

      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      await blocker.query('COMMIT');

      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(results[0].reconciliation.id).toBe(results[1].reconciliation.id);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await Promise.allSettled(pending);
      await blocker.end();
    }

    const state = await deps.withTenantDb(orgA, async (tx) => ({
      tenders: await tx.restaurantTender.findMany({ where: { billId: tenant.a.billId } }),
      payments: await tx.restaurantPayment.findMany({ where: { billId: tenant.a.billId } }),
      events: await tx.restaurantPaymentEvent.findMany({
        where: { payment: { billId: tenant.a.billId } },
      }),
      reconciliations: await tx.restaurantTerminalReconciliation.findMany({
        where: { source, externalEventId },
      }),
      moneyKeys: await tx.restaurantMoneyIdempotencyKey.findMany({
        where: { deviceId: tenant.a.deviceId, key: `terminal:${externalEventId}` },
      }),
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: tenant.a.billId } }),
    }));

    expect(state.tenders).toHaveLength(1);
    expect(state.tenders[0]).toMatchObject({ type: 'CARD', billId: tenant.a.billId });
    expect(state.tenders[0]!.amount.toFixed(2)).toBe('25.00');
    expect(state.tenders[0]!.tipAmount.toFixed(2)).toBe('4.00');
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0]!.amount.toFixed(2)).toBe('25.00');
    expect(state.payments[0]!.tipAmount.toFixed(2)).toBe('4.00');
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.amount?.toFixed(2)).toBe('25.00');
    expect(state.reconciliations).toHaveLength(1);
    expect(state.reconciliations[0]).toMatchObject({ outcome: 'APPLIED' });
    expect(state.reconciliations[0]!.amount.toFixed(2)).toBe('25.00');
    expect(state.reconciliations[0]!.tipAmount.toFixed(2)).toBe('4.00');
    expect(state.moneyKeys).toHaveLength(1);
    expect(state.moneyKeys[0]).toMatchObject({
      commandType: 'tender.card',
      resultRef: state.tenders[0]!.id,
      completedAt: expect.any(Date),
    });
    expect(state.moneyKeys[0]!.canonicalPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.bill).toMatchObject({ status: 'SETTLED' });
    expect(state.bill.receiptNumber).toEqual(expect.any(Number));

    // Prove the persisted principal settles exactly and the customer debit
    // (bill plus tip) equals the provider credit without floating-point math.
    const remainingDue = state.tenders.reduce(
      (remaining, tender) => remaining.minus(tender.amount),
      state.bill.grandTotal
    );
    const customerDebit = state.bill.grandTotal.plus(state.tenders[0]!.tipAmount);
    const providerCredit = state.payments[0]!.amount.plus(state.payments[0]!.tipAmount);
    expect(remainingDue.toFixed(2)).toBe('0.00');
    expect(customerDebit.toFixed(2)).toBe('29.00');
    expect(providerCredit.equals(customerDebit)).toBe(true);

    const sequential = await deps.processTerminalEvent(deps.createTenantDb(orgA), input);
    expect(sequential).toMatchObject({ replayed: true });
    expect(sequential.reconciliation.id).toBe(state.reconciliations[0]!.id);
  }, 15_000);

  it('rejects an event whose bill and operator belong to another tenant', async () => {
    const externalEventId = `cross_tenant_${suffix}`;
    const result = await deps.processTerminalEvent(deps.createTenantDb(orgB), {
      source,
      externalEventId,
      requiredMode: 'WEBHOOK',
      event: {
        status: 'approved',
        terminalId,
        reference: tenant.a.billId,
        amount: '25.00',
        staffProfileId: tenant.a.staffId,
        providerReference: `cross_ref_${suffix}`,
      },
    });

    expect(result).toMatchObject({ replayed: false });
    expect(result.reconciliation).toMatchObject({
      outcome: 'REJECTED',
      failureReason: 'BILL_NOT_OPEN_OR_BRANCH_MISMATCH',
      billId: null,
    });
    await deps.withTenantDb(orgB, async (tx) => {
      expect(await tx.restaurantTender.count()).toBe(0);
      expect(await tx.restaurantPayment.count()).toBe(0);
      expect(await tx.restaurantPaymentEvent.count()).toBe(0);
      expect(await tx.restaurantMoneyIdempotencyKey.count()).toBe(0);
      expect(
        await tx.restaurantTerminalReconciliation.count({ where: { source, externalEventId } })
      ).toBe(1);
    });
  });
});
