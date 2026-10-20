/** Reserved-slot proof, intentionally separate from source tests. Requires composed schema
 * and an explicitly disposable LOCAL database. No mocks; no schema application here.
 * Fixture rows remain until the coordinator disposes the entire test database.
 */
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { CateringMoneyInput, CateringMoneyScope } from './catering-money';

const url = process.env.TEST_DATABASE_URL;
// Skipped, never silently passed, without a database; the slot guard below still applies.
const describeIfDatabase = url ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const orgA = `cm_org_a_${suffix}`,
  orgB = `cm_org_b_${suffix}`;
const branchA = `cm_branch_a_${suffix}`,
  branchA2 = `cm_branch_a2_${suffix}`,
  branchB = `cm_branch_b_${suffix}`;
const staffA = `cm_staff_a_${suffix}`,
  staffB = `cm_staff_b_${suffix}`;
const deviceA = `cm_device_a_${suffix}`,
  deviceA2 = `cm_device_a2_${suffix}`,
  deviceB = `cm_device_b_${suffix}`;
const drawerA = `cm_drawer_${suffix}`;
const authorization = {
  actorStaffProfileId: staffA,
  actorBranchIds: [branchA],
  organizationWide: false,
  branchIds: [branchA],
};
const scope: CateringMoneyScope = {
  organizationId: orgA,
  branchId: branchA,
  staffProfileId: staffA,
  deviceId: deviceA,
  authorization,
};
let client: pg.Client;
let tenant: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let record: (typeof import('./catering-money'))['recordCateringMoneyEvidence'];
let closePreview: (typeof import('./daily-close'))['closePreview'];
let fold: (typeof import('./drawer-sessions'))['foldExpectedCash'];

const key = () => randomUUID();
const inTenant = <T>(work: (tx: ScopedDb) => Promise<T>) => tenant(orgA, work);
async function newOrder(branch = branchA, org = orgA) {
  const order = `cm_order_${key()}`,
    quote = `cm_quote_${key()}`;
  await tenant(org, async (tx) => {
    await tx.restaurantCateringOrder.create({
      data: {
        id: order,
        branchId: branch,
        eventName: 'Evidence proof',
        eventDate: new Date(),
        headcount: 1,
        quotedTotal: '100',
        depositAmount: '70',
      },
    });
    const snapshot = JSON.stringify({ schemaVersion: 1, currency: 'PKR', quotedTotal: '100.00' });
    const hash = createHash('sha256').update(snapshot).digest('hex');
    await tx.$executeRaw`INSERT INTO restaurant_catering_quote_revisions
      (id,"organizationId","orderId",revision,snapshot,"contentHash","createdByStaffId")
      VALUES (${quote},${org},${order},0,${snapshot}::jsonb,${hash},${org === orgA ? staffA : staffB})`;
    await tx.$executeRaw`INSERT INTO restaurant_catering_quote_approvals
      (id,"organizationId","orderId","quoteRevisionId","orderRevision","actorStaffProfileId")
      VALUES (${key()},${org},${order},${quote},0,${org === orgA ? staffA : staffB})`;
    await tx.$executeRaw`UPDATE restaurant_catering_orders SET "approvedQuoteRevisionId"=${quote} WHERE id=${order}`;
  });
  return { cateringOrderId: order, quoteRevisionId: quote };
}
function command(
  order: { cateringOrderId: string; quoteRevisionId: string },
  amount = '60'
): CateringMoneyInput {
  return {
    ...order,
    kind: 'DEPOSIT',
    amount,
    currency: 'PKR',
    source: 'CASH',
    drawerSessionId: drawerA,
    idempotencyKey: key(),
  };
}
const submit = (input: CateringMoneyInput, trusted = scope) =>
  tenant(trusted.organizationId, (tx) => record(tx, trusted, input));
