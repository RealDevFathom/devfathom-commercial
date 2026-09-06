import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  executePharmacyDemoFinance,
  executePharmacyDemoCashSale,
  type PharmacyDemoCashRoot,
  planPharmacyDemoFinance,
  inspectPharmacyDemoJournalArithmetic,
  type PharmacyDemoFinanceStock,
} from './pharmacy-demo-finance';
import type {
  PharmacyDemoContext,
  PharmacyDemoPlan,
  PharmacyDemoResult,
} from './pharmacy-demo-contract';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';

// Composition-only mocks of the actual imported services, not a production
// adapter and not database/RLS evidence. Actual ScopedDb is typechecked below.
const cashServices = vi.hoisted(() => ({
  createSale: vi.fn(),
  addSaleLine: vi.fn(),
  applyPharmacyTender: vi.fn(),
  postSaleLineEntry: vi.fn(),
  postTenderEntry: vi.fn(),
  grossMargin: vi.fn(),
  readCounterReceipt: vi.fn(),
  assertBranchMayOperate: vi.fn(),
}));
vi.mock('../src/lib/pharmacy/sales', () => ({
  createSale: cashServices.createSale,
  addSaleLine: cashServices.addSaleLine,
}));
vi.mock('../src/lib/pharmacy/settlement', () => ({
  applyPharmacyTender: cashServices.applyPharmacyTender,
}));
vi.mock('../src/lib/pharmacy/finance-postings', () => ({
  postSaleLineEntry: cashServices.postSaleLineEntry,
  postTenderEntry: cashServices.postTenderEntry,
}));
vi.mock('../src/lib/pharmacy/finance-reports', () => ({ grossMargin: cashServices.grossMargin }));
vi.mock('../src/lib/pharmacy/counter', () => ({
  readCounterReceipt: cashServices.readCounterReceipt,
}));
vi.mock('../src/lib/pharmacy/regulatory', () => ({
  assertBranchMayOperate: cashServices.assertBranchMayOperate,
}));

