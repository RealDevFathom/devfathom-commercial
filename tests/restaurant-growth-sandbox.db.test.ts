// Actual restricted SQL + Prisma/service adapters. Authorization and evidence freshness
// are explicitly TEST_DOUBLE fixtures; this does not prove app/model/semantic acceptance.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';
import type { GrowthActor, RestaurantGrowthBinding } from '../src/lib/restaurant/growth-review';
import { reviewRestaurantGrowth } from '../src/lib/restaurant/growth-review';
import {
  captureRestaurantGrowthDraft,
  stopRestaurantGrowthSandbox,
  diagnoseRestaurantGrowthSandbox,
  type GrowthSandboxAdmission,
} from '../src/lib/restaurant/growth-sandbox';
import {
  assertAcceptanceDatabase,
  readAcceptanceReceipt,
} from '../scripts/restaurant-acceptance-target';

const suite = process.env.RESTAURANT_ACCEPTANCE_ADMITTED === '1' ? describe : describe.skip;
let tenant: (typeof import('../src/lib/tenancy/scoped-db'))['withTenantDb'];
let scoped: (typeof import('../src/lib/tenancy/scoped-db'))['createTenantDb'];
let policy: GrowthSandboxAdmission;
const hash = 'a'.repeat(64);
const binding: RestaurantGrowthBinding = {
  validatePersisted: () => ({
    currency: 'PKR',
    current: { from: '2026-10-01T00:00:00.000Z', cutoff: '2026-10-02T00:00:00.000Z' },
    comparison: { from: '2026-09-30T00:00:00.000Z', cutoff: '2026-10-01T00:00:00.000Z' },
    recommendations: [
      {
        action: 'LOYALTY_REVIEW',
        evidence: [
          {
            key: 'loyalty_eligible_count',
            period: 'CURRENT',
            value: '10',
            unit: 'COUNT',
            coverage: 'COMPLETE',
          },
        ],
      },
    ],
  }),
  evidenceIsCurrent: async () => true,
};
type Scope = { org: string; branch: string; insight: string; customers: string[] };
const pids = new Set<number>();

function actor(scope: Scope, failSecondAttempt = false): GrowthActor {
  const db = scoped(scope.org, 'TEST_DOUBLE');
  return {
    ctx: {
      organizationId: scope.org,
      userId: 'TEST_DOUBLE',
      role: 'OWNER',
      vertical: 'RESTAURANT',
      enabledModules: ['restaurant-core', 'restaurant-pos'],
    },
    can: async () => true,
    db: new Proxy(db, {
      get(target, property) {
        if (property !== '$transaction') return Reflect.get(target, property);
        return (work: (tx: ScopedDb) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            // Exercise mixed timestamp storage independently of the server's default zone.
            await tx.$queryRawUnsafe("SELECT set_config('TimeZone','Asia/Karachi',true)");
            const identity = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
              'SELECT pg_backend_pid() AS pid'
            );
            pids.add(identity[0]!.pid);
            let writes = 0;
            return work(
              new Proxy(tx as ScopedDb, {
                get(inner, key) {
                  if (key !== '$executeRawUnsafe') return Reflect.get(inner, key);
                  return (sql: string, ...values: unknown[]) => {
                    if (
                      sql.includes('INSERT INTO restaurant_growth_attempts') &&
                      ++writes === 2 &&
                      failSecondAttempt
                    )
                      throw new Error('TEST_FAULT after first real attempt insert');
                    return inner.$executeRawUnsafe(sql, ...values);
                  };
                },
              })
            );
          });
      },
    }),
  } as unknown as GrowthActor;
}