async function counts() {
  return inTenant(async (tx) => ({
    evidence: await tx.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) FROM restaurant_catering_money_evidence`,
    movements: await tx.restaurantDrawerMovement.count(),
    audit: await tx.auditLog.count(),
    keys: await tx.restaurantMoneyIdempotencyKey.count(),
    tenders: await tx.restaurantTender.count(),
    payments: await tx.restaurantPayment.count(),
    bills: await tx.restaurantBill.count(),
    stock: await tx.restaurantStockMovement.count(),
  }));
}

describeIfDatabase('catering evidence: restricted PostgreSQL acceptance', () => {
  beforeAll(async () => {
    if (!url || process.env.CATERING_MONEY_DB_SLOT !== 'reserved')
      throw new Error(
        'Requires TEST_DATABASE_URL and CATERING_MONEY_DB_SLOT=reserved; do not start a listener from this test.'
      );
    const target = new URL(url);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
      !/(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i.test(target.pathname.slice(1))
    ) {
      throw new Error(
        'Requires a named disposable local database; preview/staging/production are forbidden.'
      );
    }
    process.env.DATABASE_URL = url;
    process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    client = new pg.Client({ connectionString: url });
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const rls = await client.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='restaurant_catering_money_evidence'::regclass"
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    await client.query("SELECT set_config('app.is_platform_admin','true',false)");
    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName","updatedAt") VALUES ($1,$1,$1,$1,now()),($2,$2,$2,$2,now())`,
      [orgA, orgB]
    );
    await client.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,timezone,"businessDayCutoff","updatedAt") VALUES
      ($1,$4,'A','UTC','00:00',now()),($2,$4,'A2','UTC','00:00',now()),($3,$5,'B','UTC','00:00',now())`,
      [branchA, branchA2, branchB, orgA, orgB]
    );
    await client.query(
      `INSERT INTO restaurant_staff_profiles (id,"organizationId","displayName","primaryBranchId","updatedAt") VALUES
      ($1,$3,'A',$5,now()),($2,$4,'B',$6,now())`,
      [staffA, staffB, orgA, orgB, branchA, branchB]
    );
    for (const [id, branch, org] of [
      [deviceA, branchA, orgA],
      [deviceA2, branchA2, orgA],
      [deviceB, branchB, orgB],
    ]) {
      await client.query(
        `INSERT INTO restaurant_registered_devices (id,"organizationId","branchId",name,"deviceSecretHash","updatedAt") VALUES ($1,$2,$3,$1,$1,now())`,
        [id, org, branch]
      );
    }
    for (const capability of ['catering:manage', 'cash:adjust', 'payments:refund']) {
      await client.query(
        `INSERT INTO restaurant_staff_capability_grants (id,"organizationId","staffProfileId","branchId",capability,effect,"updatedAt") VALUES ($1,$2,$3,$4,$5,'ALLOW',now())`,
        [key(), orgA, staffA, branchA, capability]
      );
    }
    await client.query("SELECT set_config('app.is_platform_admin','false',false)");
    ({ withTenantDb: tenant } = await import('@/lib/tenancy/scoped-db'));
    ({ recordCateringMoneyEvidence: record } = await import('./catering-money'));
    ({ closePreview } = await import('./daily-close'));
    ({ foldExpectedCash: fold } = await import('./drawer-sessions'));
    await inTenant(async (tx) => {
      await tx.restaurantDrawerSession.create({
        data: {
          id: drawerA,
          branchId: branchA,
          deviceId: deviceA,
          staffProfileId: staffA,
          businessDate: new Date(new Date().toISOString().slice(0, 10)),
          openingFloat: '0',
        },
      });
    });
  }, 30_000);
  afterAll(async () => {
    if (client) await client.end();
  });

  it('serializes concurrent overpayment and original-receipt refund limits', async () => {
    const order = await newOrder();
    const results = await Promise.allSettled([submit(command(order)), submit(command(order))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const first = results.find((r) => r.status === 'fulfilled');
    if (!first || first.status !== 'fulfilled') throw new Error('Expected receipt');
    const refund = {
      ...command(order, '40'),
      kind: 'REFUND' as const,
      originalEvidenceId: first.value.evidenceId,
    };
    const refunds = await Promise.allSettled([
      submit(refund),
      submit({ ...refund, idempotencyKey: key() }),
    ]);
    expect(refunds.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refunds.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('replays identical payload; conflicts on changed payload without another cash movement', async () => {
    const input = command(await newOrder(), '28');
    const original = await submit(input);
    const before = await counts();
    expect(await submit({ ...input, amount: '28.00' })).toEqual({ ...original, replayed: true });
    await expect(submit({ ...input, amount: '29' })).rejects.toThrow(
      'different canonical money payload'
    );
    expect(await counts()).toEqual(before);
  });
  it('rolls back evidence, drawer, audit and completed key on a late caller failure', async () => {
    const input = command(await newOrder(), '28');
    const before = await counts();
    await expect(
      inTenant(async (tx) => {
        await record(tx, scope, input);
        throw new Error('late failure');
      })
    ).rejects.toThrow('late failure');
    expect(await counts()).toEqual(before);
    expect((await submit(input)).replayed).toBe(false);
  });
  it('denies cross-tenant/branch/device/currency and revoked capabilities', async () => {
    const own = command(await newOrder(), '1');
    await expect(submit(command(await newOrder(branchB, orgB), '1'))).rejects.toThrow(
      'ORDER_NOT_FOUND'
    );
    await expect(submit(command(await newOrder(branchA2), '1'))).rejects.toThrow('ORDER_NOT_FOUND');
    await expect(submit(own, { ...scope, deviceId: deviceA2 })).rejects.toThrow(
      'ACTOR_OR_DEVICE_DENIED'
    );
    await expect(submit(own, { ...scope, deviceId: deviceB })).rejects.toThrow(
      'ACTOR_OR_DEVICE_DENIED'
    );
    await expect(submit({ ...own, currency: 'USD' })).rejects.toThrow('CURRENCY_MISMATCH');
    await inTenant((tx) =>
      tx.restaurantStaffCapabilityGrant.updateMany({
        where: { staffProfileId: staffA, capability: 'catering:manage' },
        data: { effect: 'DENY' },
      })
    );
    await expect(submit(own)).rejects.toThrow('CAPABILITY_DENIED');
    await inTenant((tx) =>
      tx.restaurantStaffCapabilityGrant.updateMany({
        where: { staffProfileId: staffA, capability: 'catering:manage' },
        data: { effect: 'ALLOW' },
      })
    );
    await expect(
      submit(own, { ...scope, authorization: { ...authorization, branchIds: [] } })
    ).rejects.toThrow();
  });
  it('rejects stale approval, unavailable drawers, and mismatched refund originals', async () => {
    const order = await newOrder();
    const input = command(order, '10');
    const receipt = await submit(input);
    await expect(
      submit({
        ...command(await newOrder(), '1'),
        kind: 'REFUND',
        originalEvidenceId: receipt.evidenceId,
      })
    ).rejects.toThrow('ORIGINAL_MISMATCH');
    await inTenant(
      (tx) =>
        tx.$executeRaw`UPDATE restaurant_catering_orders SET revision=revision+1 WHERE id=${order.cateringOrderId}`
    );
    await expect(submit({ ...input, idempotencyKey: key() })).rejects.toThrow(
      'STALE_OR_UNAPPROVED_QUOTE'
    );
    // Exact replay is historical evidence and remains valid after an edit.
    expect((await submit(input)).replayed).toBe(true);
    await expect(
      submit({ ...command(await newOrder(), '1'), drawerSessionId: 'missing' })
    ).rejects.toThrow('DRAWER_DENIED');
  });
  it.each(['CANCELLED', 'CLOSED'] as const)(
    'rejects terminal %s receipts atomically and preserves replay',
    async (status) => {
      const order = await newOrder();
      const input = command(order, '28');
      const receipt = await submit(input);
      await inTenant((tx) =>
        tx.restaurantCateringOrder.update({
          where: { id: order.cateringOrderId },
          data: { status },
        })
      );
      const before = await counts();
      for (const kind of ['DEPOSIT', 'BALANCE'] as const) {
        await expect(submit({ ...input, kind, idempotencyKey: key() })).rejects.toThrow(
          'ORDER_NOT_RECEIVABLE'
        );
      }
      expect(await submit(input)).toEqual({ ...receipt, replayed: true });
      expect(await counts()).toEqual(before);
    }
  );
  it.each(['DRAFT', 'CANCELLED'] as const)(
    'refunds revised %s order using original approved quote and exact replay',
    async (status) => {
      const order = await newOrder();
      const input = command(order, '28');
      const receipt = await submit(input);
      await inTenant(async (tx) => {
        await tx.restaurantCateringOrder.update({
          where: { id: order.cateringOrderId },
          data: { status },
        });
        await tx.$executeRaw`UPDATE restaurant_catering_orders SET revision=revision+1,
        "approvedQuoteRevisionId"=NULL WHERE id=${order.cateringOrderId}`;
      });
      const refund: CateringMoneyInput = {
        ...command(order, '8'),
        kind: 'REFUND',
        originalEvidenceId: receipt.evidenceId,
      };
      const result = await submit(refund);
      const before = await counts();
      expect(await submit(refund)).toEqual({ ...result, replayed: true });
      expect(await submit(input)).toEqual({ ...receipt, replayed: true });
      await expect(submit({ ...refund, amount: '20.01', idempotencyKey: key() })).rejects.toThrow(
        'OVER_REFUND'
      );
      await expect(submit({ ...refund, amount: '9' })).rejects.toThrow();
      expect(await counts()).toEqual(before);
      const lineage = await inTenant(
        (tx) => tx.$queryRaw<Array<{ quoteRevisionId: string; originalEvidenceId: string }>>`
      SELECT "quoteRevisionId", "originalEvidenceId" FROM restaurant_catering_money_evidence WHERE id=${result.evidenceId}`
      );
      expect(lineage).toEqual([
        { quoteRevisionId: order.quoteRevisionId, originalEvidenceId: receipt.evidenceId },
      ]);
      const other = await newOrder();
      await expect(
        submit({ ...command(other, '1'), kind: 'REFUND', originalEvidenceId: receipt.evidenceId })
      ).rejects.toThrow('ORIGINAL_MISMATCH');
      // Historical revision without an approval must never authorize a refund.
      const unapproved = key();
      await inTenant(
        (tx) => tx.$executeRaw`INSERT INTO restaurant_catering_quote_revisions
      (id,"organizationId","orderId",revision,snapshot,"contentHash","createdByStaffId")
      VALUES (${unapproved},${orgA},${order.cateringOrderId},1,
        ${JSON.stringify({ schemaVersion: 1, currency: 'PKR', quotedTotal: '100.00' })}::jsonb,'unapproved',${staffA})`
      );
      await expect(
        submit({ ...refund, quoteRevisionId: unapproved, idempotencyKey: key() })
      ).rejects.toThrow('STALE_OR_UNAPPROVED_QUOTE');
    }
  );
  it('reconciles cash once; adds no settled sales, tender, payment, bill, or stock rows', async () => {
    const order = await newOrder();
    const before = await counts();
    const movementsBefore = await inTenant((tx) =>
      tx.restaurantDrawerMovement.findMany({ where: { drawerSessionId: drawerA } })
    );
    const receipt = await submit(command(order, '28'));
    await submit({
      ...command(order, '8'),
      kind: 'REFUND',
      originalEvidenceId: receipt.evidenceId,
    });
    const movementsAfter = await inTenant((tx) =>
      tx.restaurantDrawerMovement.findMany({ where: { drawerSessionId: drawerA } })
    );
    expect(fold(movementsAfter).minus(fold(movementsBefore)).toFixed(2)).toBe('20.00');
    const after = await counts();
    for (const name of ['tenders', 'payments', 'bills', 'stock'] as const)
      expect(after[name]).toBe(before[name]);
    const preview = await inTenant((tx) =>
      closePreview(tx, { branchId: branchA, businessDate: new Date().toISOString().slice(0, 10) })
    );
    expect(preview.grossSales.toFixed(2)).toBe('0.00');
    expect(preview.netSales.toFixed(2)).toBe('0.00');
  });
  it('records noncash as operator evidence only and enforces tenant RLS/append-only', async () => {
    const input = {
      ...command(await newOrder(), '1'),
      source: 'OPERATOR_ATTESTED' as const,
      drawerSessionId: undefined,
      externalEvidenceSource: 'Bank slip',
      externalEvidenceReference: key(),
    };
    const before = await counts();
    const result = await submit(input);
    expect(result.ledgerReference).toBeNull();
    expect((await counts()).movements).toBe(before.movements);
    const foreign = await tenant(
      orgB,
      (tx) =>
        tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM restaurant_catering_money_evidence WHERE id=${result.evidenceId}`
    );
    expect(foreign).toEqual([]);
    const changed = await inTenant(
      (tx) =>
        tx.$executeRaw`UPDATE restaurant_catering_money_evidence SET amount=2 WHERE id=${result.evidenceId}`
    ).catch(() => 0);
    expect(changed).toBe(0);
    const deleted = await inTenant(
      (tx) =>
        tx.$executeRaw`DELETE FROM restaurant_catering_money_evidence WHERE id=${result.evidenceId}`
    ).catch(() => 0);
    expect(deleted).toBe(0);
    const retained = await inTenant(
      (tx) =>
        tx.$queryRaw<
          Array<{ amount: string }>
        >`SELECT amount::text FROM restaurant_catering_money_evidence WHERE id=${result.evidenceId}`
    );
    expect(retained).toEqual([{ amount: '1.00' }]);
    await expect(
      tenant(
        orgB,
        (tx) => tx.$executeRaw`INSERT INTO restaurant_catering_money_evidence
      (id,"organizationId","branchId","cateringOrderId","quoteRevisionId",kind,amount,currency,source,
       "externalEvidenceSource","externalEvidenceReference","actorStaffProfileId","deviceId","businessDate")
      VALUES (${key()},${orgA},${branchA},${input.cateringOrderId},${input.quoteRevisionId},'DEPOSIT',1,'PKR',
        'OPERATOR_ATTESTED','proof',${key()},${staffA},${deviceA},CURRENT_DATE)`
      )
    ).rejects.toThrow();
  });
});