function cashFixture() {
  Object.values(cashServices).forEach((mock) => mock.mockReset());
  const namespace = 'phdemo_0123456789abcdef01234567_';
  const day = new Date('2026-09-07T00:00:00Z');
  const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'actor-generated' };
  const input = {
    deviceId: 'device-generated',
    drawerSessionId: 'drawer-generated',
    medicineId: 'medicine',
    presentationId: 'presentation',
    packLevelId: 'pack',
    inventoryLotId: 'lot-generated',
    stockLocationId: 'location-generated',
    expectedAmountMinor: 33,
    cashReceivedMinor: 50,
  };
  const root: PharmacyDemoCashRoot = {
    scope,
    namespace,
    businessDate: day,
    entitlements: {
      organizationId: scope.organizationId,
      vertical: 'PHARMACY',
      seatLimit: 1,
      activeSeats: 1,
      enabledModules: ['pharmacy-counter'],
      modules: [],
      limits: {},
    },
    records: [
      ['User', scope.actorId],
      ['PharmacyRegisteredDevice', input.deviceId],
      ['PharmacyDrawerSession', input.drawerSessionId],
      ['PharmacyInventoryLot', input.inventoryLotId],
      ['PharmacyStockLocation', input.stockLocationId],
    ].map(([model, id]) => ({
      model: model!,
      persistedId: id!,
      planKey: `${namespace}${model}`,
      receiptReference: `${namespace}prerequisites`,
      observedHash: 'unit-test-only',
      observedFacts: {},
    })),
  };
  const balance = {
    inventoryLotId: input.inventoryLotId,
    stockLocationId: input.stockLocationId,
    disposition: 'AVAILABLE',
    onHandUnits: 10,
    looseUnits: 10,
  };
  const db = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: scope.actorId }) },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: scope.branchId }) },
    pharmacyRegisteredDevice: { findFirst: vi.fn().mockResolvedValue({ id: input.deviceId }) },
    pharmacyDrawerSession: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: input.drawerSessionId, openedByActorId: scope.actorId, businessDate: day },
        ]),
    },
    branchRegulatoryProfile: { findFirst: vi.fn().mockResolvedValue({ jurisdictionRuleSet: {} }) },
    medicine: { findFirst: vi.fn().mockResolvedValue({ id: input.medicineId }) },
    presentation: { findFirst: vi.fn().mockResolvedValue({ id: input.presentationId }) },
    packLevel: { findFirst: vi.fn().mockResolvedValue({ id: input.packLevelId }) },
    pharmacyInventoryLot: {
      findFirst: vi.fn().mockResolvedValue({
        id: input.inventoryLotId,
        printedMrpMinor: 1001,
        unitsPerPack: 30,
        unitCostMinor: 20,
      }),
    },
    pharmacyStockBalance: {
      findMany: vi.fn().mockResolvedValue([balance]),
      findFirst: vi.fn().mockResolvedValue({ ...balance, onHandUnits: 9 }),
    },
    pharmacyDrawerMovement: {
      aggregate: vi
        .fn()
        .mockResolvedValueOnce({ _count: 0, _sum: { amountMinor: null } })
        .mockResolvedValueOnce({ _count: 1, _sum: { amountMinor: 33 } }),
    },
    pharmacyTender: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'tender-generated',
          type: 'CASH',
          amountMinor: 33,
          cashReceivedMinor: 50,
          changeGivenMinor: 17,
          drawerSessionId: input.drawerSessionId,
        },
      ]),
    },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'sale-generated',
        status: 'COMPLETED',
        receiptNumber: 27,
        receiptDeviceId: input.deviceId,
        completedAt: day,
      }),
    },
    pharmacySaleLineAllocation: {
      findMany: vi.fn().mockResolvedValue([{ id: 'allocation-generated', canonicalUnits: 1 }]),
    },
    pharmacyStockMovement: {
      findMany: vi.fn().mockResolvedValue([{ id: 'movement-generated', quantityUnits: -1 }]),
    },
  };
  cashServices.createSale.mockResolvedValue({ id: 'sale-generated' });
  cashServices.addSaleLine.mockResolvedValue({
    line: { id: 'line-generated', saleId: 'sale-generated', unitPriceMinor: 33, discountMinor: 0 },
    allocation: {
      allocations: [
        { inventoryLotId: input.inventoryLotId, stockLocationId: input.stockLocationId, units: 1 },
      ],
      movementIds: ['movement-generated'],
    },
  });
  cashServices.applyPharmacyTender.mockResolvedValue({ replayed: false });
  cashServices.postSaleLineEntry.mockResolvedValue({
    id: 'sale-journal-generated',
    lines: [
      { accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: 33 },
      { accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: 33 },
      { accountCode: 'COST_OF_GOODS_SOLD', side: 'DEBIT', amountMinor: 20 },
      { accountCode: 'INVENTORY', side: 'CREDIT', amountMinor: 20 },
    ],
  });
  cashServices.postTenderEntry.mockResolvedValue({
    id: 'tender-journal-generated',
    lines: [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: 33 },
      { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 33 },
    ],
  });
  cashServices.grossMargin.mockResolvedValue([
    {
      key: 'line-generated',
      revenueMinor: 33,
      discountMinor: 0,
      cogsMinor: 20,
      grossMarginMinor: 13,
    },
  ]);
  cashServices.readCounterReceipt.mockResolvedValue({
    saleId: 'sale-generated',
    receiptNumber: 27,
    lines: [{ saleLineId: 'line-generated', identityStatus: 'ISSUED' }],
    totals: { netMinor: 33, tenderedMinor: 33, changeMinor: 17 },
  });
  return { db, tx: db as unknown as ScopedDb, root, input };
}

