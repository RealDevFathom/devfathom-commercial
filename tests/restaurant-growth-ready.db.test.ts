// Real restricted PostgreSQL, production reader/generator/persistence/binding/review.
// Only the provider transport/config is a deterministic model double; never app configuration.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const modelDouble = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@/lib/ai/provider', () => ({
  readAIConfig: () => ({ provider: 'TEST_DOUBLE', model: 'DETERMINISTIC_CATERING_TOKENS' }),
  readAIAvailability: () => ({ available: true }),
  createAIModel: () => ({ model: {} }),
}));
vi.mock('ai', async () => ({
  ...(await vi.importActual('ai')),
  generateText: modelDouble.generate,
}));
import { withTenantDb, createTenantDb } from '@/lib/tenancy/scoped-db';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { generateRestaurantGrowth } from '@/lib/restaurant/growth-generation';
import {
  readRestaurantGrowthReview,
  reviewRestaurantGrowth,
  type GrowthActor,
} from '@/lib/restaurant/growth-review';
import { restaurantGrowthBinding } from '@/lib/restaurant/growth-binding';
import {
  lockRestaurantGrowthSource,
  readRestaurantGrowthSource,
} from '@/lib/restaurant/growth-source';
import { anonymizeCustomer } from '@/lib/restaurant/customer-privacy';
import { appendCustomerConsent } from '@/lib/restaurant/customers';
import { payloadHash, lockOrder } from '@/lib/restaurant/catering-operations';
import {
  assertAcceptanceDatabase,
  readAcceptanceReceipt,
} from '../scripts/restaurant-acceptance-target';
const suite = process.env.RESTAURANT_ACCEPTANCE_ADMITTED === '1' ? describe : describe.skip;
const output = {
  recommendations: [
    {
      actionRef: 'a1',
      evidenceRefs: ['e1'],
      hypothesis: 'REVIEW_CATERING',
      limitations: ['OBSERVATIONAL'],
    },
  ],
};
type Scope = { org: string; branch: string; staff: string; customers: string[]; orders: string[] };
const request = (s: Scope) => ({
  branchId: s.branch,
  from: '2026-10-01',
  to: '2026-10-01',
  requestId: randomUUID(),
});
function actor(s: Scope): GrowthActor {
  return {
    db: createTenantDb(s.org, 'synthetic-manager'),
    ctx: {
      organizationId: s.org,
      userId: 'synthetic-manager',
      role: 'OWNER',
      vertical: 'RESTAURANT',
      enabledModules: ['restaurant-core', 'restaurant-pos'],
    },
    can: async () => true,
  } as unknown as GrowthActor;
}
const scoped = <T>(s: Scope, work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(s.org, async (db) => {
    await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id',$1,true)", s.branch);
    return work(db);
  });
async function fixture(count = 10, existingOrg?: string): Promise<Scope> {
  const s: Scope = {
    org: existingOrg ?? 'growth_ready_' + randomUUID(),
    branch: randomUUID(),
    staff: randomUUID(),
    customers: [],
    orders: [],
  };
  await scoped(s, async (db) => {
    const identity = await db.$queryRawUnsafe<
      Array<{ rolsuper: boolean; rolbypassrls: boolean; role: string; port: number }>
    >(
      'SELECT rolsuper,rolbypassrls,current_user AS role,inet_server_port() AS port FROM pg_roles WHERE rolname=current_user'
    );
    expect(identity).toEqual([
      { rolsuper: false, rolbypassrls: false, role: 'restaurant_acceptance_runtime', port: 55683 },
    ]);
    if (!existingOrg)
      await db.organization.create({
        data: {
          id: s.org,
          slug: s.org,
          legalName: 'Synthetic Growth',
          displayName: 'Synthetic Growth',
          vertical: 'RESTAURANT',
          currency: 'PKR',
        },
      });
    await db.restaurantBranch.create({
      data: {
        id: s.branch,
        name: 'Synthetic Growth diagnostic',
        timezone: 'UTC',
        businessDayCutoff: '00:00',
      },
    });
    await db.restaurantStaffProfile.create({
      data: { id: s.staff, primaryBranchId: s.branch, displayName: 'Synthetic fixture manager' },
    });
    for (let i = 0; i < count; i++) {
      const customer = randomUUID(),
        order = randomUUID(),
        quote = randomUUID();
      s.customers.push(customer);
      s.orders.push(order);
      await db.restaurantCustomer.create({ data: { id: customer } });
      await db.restaurantCateringOrder.create({
        data: {
          id: order,
          customerId: customer,
          branchId: s.branch,
          eventName: 'Synthetic recorded booking',
          eventDate: new Date('2026-10-01T00:00:00Z'),
          headcount: 1,
          status: 'CONFIRMED',
        },
      });
      const snapshot = { schemaVersion: 1, currency: 'PKR', quotedTotal: '100', headcount: 1 };
      await db.restaurantCateringQuoteRevision.create({
        data: {
          id: quote,
          orderId: order,
          revision: 0,
          snapshot,
          contentHash: payloadHash(snapshot),
          createdByStaffId: s.staff,
        },
      });
      await db.restaurantCateringQuoteApproval.create({
        data: {
          id: randomUUID(),
          orderId: order,
          quoteRevisionId: quote,
          orderRevision: 0,
          actorStaffProfileId: s.staff,
        },
      });
      await db.restaurantCateringOrder.update({
        where: { id: order },
        data: { approvedQuoteRevisionId: quote, confirmedQuoteRevisionId: quote },
      });
      await db.restaurantCateringEvent.create({
        data: {
          orderId: order,
          sequence: 1,
          eventType: 'STATUS_TRANSITIONED',
          actorStaffProfileId: s.staff,
          payload: { from: 'QUOTED', to: 'CONFIRMED' },
        },
      });
    }
  });
  return s;
}
async function ready(s: Scope) {
  const h = actor(s),
    generated = await generateRestaurantGrowth(h, request(s));
  expect(generated.status).toBe('READY');
  const read = () =>
    readRestaurantGrowthReview(
      h,
      { branchId: s.branch, insightId: generated.insightId },
      restaurantGrowthBinding(h)
    );
  const view = await read();
  expect(view.status).toBe('READY');
  if (view.status !== 'READY') throw Error('READY required');
  const review = {
    branchId: s.branch,
    insightId: generated.insightId,
    recommendation: 0,
    expectedHash: view.hash,
    expectedVersion: 1 as const,
    expectedRevision: 0,
    requestId: randomUUID(),
    decision: 'EDIT' as const,
    settings: { priority: 'HIGH' as const, objective: 'REVIEW_DEMAND' as const },
  };
  return { h, generated, read, view, review };
}
suite('composed Restaurant READY with deterministic model transport', () => {
  beforeAll(() => assertAcceptanceDatabase(process.env.DATABASE_URL, readAcceptanceReceipt()));
  beforeEach(() => {
    modelDouble.generate.mockReset();
    modelDouble.generate.mockResolvedValue({ output, finishReason: 'stop' });
  });
  it('real exact 9/10 threshold and incomplete source withhold before model', async () => {
    const s = await fixture(9);
    expect((await generateRestaurantGrowth(actor(s), request(s))).status).toBe('INSUFFICIENT_DATA');
    expect(modelDouble.generate).not.toHaveBeenCalled();
    const ten = await fixture(10);
    await ready(ten);
    await scoped(ten, (db) =>
      db.restaurantCateringOrder.update({
        where: { id: ten.orders[0] },
        data: { confirmedQuoteRevisionId: null },
      })
    );
    expect((await generateRestaurantGrowth(actor(ten), request(ten))).status).toBe(
      'INSUFFICIENT_DATA'
    );
  });
  it('full production JSONB roundtrip, unchanged reread, edit, replay, approval and inert SQL draft', async () => {
    const s = await fixture(),
      r = await ready(s);
    expect((await r.read()).status).toBe('READY');
    expect((await r.read()).status).toBe('READY');
    const binding = restaurantGrowthBinding(r.h);
    const edited = await reviewRestaurantGrowth(r.h, r.review, binding);
    expect(await reviewRestaurantGrowth(r.h, r.review, binding)).toEqual(edited);
    const approve = {
      ...r.review,
      decision: 'APPROVE' as const,
      expectedRevision: 1,
      requestId: randomUUID(),
    };
    const final = await reviewRestaurantGrowth(r.h, approve, binding);
    expect(await reviewRestaurantGrowth(r.h, approve, binding)).toEqual(final);
    await scoped(s, async (db) => {
      const drafts = await db.$queryRawUnsafe<
        Array<{ status: string; action: string; settings: unknown }>
      >(
        'SELECT status,action,settings FROM restaurant_growth_drafts WHERE "insightId"=$1',
        r.generated.insightId
      );
      expect(drafts).toEqual([
        { status: 'DRAFT', action: 'CATERING_REVIEW', settings: r.review.settings },
      ]);
      const rows = await db.$queryRawUnsafe<
        Array<{
          snapshot: { _restaurant: { version: string }; actions: unknown[] };
          provider: string;
          model: string;
        }>
      >('SELECT snapshot,provider,model FROM growth_insights WHERE id=$1', r.generated.insightId);
      expect(rows[0].snapshot._restaurant.version).toBe('restaurant-growth-v2');
      expect(rows[0].provider).toBe('TEST_DOUBLE');
      expect(rows[0].snapshot.actions).toHaveLength(1);
    });
  });
  it('equal-valued customer replacement stales saved source despite identical fact count', async () => {
    const s = await fixture(),
      r = await ready(s);
    const before = await scoped(s, (db) =>
      readRestaurantGrowthSource(
        { ...r.h, db },
        { branchId: s.branch, from: '2026-10-01', to: '2026-10-01' }
      )
    );
    await scoped(s, async (db) => {
      const customer = await db.restaurantCustomer.create({ data: {} });
      await db.restaurantCateringOrder.update({
        where: { id: s.orders[0] },
        data: { customerId: customer.id },
      });
    });
    const after = await scoped(s, (db) =>
      readRestaurantGrowthSource(
        { ...r.h, db },
        { branchId: s.branch, from: '2026-10-01', to: '2026-10-01' }
      )
    );
    expect(after.input.facts[0].value).toBe(before.input.facts[0].value);
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect((await r.read()).status).toBe('STALE');
    await expect(
      reviewRestaurantGrowth(
        r.h,
        { ...r.review, decision: 'APPROVE' },
        restaurantGrowthBinding(r.h)
      )
    ).rejects.toMatchObject({ code: 'STALE' });
  });
  it('anonymization, cancellations and currency changes each invalidate exact lineage', async () => {
    for (const change of ['anonymous', 'cancelled', 'currency']) {
      const s = await fixture(),
        r = await ready(s);
      await scoped(s, async (db) => {
        if (change === 'anonymous') await anonymizeCustomer(db, { customerId: s.customers[0] });
        if (change === 'cancelled')
          await db.restaurantCateringOrder.update({
            where: { id: s.orders[0] },
            data: { status: 'CANCELLED' },
          });
        if (change === 'currency')
          await db.organization.update({ where: { id: s.org }, data: { currency: 'USD' } });
      });
      expect((await r.read()).status).toBe('STALE');
    }
  });
  it('duplicate customer denominator and null linkage withhold whole recorded count', async () => {
    const s = await fixture();
    await scoped(s, (db) =>
      db.restaurantCateringOrder.update({
        where: { id: s.orders[0] },
        data: { customerId: s.customers[1] },
      })
    );
    expect((await generateRestaurantGrowth(actor(s), request(s))).status).toBe('INSUFFICIENT_DATA');
    await scoped(s, (db) =>
      db.restaurantCateringOrder.update({ where: { id: s.orders[0] }, data: { customerId: null } })
    );
    expect((await generateRestaurantGrowth(actor(s), request(s))).status).toBe('INSUFFICIENT_DATA');
    expect(modelDouble.generate).not.toHaveBeenCalled();
  });
  it('concurrent same request generates once, two final decisions yield only one inert draft', async () => {
    const s = await fixture(),
      h = actor(s),
      input = request(s);
    const results = await Promise.all([
      generateRestaurantGrowth(h, input),
      generateRestaurantGrowth(h, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(modelDouble.generate).toHaveBeenCalledTimes(1);
    const view = await readRestaurantGrowthReview(
      h,
      { branchId: s.branch, insightId: results[0].insightId },
      restaurantGrowthBinding(h)
    );
    if (view.status !== 'READY') throw Error(view.status);
    const review = {
      branchId: s.branch,
      insightId: view.insightId,
      recommendation: 0,
      expectedHash: view.hash,
      expectedVersion: 1 as const,
      expectedRevision: 0,
      decision: 'APPROVE' as const,
      settings: { priority: 'NORMAL' as const, objective: 'REVIEW_DEMAND' as const },
    };
    const finals = await Promise.allSettled([
      reviewRestaurantGrowth(h, { ...review, requestId: randomUUID() }, restaurantGrowthBinding(h)),
      reviewRestaurantGrowth(h, { ...review, requestId: randomUUID() }, restaurantGrowthBinding(h)),
    ]);
    expect(finals.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(finals.filter((x) => x.status === 'rejected')).toHaveLength(1);
  });
  it('revoked branch/capability and foreign tenant cannot read/review saved output', async () => {
    const s = await fixture(),
      r = await ready(s),
      foreign = await fixture();
    expect(
      (
        await readRestaurantGrowthReview(
          actor(foreign),
          { branchId: s.branch, insightId: r.generated.insightId },
          restaurantGrowthBinding(actor(foreign))
        )
      ).status
    ).toBe('DENIED');
    r.h.can = async (permission) => permission !== 'catering:read';
    expect((await r.read()).status).not.toBe('READY');
    r.h.can = async () => true;
    await scoped(s, (db) =>
      db.restaurantBranch.update({ where: { id: s.branch }, data: { active: false } })
    );
    expect((await r.read()).status).toBe('DENIED');
  });
  it('consent withdrawal changes no operational count or marketing eligibility assumption', async () => {
    const s = await fixture(),
      r = await ready(s);
    await scoped(s, (db) =>
      appendCustomerConsent(db, {
        customerId: s.customers[0],
        channel: 'WHATSAPP',
        granted: false,
        source: 'SYNTHETIC_STOP',
        actorId: 'synthetic-manager',
        policyVersion: 'synthetic',
        idempotencyKey: randomUUID(),
      })
    );
    expect((await r.read()).status).toBe('READY'); // No outreach action is admitted by CATERING_REVIEW.
  });
  it('customer and branch locks serialize source-changing transactions through final reread', async () => {
    const s = await fixture(),
      h = actor(s);
    let release!: () => void, locked!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
      }),
      acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
    const holder = scoped(s, async (db) => {
      await lockRestaurantGrowthSource({ ...h, db }, request(s));
      locked();
      await wait;
    });
    await acquired;
    expect(
      await scoped(s, (db) =>
        db.$queryRawUnsafe(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',
          `catering:branch:${s.org}:${s.branch}`
        )
      )
    ).toEqual([{ locked: false }]);
    await expect(
      scoped(s, (db) =>
        db.$queryRawUnsafe(
          'SELECT id FROM restaurant_customers WHERE id=$1 FOR UPDATE NOWAIT',
          s.customers[0]
        )
      )
    ).rejects.toThrow();
    expect(
      await scoped(s, (db) =>
        db.$queryRawUnsafe(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',
          s.orders[0]
        )
      )
    ).toEqual([{ locked: false }]);
    let finished = false;
    const writer = scoped(s, (db) => anonymizeCustomer(db, { customerId: s.customers[0] })).then(
      () => {
        finished = true;
      }
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(finished).toBe(false);
    } finally {
      release();
    }
    await Promise.all([holder, writer]);
    expect(finished).toBe(true);
  });
  it('delivery event writer waits until final review commits, then exact saved lineage is stale', async () => {
    const s = await fixture(),
      r = await ready(s);
    let release!: () => void, reread!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checked = new Promise<void>((resolve) => {
      reread = resolve;
    });
    const actual = restaurantGrowthBinding(r.h);
    const observed = {
      ...actual,
      evidenceIsCurrent: async (...args: Parameters<typeof actual.evidenceIsCurrent>) => {
        const current = await actual.evidenceIsCurrent(...args);
        reread();
        await wait;
        return current;
      },
    };
    const review = reviewRestaurantGrowth(r.h, { ...r.review, decision: 'APPROVE' }, observed);
    await checked;
    let deliveryCommitted = false;
    const delivery = scoped(s, async (db) => {
      // Exact setDelivery writer discipline and persisted relations, without weakening the binding.
      await lockOrder(db, s.orders[0]);
      await db.restaurantCateringDelivery.create({
        data: { orderId: s.orders[0], scheduledAt: new Date('2026-10-01T12:00:00Z') },
      });
      await db.restaurantCateringEvent.create({
        data: {
          orderId: s.orders[0],
          sequence: 2,
          eventType: 'DELIVERY_SET',
          actorStaffProfileId: s.staff,
          payload: { scheduledAt: '2026-10-01T12:00:00Z' },
        },
      });
    }).then(() => {
      deliveryCommitted = true;
    });
    try {
      expect(
        await scoped(s, (db) =>
          db.$queryRawUnsafe(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',
            s.orders[0]
          )
        )
      ).toEqual([{ locked: false }]);
      expect(deliveryCommitted).toBe(false);
    } finally {
      release();
    }
    expect((await review).draftId).toBeTruthy();
    await delivery;
    expect((await r.read()).status).toBe('STALE');
  });
  it('reject leaves no draft; browser fixture if requested is real persisted READY with diagnostic attribution', async () => {
    const s = await fixture(),
      r = await ready(s);
    await reviewRestaurantGrowth(
      r.h,
      { ...r.review, decision: 'REJECT' },
      restaurantGrowthBinding(r.h)
    );
    expect((await r.read()).status).toBe('READY');
    await scoped(s, async (db) =>
      expect(
        await db.$queryRawUnsafe(
          'SELECT id FROM restaurant_growth_drafts WHERE "insightId"=$1',
          r.generated.insightId
        )
      ).toEqual([])
    );
    if (process.env.RESTAURANT_GROWTH_READY_FIXTURE_FILE) {
      const browser = await fixture(10, 'org_chai_chowk'),
        result = await ready(browser);
      const promotionCount = await scoped(browser, (db) => db.restaurantPromotion.count());
      writeFileSync(
        process.env.RESTAURANT_GROWTH_READY_FIXTURE_FILE,
        JSON.stringify({
          branch: browser.branch,
          insight: result.generated.insightId,
          provider: 'TEST_DOUBLE',
          model: 'DETERMINISTIC_CATERING_TOKENS',
          actualProviderProof: false,
          promotionCount,
        })
      );
    }
  });
});
