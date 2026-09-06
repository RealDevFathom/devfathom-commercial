import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  executePharmacyDemoFinance,
  planPharmacyDemoFinance,
  type PharmacyDemoFinanceContext,
  type PharmacyDemoFinanceStock,
  type PharmacyDemoMarginReader,
} from './pharmacy-demo-finance';

const context: PharmacyDemoFinanceContext = {
  organizationId: 'synthetic-org-a',
  branchId: 'synthetic-branch-a',
  ownerUserId: 'existing-owner-ref',
  namespace: 'pharmacy-demo:unit-test',
  businessDate: '2026-09-07',
  scenarioAt: '2026-09-07T10:00:00+05:00',
  timezone: 'Asia/Karachi',
  currency: 'PKR',
  pharmacySalesEnabled: true,
  financialReportsAuthorized: true,
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
const plan = () => planPharmacyDemoFinance(context, stock);
const inspection = (readGrossMargin: PharmacyDemoMarginReader) => ({
  from: '2026-09-07T00:00:00Z',
  to: '2026-09-08T00:00:00Z',
  retainedSaleLineIds: ['demo-line'],
  readGrossMargin,
});
const row = {
  key: 'demo-line',
  revenueMinor: 990,
  discountMinor: 0,
  cogsMinor: 600,
  grossMarginMinor: 390,
};

test('uses actual priceFromLot rounding for bounded pack/strip/unit quotes', () => {
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
test('stable hash ignores input property and unit order', () => {
  assert.equal(
    plan().hash,
    planPharmacyDemoFinance({ ...context }, { ...stock, units: [...stock.units].reverse() }).hash
  );
});
test('hash binds both organizations, both branches, source refs and unrounded price', () => {
  for (const changed of [
    { organizationId: 'synthetic-org-b' },
    { branchId: 'synthetic-branch-b' },
    { ownerUserId: 'another-owner' },
    { namespace: 'pharmacy-demo:other' },
  ])
    assert.notEqual(plan().hash, planPharmacyDemoFinance({ ...context, ...changed }, stock).hash);
  for (const changed of [{ inventoryLotId: 'other-lot' }, { printedMrpMinor: 1002 }])
    assert.notEqual(plan().hash, planPharmacyDemoFinance(context, { ...stock, ...changed }).hash);
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
      planPharmacyDemoFinance({ ...context, ...changed } as PharmacyDemoFinanceContext, stock)
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
    assert.throws(() => planPharmacyDemoFinance(context, { ...stock, ...changed }));
});
test('missing stock remains explicit, never fabricates records', async () => {
  const empty = planPharmacyDemoFinance(context);
  assert.deepEqual(empty.examples, []);
  assert.equal(empty.regulatory, 'UNSEEDED/OWNER-INPUT');
  const result = await executePharmacyDemoFinance(context, undefined, empty.hash);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.writes, 0);
  assert.equal(result.gaps.length, 4);
});
test('changed plan refuses before service access', async () => {
  await assert.rejects(
    executePharmacyDemoFinance(
      { ...context, branchId: 'synthetic-branch-b' },
      stock,
      plan().hash,
      inspection(async () => {
        assert.fail('must not read');
      })
    ),
    /PLAN_CHANGED/
  );
});
test('missing module or report authorization performs no reads', async () => {
  for (const changed of [{ pharmacySalesEnabled: false }, { financialReportsAuthorized: false }]) {
    const scoped = { ...context, ...changed };
    const result = await executePharmacyDemoFinance(
      scoped,
      stock,
      planPharmacyDemoFinance(scoped, stock).hash,
      inspection(async () => {
        assert.fail('must not read');
      })
    );
    assert.equal(result.journalInspection, 'UNSEEDED/OWNER-INPUT');
  }
});
test('read execution passes exact tenant/branch scope and excludes unrelated revenue', async () => {
  const result = await executePharmacyDemoFinance(
    context,
    stock,
    plan().hash,
    inspection(async (scope, input) => {
      assert.deepEqual(scope, {
        organizationId: context.organizationId,
        branchId: context.branchId,
      });
      assert.equal(input.by, 'line');
      return [row, { ...row, key: 'legitimate-line' }];
    })
  );
  assert.deepEqual(result.rows, [row]);
  assert.equal(result.journalInspection, 'JOURNAL_ARITHMETIC_ONLY');
  assert.equal(result.moneyStockReconciled, false);
  assert.equal(result.drawerProof, false);
});
test('replay stays read-only, never claims paid coverage', async () => {
  let reads = 0;
  const read = inspection(async () => {
    reads++;
    return [row];
  });
  const first = await executePharmacyDemoFinance(context, stock, plan().hash, read);
  assert.deepEqual(await executePharmacyDemoFinance(context, stock, plan().hash, read), first);
  assert.equal(reads, 2);
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.writes, 0);
});
test('missing journal sources cannot pass inspection', async () => {
  const result = await executePharmacyDemoFinance(
    context,
    stock,
    plan().hash,
    inspection(async () => [])
  );
  assert.equal(result.journalInspection, 'MISSING_JOURNAL_LINES');
});
test('journal mismatches, duplicates, outages and oversized windows fail closed', async () => {
  for (const rows of [[{ ...row, grossMarginMinor: 391 }], [row, row]])
    await assert.rejects(
      executePharmacyDemoFinance(
        context,
        stock,
        plan().hash,
        inspection(async () => rows)
      )
    );
  await assert.rejects(
    executePharmacyDemoFinance(
      context,
      stock,
      plan().hash,
      inspection(async () => {
        throw new Error('offline');
      })
    ),
    /offline/
  );
  await assert.rejects(
    executePharmacyDemoFinance(context, stock, plan().hash, {
      ...inspection(async () => {
        assert.fail('must not read');
      }),
      to: '2027-01-01T00:00:00Z',
    }),
    /INVALID_REPORT_PERIOD/
  );
});