test('cash boundary: maps generated IDs, exact cash/change, stock and real-service journal calls', async () => {
  const f = cashFixture();
  const result = await executePharmacyDemoCashSale(f.tx, f.root, f.input);
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') assert.fail('expected applied');
  assert.equal(result.saleId, 'sale-generated');
  const shared: PharmacyDemoResult = result;
  assert.equal(shared.status, 'applied');
  assert.equal(result.records[0]!.persistedId, 'sale-generated');
  assert.equal(result.records[0]!.planKey, `${f.root.namespace}finance:cash:sale`);
  assert.notEqual(result.records[0]!.planKey, result.records[0]!.persistedId);
  assert.equal(result.saleLineId, 'line-generated');
  assert.equal(result.tenderId, 'tender-generated');
  assert.equal(result.receiptNumber, 27);
  assert.equal(result.changeGivenMinor, 17);
  assert.equal(result.stockBefore - result.stockAfter, 1);
  assert.deepEqual(result.journalEntryIds, ['sale-journal-generated', 'tender-journal-generated']);
  assert.deepEqual(result.stockMovementIds, ['movement-generated']);
  assert.deepEqual(cashServices.createSale.mock.calls[0], [f.tx, f.root.scope]);
  assert.equal(cashServices.addSaleLine.mock.calls[0]![2].saleId, 'sale-generated');
  assert.equal(
    cashServices.addSaleLine.mock.calls[0]![2].idempotencyKey,
    `${f.root.namespace}finance:cash:line`
  );
  const tenderInput = cashServices.applyPharmacyTender.mock.calls[0]![2];
  assert.equal(tenderInput.type, 'CASH');
  assert.equal(tenderInput.cashReceivedMinor, 50);
  assert.equal(tenderInput.adapter, undefined);
  assert.equal(cashServices.postSaleLineEntry.mock.calls[0]![2].saleLineId, 'line-generated');
  assert.equal(cashServices.postTenderEntry.mock.calls[0]![2].tenderId, 'tender-generated');
  assert.ok(
    cashServices.applyPharmacyTender.mock.invocationCallOrder[0]! <
      cashServices.postSaleLineEntry.mock.invocationCallOrder[0]!
  );
});

test('cash boundary: missing prerecorded IDs and live/mixed stock refuse before writes', async () => {
  let f = cashFixture();
  f.root.records = [];
  assert.equal((await executePharmacyDemoCashSale(f.tx, f.root, f.input)).status, 'refused');
  assert.equal(f.db.user.findFirst.mock.calls.length, 0);
  f = cashFixture();
  f.db.pharmacyStockBalance.findMany.mockResolvedValue([
    {
      inventoryLotId: 'legitimate-lot',
      stockLocationId: 'legitimate-location',
      disposition: 'AVAILABLE',
      onHandUnits: 10,
      looseUnits: 10,
    },
  ]);
  assert.equal((await executePharmacyDemoCashSale(f.tx, f.root, f.input)).status, 'refused');
  assert.equal(cashServices.createSale.mock.calls.length, 0);
});

test('cash boundary: root tenant mismatch and missing operator/drawer deny without mutations', async () => {
  for (const missing of ['tenant', 'actor', 'drawer']) {
    const f = cashFixture();
    if (missing === 'tenant') f.root.entitlements.organizationId = 'org-b';
    if (missing === 'actor') f.db.user.findFirst.mockResolvedValue(null);
    if (missing === 'drawer') f.db.pharmacyDrawerSession.findMany.mockResolvedValue([]);
    assert.equal((await executePharmacyDemoCashSale(f.tx, f.root, f.input)).status, 'refused');
    assert.equal(cashServices.createSale.mock.calls.length, 0);
  }
});

test('cash boundary: journal/service errors propagate unchanged for owning transaction rollback', async () => {
  for (const step of [
    'addSaleLine',
    'applyPharmacyTender',
    'postSaleLineEntry',
    'postTenderEntry',
    'grossMargin',
    'readCounterReceipt',
  ] as const) {
    const f = cashFixture();
    const error = new Error(`failure:${step}`);
    cashServices[step].mockRejectedValue(error);
    await assert.rejects(
      executePharmacyDemoCashSale(f.tx, f.root, f.input),
      (value) => value === error
    );
  }
});