async function inScope<T>(s: Scope, work: (tx: ScopedDb) => Promise<T>) {
  return tenant(s.org, async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.current_branch_id',$1,true)", s.branch);
    return work(tx);
  });
}
async function fixture(): Promise<Scope> {
  const s = {
    org: 'sandbox_' + randomUUID(),
    branch: randomUUID(),
    insight: randomUUID(),
    customers: [randomUUID(), randomUUID(), randomUUID()].sort(),
  };
  await inScope(s, async (tx) => {
    await tx.organization.create({
      data: {
        id: s.org,
        slug: s.org,
        legalName: 'Synthetic sandbox',
        displayName: 'Synthetic sandbox',
        vertical: 'RESTAURANT',
      },
    });
    await tx.restaurantBranch.create({
      data: {
        id: s.branch,
        name: 'Synthetic sandbox',
        timezone: 'UTC',
        businessDayCutoff: '00:00',
      },
    });
    for (const customer of s.customers) {
      await tx.restaurantCustomer.create({
        data: { id: customer, displayName: 'Synthetic participant' },
      });
      await tx.loyaltyAccount.create({ data: { customerId: customer } });
      await tx.customerConsent.create({
        data: {
          customerId: customer,
          channel: 'WHATSAPP',
          granted: true,
          source: 'TEST_SANDBOX_FIXTURE',
          actorId: 'TEST_DOUBLE',
          policyVersion: policy.policyVersion,
          idempotencyKey: randomUUID(),
        },
      });
      await tx.$executeRawUnsafe(
        'INSERT INTO restaurant_growth_fixtures ("organizationId","branchId","customerId") VALUES ($1,$2,$3)',
        s.org,
        s.branch,
        customer
      );
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO growth_insights (id,"organizationId","branchId",vertical,"actorId","schemaVersion","inputHash",status,provider,model,snapshot,output) VALUES ($1,$2,$3,'RESTAURANT','TEST_DOUBLE',1,$4,'READY','TEST_DOUBLE','TEST_DOUBLE','{"actions":[{"ref":"a1","kind":"LOYALTY_REVIEW"}]}','{"recommendations":[{"actionRef":"a1"}]}')`,
      s.insight,
      s.org,
      s.branch,
      hash
    );
  });
  return s;
}
const review = (s: Scope, revision: number, decision: string) => ({
  branchId: s.branch,
  insightId: s.insight,
  recommendation: 0,
  expectedHash: hash,
  expectedVersion: 1,
  expectedRevision: revision,
  requestId: randomUUID(),
  decision,
  settings: { priority: 'HIGH', objective: 'REVIEW_RETENTION' },
});
async function draft(s: Scope) {
  await reviewRestaurantGrowth(actor(s), review(s, 0, 'EDIT'), binding);
  const result = await reviewRestaurantGrowth(actor(s), review(s, 1, 'APPROVE'), binding);
  if (!result.draftId) throw new Error('Expected one actual inert draft');
  return {
    branchId: s.branch,
    draftId: result.draftId,
    requestId: randomUUID(),
    cutoff: new Date(Date.now() - 1000).toISOString(),
  };
}
const attempts = (s: Scope) =>
  inScope(s, (tx) =>
    tx.$queryRawUnsafe<Array<{ id: string; customerId: string }>>(
      'SELECT id,"customerId" FROM restaurant_growth_attempts ORDER BY id'
    )
  );

suite('actual sandbox SQL and adapters / TEST_DOUBLE authorization and freshness', () => {
  beforeAll(async () => {
    const receipt = readAcceptanceReceipt();
    assertAcceptanceDatabase(process.env.DATABASE_URL, receipt);
    ({ withTenantDb: tenant, createTenantDb: scoped } =
      await import('../src/lib/tenancy/scoped-db'));
    // No quiet-hour clock fake: use a one-hour quiet interval twelve hours away.
    const hour = new Date().getUTCHours();
    policy = {
      environment: 'TEST_SANDBOX',
      database: receipt.database,
      port: receipt.databasePort,
      policyVersion: 'synthetic-v1',
      timeZone: 'UTC',
      quietStart: (hour + 12) % 24,
      quietEnd: (hour + 13) % 24,
      campaignCap: 2,
      recipientBranchDailyCap: 1,
    };
  });

  it('real edit/approve lineage, campaign cap, exact replay and concurrent serialization', async () => {
    const s = await fixture(),
      input = await draft(s);
    pids.clear();
    const results = await Promise.all([
      captureRestaurantGrowthDraft(actor(s), input, policy, binding),
      captureRestaurantGrowthDraft(actor(s), input, policy, binding),
    ]);
    expect(pids.size).toBe(2);
    expect(results[0]!.attemptIds.slice().sort()).toEqual(results[1]!.attemptIds.slice().sort());
    expect(results.some((r) => 'replayed' in r && r.replayed)).toBe(true);
    expect(await attempts(s)).toHaveLength(2);
    await expect(
      captureRestaurantGrowthDraft(actor(s), { ...input, requestId: randomUUID() }, policy, binding)
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const lineage = await inScope(s, (tx) =>
      tx.$queryRawUnsafe(
        'SELECT revision,decision,settings FROM restaurant_growth_reviews ORDER BY revision'
      )
    );
    expect(lineage).toEqual([
      {
        revision: 1,
        decision: 'EDIT',
        settings: { priority: 'HIGH', objective: 'REVIEW_RETENTION' },
      },
      {
        revision: 2,
        decision: 'APPROVE',
        settings: { priority: 'HIGH', objective: 'REVIEW_RETENTION' },
      },
    ]);
    expect(
      await inScope(s, (tx) => tx.$queryRawUnsafe('SELECT status FROM restaurant_growth_drafts'))
    ).toEqual([{ status: 'DRAFT' }]);
  });

  it.each([' STOP ', 'بند', 'ＳＴＯＰ'])(
    'STOP adapter for %j confirms in English and is replay-safe; withdrawal and daily cap prevent capture',
    async (text) => {
      const s = await fixture(),
        input = await draft(s);
      const stop = {
        branchId: s.branch,
        customerId: s.customers[0]!,
        eventId: randomUUID(),
        text,
      };
      const result = await stopRestaurantGrowthSandbox(actor(s), stop, policy);
      expect(result).toMatchObject({
        customerId: stop.customerId,
        channel: 'WHATSAPP',
        granted: false,
        source: 'TEST_SANDBOX_STOP',
        actorId: 'TEST_DOUBLE',
        policyVersion: policy.policyVersion,
        idempotencyKey: 'restaurant-growth-stop:' + stop.eventId,
        confirmation:
          'You will no longer receive WhatsApp growth messages. Reply START to opt back in.',
      });
      expect(await stopRestaurantGrowthSandbox(actor(s), stop, policy)).toEqual(result);
      await captureRestaurantGrowthDraft(actor(s), input, policy, binding);
      expect((await attempts(s)).map((r) => r.customerId).sort()).toEqual(s.customers.slice(1));
      expect(
        await inScope(s, (tx) =>
          tx.customerConsent.count({ where: { source: 'TEST_SANDBOX_STOP' } })
        )
      ).toBe(1);
      // A separate real insight/draft in this SAME tenant tests the recipient rolling-day cap.
      const second = { ...s, insight: randomUUID() };
      await inScope(s, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO growth_insights (id,"organizationId","branchId",vertical,"actorId","schemaVersion","inputHash",status,provider,model,snapshot,output) VALUES ($1,$2,$3,'RESTAURANT','TEST_DOUBLE',1,$4,'READY','TEST_DOUBLE','TEST_DOUBLE','{"actions":[{"ref":"a1","kind":"LOYALTY_REVIEW"}]}','{"recommendations":[{"actionRef":"a1"}]}')`,
          second.insight,
          s.org,
          s.branch,
          hash
        )
      );
      expect(
        (await captureRestaurantGrowthDraft(actor(second), await draft(second), policy, binding))
          .attemptIds
      ).toEqual([]);
    }
  );

  it('late injected fault rolls back actual inserts and retry commits exactly once', async () => {
    const s = await fixture(),
      input = await draft(s);
    await expect(
      captureRestaurantGrowthDraft(actor(s, true), input, policy, binding)
    ).rejects.toThrow('TEST_FAULT');
    expect(await attempts(s)).toEqual([]);
    expect(
      (await captureRestaurantGrowthDraft(actor(s), input, policy, binding)).attemptIds
    ).toHaveLength(2);
  });

  it('foreign tenant/branch stays hidden; stale binding and rejected review cannot capture', async () => {
    const s = await fixture(),
      input = await draft(s),
      foreign = await fixture();
    await captureRestaurantGrowthDraft(actor(s), input, policy, binding);
    expect(await attempts(foreign)).toEqual([]);
    await expect(
      captureRestaurantGrowthDraft(actor(foreign), input, policy, binding)
    ).rejects.toMatchObject({ code: 'DENIED' });
    await expect(
      captureRestaurantGrowthDraft(actor(s), input, policy, {
        ...binding,
        evidenceIsCurrent: async () => false,
      })
    ).rejects.toMatchObject({ code: 'STALE' });
    await reviewRestaurantGrowth(actor(foreign), review(foreign, 0, 'REJECT'), binding);
    expect(
      await inScope(foreign, (tx) => tx.$queryRawUnsafe('SELECT id FROM restaurant_growth_drafts'))
    ).toEqual([]);
    await expect(
      reviewRestaurantGrowth(actor(foreign), review(foreign, 1, 'APPROVE'), binding)
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('receipt linkage diagnostics read real joins and withhold money and causal attribution', async () => {
    const s = await fixture(),
      input = await draft(s);
    const capture = await captureRestaurantGrowthDraft(actor(s), input, policy, binding);
    const attempt = (await attempts(s)).find((row) => row.id === capture.attemptIds[0])!;
    const staff = randomUUID(),
      device = randomUUID(),
      order = randomUUID(),
      bill = randomUUID();
    await inScope(s, async (tx) => {
      await tx.restaurantStaffProfile.create({
        data: { id: staff, displayName: 'Synthetic operator', primaryBranchId: s.branch },
      });
      await tx.restaurantRegisteredDevice.create({
        data: {
          id: device,
          branchId: s.branch,
          name: 'Synthetic receipt device',
          deviceSecretHash: `TEST_DOUBLE_NOT_A_CREDENTIAL_${device}`,
        },
      });
      await tx.restaurantOrder.create({
        data: {
          id: order,
          branchId: s.branch,
          orderNumber: 1,
          businessDate: new Date(),
          channel: 'TAKEAWAY',
          staffProfileId: staff,
          deviceId: device,
          customerId: attempt.customerId,
        },
      });
      await tx.restaurantBill.create({
        data: {
          id: bill,
          branchId: s.branch,
          orderId: order,
          businessDate: new Date(),
          status: 'SETTLED',
          receiptNumber: 1,
          settledAt: new Date(),
          openerStaffProfileId: staff,
          deviceId: device,
        },
      });
      await tx.$executeRawUnsafe(
        'INSERT INTO restaurant_growth_receipt_events ("organizationId","branchId","attemptId","customerId","billId") VALUES ($1,$2,$3::uuid,$4,$5)',
        s.org,
        s.branch,
        attempt.id,
        attempt.customerId,
        bill
      );
      await tx.$queryRawUnsafe('SELECT pg_sleep(0.01)::text');
    });
    const result = await diagnoseRestaurantGrowthSandbox(
      actor(s),
      { branchId: s.branch, attemptId: attempt.id, cutoff: new Date().toISOString() },
      policy
    );
    const storedCutoff = await inScope(s, (tx) =>
      tx.$queryRawUnsafe<Array<{ epoch: number }>>(
        'SELECT (extract(epoch FROM cutoff)*1000)::float8 AS epoch FROM restaurant_growth_attempts WHERE id=$1::uuid',
        attempt.id
      )
    );
    expect(storedCutoff[0]!.epoch).toBe(Date.parse(input.cutoff));
    expect(result).toMatchObject({
      environment: 'TEST_SANDBOX',
      observational: true,
      evidenceReceiptIds: [bill],
      messageCost: null,
      postedMarginMinor: null,
      settledSalesMinor: null,
    });
    // Synthetic settled receipt is a diagnostic fixture, not acceptance of checkout settlement.
    const foreign = await fixture();
    expect(
      (
        await diagnoseRestaurantGrowthSandbox(
          actor(foreign),
          { branchId: foreign.branch, attemptId: attempt.id, cutoff: new Date().toISOString() },
          policy
        )
      ).evidenceReceiptIds
    ).toEqual([]);
  });
});
