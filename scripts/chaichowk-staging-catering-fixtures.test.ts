import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '../src/generated/prisma/client';
import {
  seedChaichowkCateringFixtures,
  type ChaichowkCateringFixtureContext,
} from './chaichowk-staging-catering-fixtures';

// Dependency-free mocked contract checks. No database or domain integration
// proof: Prisma.TransactionClient is substituted only at this test boundary.
type Row = Record<string, unknown> & { id: string };
function fixture() {
  const rows = new Map<string, Row>();
  let writes = 0;
  let branch = true;
  let failIngredient = false;
  const tables = [
    'restaurantUnit',
    'restaurantIngredient',
    'restaurantProduct',
    'restaurantRecipe',
    'restaurantRecipeVersion',
    'restaurantRecipeLine',
    'restaurantCustomer',
    'restaurantCateringOrder',
    'restaurantCateringOrderLine',
    'restaurantCateringExtraCost',
    'restaurantCateringDelivery',
    'restaurantCateringEvent',
  ];
  const delegates = Object.fromEntries(
    tables.map((table) => [
      table,
      {
        findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        create: async ({ data }: { data: Row }) => {
          if (failIngredient && table === 'restaurantIngredient')
            throw new Error('injected constraint failure');
          assert.equal(rows.has(data.id), false);
          writes++;
          rows.set(data.id, structuredClone(data));
          return structuredClone(data);
        },
      },
    ])
  );
  const tx = {
    ...delegates,
    restaurantBranch: {
      findFirst: async ({ where }: { where: unknown }) => {
        assert.deepEqual(where, {
          id: 'branch',
          organizationId: 'org',
          active: true,
          timezone: 'Asia/Karachi',
        });
        return branch ? { id: 'branch' } : null;
      },
    },
  } as unknown as Prisma.TransactionClient;
  const keys: string[] = [];
  const context: ChaichowkCateringFixtureContext = {
    organizationId: 'org',
    branchId: 'branch',
    ownerUserId: 'owner-user',
    businessDate: '2026-09-06',
    timezone: 'Asia/Karachi',
    id: (key) => {
      keys.push(key);
      return `org:branch:v1:${key}`;
    },
  };
  const find = (suffix: string) => {
    const row = rows.get(`org:branch:v1:catering.${suffix}`);
    assert.ok(row, suffix);
    return row;
  };
  return {
    tx,
    context,
    rows,
    keys,
    find,
    writes: () => writes,
    failIngredient: () => {
      failIngredient = true;
    },
    hideBranch: () => {
      branch = false;
    },
  };
}

test('inserts representative pre-production fixtures, then observes an unchanged rerun', async () => {
  const f = fixture();
  const result = await seedChaichowkCateringFixtures(f.tx, f.context);
  assert.equal(result.inserted, f.rows.size);
  assert.equal(result.existing, 0);
  assert.deepEqual(result.counts.restaurantCateringOrder, { inserted: 4, existing: 0 });
  assert.deepEqual(result.counts.restaurantCateringExtraCost, { inserted: 16, existing: 0 });
  assert.deepEqual(result.counts.restaurantCateringDelivery, { inserted: 3, existing: 0 });
  assert.equal(result.gaps.length, 4);
  assert.deepEqual(result.coveredStatuses, ['DRAFT', 'QUOTED', 'CANCELLED']);
  assert.ok(f.keys.every((key) => key.startsWith('catering.')));
  const before = structuredClone(f.rows);
  const again = await seedChaichowkCateringFixtures(f.tx, f.context);
  assert.equal(again.inserted, 0);
  assert.equal(again.existing, result.inserted);
  assert.equal(f.writes(), result.inserted);
  assert.deepEqual(f.rows, before);
});

