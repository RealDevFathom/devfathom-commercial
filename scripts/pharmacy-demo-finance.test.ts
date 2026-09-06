import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  executePharmacyDemoFinance,
  planPharmacyDemoFinance,
  inspectPharmacyDemoJournalArithmetic,
  type PharmacyDemoFinanceStock,
} from './pharmacy-demo-finance';
import type {
  PharmacyDemoContext,
  PharmacyDemoPlan,
  PharmacyDemoResult,
} from './pharmacy-demo-contract';

const context: PharmacyDemoContext = {
  organizationId: 'synthetic-org-a',
  branchId: 'synthetic-branch-a',
  ownerUserId: 'existing-owner-ref',
  namespace: 'pharmacy-demo:unit-test',
  businessDate: '2026-09-07',
  scenarioAt: '2026-09-07T10:00:00+05:00',
  timezone: 'Asia/Karachi',
  currency: 'PKR',
  actors: [],
  references: [],
  modules: [],
};
const stock: PharmacyDemoFinanceStock = {
  medicineId: 'approved-medicine-ref',
  presentationId: 'approved-presentation-ref',
  inventoryLotId: 'approved-lot-ref',
  stockLocationId: 'approved-location-ref',
  printedMrpMinor: 1001,
  unitsPerPack: 30,
  units: [
    { saleUnit: 'PACK', packLevelId: 'pack-ref', canonicalUnitsPerSaleUnit: 30 },
    { saleUnit: 'STRIP', packLevelId: 'strip-ref', canonicalUnitsPerSaleUnit: 10 },
    { saleUnit: 'UNIT', packLevelId: 'unit-ref', canonicalUnitsPerSaleUnit: 1 },
  ],
};
const observed: PharmacyDemoContext = {
  ...context,
  actors: [
    {
      userId: 'synthetic-user',
      actorId: 'synthetic-actor',
      organizationId: context.organizationId,
      branchId: context.branchId,
      active: true,
      synthetic: true,
      capabilities: ['reports:financial', 'reports:operational'],
    },
  ],
  modules: [{ key: 'pharmacy-reports', enabled: true }],
  references: [
    { kind: 'medicine' as const, id: stock.medicineId },
    { kind: 'presentation' as const, id: stock.presentationId },
    { kind: 'location' as const, id: stock.stockLocationId },
    ...stock.units.map((unit) => ({ kind: 'pack' as const, id: unit.packLevelId })),
  ].map((item) => ({
    ...item,
    organizationId: context.organizationId,
    branchId: context.branchId,
    approved: true,
    observedHash: 'synthetic-observation-hash',
  })),
};
const plan = () => planPharmacyDemoFinance(observed, stock);
const row = {
  key: 'demo-line',
  revenueMinor: 990,
  discountMinor: 0,
  cogsMinor: 600,
  grossMarginMinor: 390,
};