test('cash boundary: allocation race, tender replay and readback mismatches throw instead of partial success', async () => {
  let f = cashFixture();
  cashServices.addSaleLine.mockResolvedValue({
    line: { saleId: 'sale-generated', unitPriceMinor: 33, discountMinor: 0 },
    allocation: { allocations: [] },
  });
  await assert.rejects(
    executePharmacyDemoCashSale(f.tx, f.root, f.input),
    /ALLOCATION_CHANGED_ROLLBACK/
  );
  assert.equal(cashServices.applyPharmacyTender.mock.calls.length, 0);
  f = cashFixture();
  cashServices.applyPharmacyTender.mockResolvedValue({ replayed: true });
  await assert.rejects(
    executePharmacyDemoCashSale(f.tx, f.root, f.input),
    /SETTLEMENT_MISMATCH_ROLLBACK/
  );
  f = cashFixture();
  cashServices.grossMargin.mockResolvedValue([]);
  await assert.rejects(
    executePharmacyDemoCashSale(f.tx, f.root, f.input),
    /READBACK_MISMATCH_ROLLBACK/
  );
});

test('cash boundary: incorrect journal, drawer and receipt evidence cannot succeed', async () => {
  let f = cashFixture();
  cashServices.postTenderEntry.mockResolvedValue({ id: 'bad-journal', lines: [] });
  await assert.rejects(
    executePharmacyDemoCashSale(f.tx, f.root, f.input),
    /JOURNAL_DRAWER_MISMATCH_ROLLBACK/
  );
  f = cashFixture();
  f.db.pharmacyDrawerMovement.aggregate
    .mockReset()
    .mockResolvedValue({ _count: 0, _sum: { amountMinor: null } });
  await assert.rejects(
    executePharmacyDemoCashSale(f.tx, f.root, f.input),
    /JOURNAL_DRAWER_MISMATCH_ROLLBACK/
  );
  f = cashFixture();
  cashServices.readCounterReceipt.mockResolvedValue({ receiptNumber: 28 });
  await assert.rejects(
    executePharmacyDemoCashSale(f.tx, f.root, f.input),
    /RECEIPT_MISMATCH_ROLLBACK/
  );
});

const context: PharmacyDemoContext = {
  organizationId: 'synthetic-org-a',
  branchId: 'synthetic-branch-a',
  ownerUserId: 'existing-owner-ref',
  namespace: 'phdemo_0123456789abcdef01234567_',
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

test('namespace compatibility: preserve canonical identity and quote refs without persisted IDs', () => {
  for (const namespace of [
    'phdemo_0123456789abcdef01234567_',
    'phdemo_abcdef0123456789abcdef01_',
  ]) {
    const input = { ...observed, namespace };
    const result = planPharmacyDemoFinance(input, stock);
    assert.equal(input.namespace, namespace);
    assert.equal(result.namespace, namespace);
    assert.equal(result.scope.namespace, namespace);
    assert.deepEqual(result.records, []);
    assert.deepEqual(
      result.examples.map((example) => example.ref),
      ['pack', 'strip', 'unit'].map((unit) => `${namespace}:finance:${unit}`)
    );
    assert.equal(result.digest, planPharmacyDemoFinance(input, stock).digest);
  }
  assert.notEqual(
    plan().digest,
    planPharmacyDemoFinance({ ...observed, namespace: 'phdemo_abcdef0123456789abcdef01_' }, stock)
      .digest
  );
});

test('namespace compatibility: refuse legacy, uppercase, malformed and rewritten prefixes', () => {
  for (const namespace of [
    'pharmacy-demo:unit-test',
    'phdemo_ABCDEF0123456789abcdef01_',
    'phdemo_0123456789abcdef0123456_',
    'phdemo_0123456789abcdef012345678_',
    'phdemo_0123456789abcdef01234567',
    `${context.namespace}finance`,
  ]) {
    assert.throws(
      () => planPharmacyDemoFinance({ ...observed, namespace }, stock),
      /INVALID_DEMO_NAMESPACE/
    );
  }
});

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
    { namespace: 'phdemo_abcdef0123456789abcdef01_' },
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