test('dates, quote arithmetic, recipe requirements and synthetic causal history agree', async () => {
  const f = fixture();
  await seedChaichowkCateringFixtures(f.tx, f.context);
  assert.equal(
    (f.find('order.today-draft').eventDate as Date).toISOString(),
    '2026-09-06T00:00:00.000Z'
  );
  assert.equal(
    (f.find('order.future-quote').eventDate as Date).toISOString(),
    '2026-09-20T00:00:00.000Z'
  );
  assert.equal(
    (f.find('order.historical-cancel').eventDate as Date).toISOString(),
    '2026-08-16T00:00:00.000Z'
  );
  assert.equal(
    (f.find('order.future-quote.delivery').scheduledAt as Date).toISOString(),
    '2026-09-20T07:00:00.000Z'
  );
  assert.equal(f.find('recipe.rice-tray.v1').portionCount, 20);
  assert.equal(f.find('recipe.rice-tray.v1').status, 'ACTIVE');
  assert.equal(f.find('recipe.rice-tray.v1.rice').quantity, '3');
  for (const row of f.rows.values()) {
    assert.equal(row.organizationId, 'org');
    if ('dispatchedAt' in row) {
      assert.equal(row.dispatchedAt, null);
      assert.equal(row.deliveredAt, null);
      assert.equal(row.driverStaffId, null);
    }
    if ('costPerPortionSnapshot' in row) assert.equal(row.costPerPortionSnapshot, null);
    if ('eventName' in row) {
      assert.ok(String(row.eventName).startsWith('DEMO'));
      assert.ok((row.createdAt as Date) <= new Date('2026-09-06T00:00:00.000Z'));
      assert.equal(row.depositAmount, null);
      assert.equal(row.createdByStaffId, null);
      if (row.status !== 'DRAFT')
        assert.equal(Number(row.quotedTotal), Number(row.headcount) * 180);
      const events = [...f.rows.values()].filter(
        (event) => event.orderId === row.id && 'sequence' in event
      );
      let current = 'DRAFT';
      events.forEach((event, index) => {
        assert.equal(event.sequence, index + 1);
        assert.equal(event.actorStaffProfileId, null);
        const payload = event.payload as Record<string, unknown>;
        assert.equal(payload.demo, true);
        assert.equal(payload.syntheticHistory, true);
        if (event.eventType === 'STATUS_TRANSITIONED') {
          assert.equal(payload.from, current);
          assert.ok(['QUOTED', 'CANCELLED'].includes(String(payload.to)));
          current = String(payload.to);
        }
      });
      assert.equal(current, row.status);
    }
  }
});

test('changed status, content, actor, timestamp and anonymization refuse without writes', async () => {
  for (const [key, field, value] of [
    ['order.future-quote', 'status', 'CANCELLED'],
    ['order.future-quote.line', 'unitPrice', '999'],
    ['order.future-quote', 'createdByStaffId', 'real-staff'],
    ['order.future-quote', 'updatedAt', new Date('2026-10-01')],
    ['customer.community', 'anonymizedAt', new Date('2026-10-01')],
    ['recipe.rice-tray.v1', 'status', 'SUPERSEDED'],
  ] as const) {
    const f = fixture();
    await seedChaichowkCateringFixtures(f.tx, f.context);
    f.find(key)[field] = value;
    const writes = f.writes();
    const before = structuredClone(f.rows);
    await assert.rejects(seedChaichowkCateringFixtures(f.tx, f.context), /fixture conflict/);
    assert.equal(f.writes(), writes);
    assert.deepEqual(f.rows, before);
  }
});

test('deleted line or partial namespace refuses instead of resurrecting it', async () => {
  const f = fixture();
  await seedChaichowkCateringFixtures(f.tx, f.context);
  f.rows.delete(f.find('order.future-quote.line').id);
  const writes = f.writes();
  await assert.rejects(seedChaichowkCateringFixtures(f.tx, f.context), /namespace is partial/);
  assert.equal(f.writes(), writes);
});

test('invalid context, absent branch, full client and colliding IDs refuse before writes', async () => {
  for (const patch of [
    { businessDate: '2026-02-30' },
    { timezone: 'UTC' },
    { ownerUserId: '' },
    { id: () => 'collision' },
  ]) {
    const f = fixture();
    await assert.rejects(seedChaichowkCateringFixtures(f.tx, { ...f.context, ...patch }));
    assert.equal(f.writes(), 0);
  }
  const f = fixture();
  f.hideBranch();
  await assert.rejects(seedChaichowkCateringFixtures(f.tx, f.context), /branch missing/);
  const client = {
    $transaction: () => assert.fail('must not transact'),
  } as unknown as Prisma.TransactionClient;
  await assert.rejects(seedChaichowkCateringFixtures(client, f.context), /existing transaction/);
  assert.equal(f.writes(), 0);
});

test('foreign identity and changed business date refuse; unrelated rows remain untouched', async () => {
  const f = fixture();
  f.rows.set('unrelated', { id: 'unrelated', organizationId: 'other', notes: 'preserve' });
  await seedChaichowkCateringFixtures(f.tx, f.context);
  assert.deepEqual(f.rows.get('unrelated'), {
    id: 'unrelated',
    organizationId: 'other',
    notes: 'preserve',
  });
  await assert.rejects(
    seedChaichowkCateringFixtures(f.tx, { ...f.context, businessDate: '2026-09-07' }),
    /fixture conflict/
  );
  f.find('order.today-draft').organizationId = 'other';
  await assert.rejects(seedChaichowkCateringFixtures(f.tx, f.context), /organizationId/);
});

test('write errors propagate to the caller for rollback, without continuing the batch', async () => {
  const f = fixture();
  f.failIngredient();
  await assert.rejects(
    seedChaichowkCateringFixtures(f.tx, f.context),
    /injected constraint failure/
  );
  assert.equal(f.writes(), 1);
  // The mock intentionally has no rollback; caller's real transaction owns it.
  assert.equal(f.rows.size, 1);
});