test('implements shared plan/result contract without invented persisted records', async () => {
  const shared: PharmacyDemoPlan = plan();
  assert.equal(shared.lane, 'finance');
  assert.deepEqual(shared.records, []);
  assert.ok(
    shared.gaps.every(
      (gap) => gap.function && ['OWNER-INPUT', 'UNSEEDED', 'DRAFT-ONLY'].includes(gap.status)
    )
  );
  const result: PharmacyDemoResult = await executePharmacyDemoFinance(
    observed,
    stock,
    shared.digest
  );
  assert.equal(result.status, 'refused');
});
test('uses actual priceFromLot rounding for pack/strip/unit quotes', () => {
  assert.deepEqual(
    plan().examples.map((x) => [x.saleUnit, x.canonicalUnits, x.unitPriceMinor]),
    [
      ['PACK', 30, 990],
      ['STRIP', 10, 330],
      ['UNIT', 1, 33],
    ]
  );
  assert.equal(plan().writesEnabled, false);
  assert.equal(plan().coverage, 'ARITHMETIC_ONLY');
});
test('stable digest ignores property, reference, capability and unit order', () => {
  assert.equal(
    planPharmacyDemoFinance(context, stock).digest,
    planPharmacyDemoFinance(context, { ...stock, units: [...stock.units].reverse() }).digest
  );
  assert.equal(
    plan().digest,
    planPharmacyDemoFinance(
      {
        ...observed,
        references: [...observed.references].reverse(),
        actors: observed.actors.map((actor) => ({
          ...actor,
          capabilities: [...actor.capabilities].reverse(),
        })),
      },
      { ...stock, units: [...stock.units].reverse() }
    ).digest
  );
});
test('digest binds organizations, branches, source refs and unrounded price', () => {
  for (const changed of [
    { organizationId: 'synthetic-org-b' },
    { branchId: 'synthetic-branch-b' },
    { ownerUserId: 'another-owner' },
    { namespace: 'pharmacy-demo:other' },
  ])
    assert.notEqual(
      plan().digest,
      planPharmacyDemoFinance({ ...observed, ...changed }, stock).digest
    );
  for (const changed of [{ inventoryLotId: 'other-lot' }, { printedMrpMinor: 1002 }])
    assert.notEqual(
      plan().digest,
      planPharmacyDemoFinance(observed, { ...stock, ...changed }).digest
    );
});
test('digest binds observed hashes, modules and actor capabilities', () => {
  for (const changed of [
    { references: observed.references.map((item) => ({ ...item, observedHash: 'changed' })) },
    { modules: [{ key: 'pharmacy-reports', enabled: false }] },
    { actors: observed.actors.map((actor) => ({ ...actor, capabilities: [] })) },
  ])
    assert.notEqual(
      plan().digest,
      planPharmacyDemoFinance({ ...observed, ...changed }, stock).digest
    );
});
test('rejects bad namespace, calendar date, timezone and currency', () => {
  for (const changed of [
    { namespace: 'live-sale' },
    { businessDate: '2026-02-30' },
    { scenarioAt: '2026-09-07T10:00:00' },
    { timezone: 'Unknown/Zone' },
    { currency: 'USD' },
  ])
    assert.throws(() =>
      planPharmacyDemoFinance({ ...observed, ...changed } as PharmacyDemoContext, stock)
    );
});
test('rejects invalid arithmetic and duplicate/unbounded unit examples', () => {
  for (const changed of [
    { printedMrpMinor: -1 },
    { unitsPerPack: 0 },
    { printedMrpMinor: Number.MAX_SAFE_INTEGER + 1 },
    { units: [...stock.units, stock.units[0]!] },
    { units: [{ saleUnit: 'UNIT' as const, packLevelId: 'u', canonicalUnitsPerSaleUnit: 2 }] },
  ])
    assert.throws(() => planPharmacyDemoFinance(observed, { ...stock, ...changed }));
});
test('missing stock remains explicit, never fabricates records', async () => {
  const empty = planPharmacyDemoFinance(context);
  assert.deepEqual(empty.examples, []);
  assert.equal(empty.regulatory, 'UNSEEDED/OWNER-INPUT');
  assert.ok(empty.gaps.some((gap) => gap.function === 'medicine.priceFromLot'));
  assert.equal(
    (await executePharmacyDemoFinance(context, undefined, empty.digest)).status,
    'refused'
  );
});
test('changed plan returns shared refusal result', async () => {
  assert.deepEqual(
    await executePharmacyDemoFinance(
      { ...observed, branchId: 'synthetic-branch-b' },
      stock,
      plan().digest
    ),
    { status: 'refused', unmetPrerequisites: ['PLAN_CHANGED'] }
  );
});
test('missing, duplicate and cross-tenant/branch observations create precise gaps', () => {
  for (const references of [
    [],
    [...observed.references, observed.references[0]!],
    observed.references.map((item) => ({ ...item, organizationId: 'synthetic-org-b' })),
    observed.references.map((item) => ({ ...item, branchId: 'synthetic-branch-b' })),
  ])
    assert.ok(
      planPharmacyDemoFinance({ ...observed, references }, stock).gaps.some(
        (gap) => gap.function === 'finance.reference'
      )
    );
  assert.ok(!plan().gaps.some((gap) => gap.function === 'finance.reference'));
});
test('manual approval/capability facts still refuse execution on replay', async () => {
  const first = await executePharmacyDemoFinance(observed, stock, plan().digest);
  assert.equal(first.status, 'refused');
  assert.deepEqual(await executePharmacyDemoFinance(observed, stock, plan().digest), first);
  if (first.status === 'refused') {
    assert.ok(first.unmetPrerequisites.some((gap) => gap.includes('createSale')));
    assert.ok(first.unmetPrerequisites.some((gap) => gap.includes('grossMargin')));
  }
});
test('pure journal assertion filters unrelated revenue without claiming reconciliation', () => {
  const result = inspectPharmacyDemoJournalArithmetic(
    [row, { ...row, key: 'legitimate-line' }],
    ['demo-line']
  );
  assert.deepEqual(result.rows, [row]);
  assert.equal(result.journalInspection, 'JOURNAL_ARITHMETIC_ONLY');
  assert.equal(result.moneyStockReconciled, false);
  assert.equal(result.drawerProof, false);
});
test('missing journal sources cannot pass inspection', () => {
  assert.equal(
    inspectPharmacyDemoJournalArithmetic([], ['demo-line']).journalInspection,
    'MISSING_JOURNAL_LINES'
  );
});
test('journal mismatches, duplicates, unsafe numbers and unbounded refs fail closed', () => {
  for (const rows of [
    [{ ...row, grossMarginMinor: 391 }],
    [row, row],
    [{ ...row, revenueMinor: Infinity }],
  ])
    assert.throws(() => inspectPharmacyDemoJournalArithmetic(rows, ['demo-line']));
  for (const ids of [[], ['a', 'b', 'c', 'd'], ['a', 'a']])
    assert.throws(() => inspectPharmacyDemoJournalArithmetic([row], ids), /INVALID_RETAINED_LINES/);
});
