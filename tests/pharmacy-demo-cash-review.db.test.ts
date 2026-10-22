import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { executePharmacyDemoCashSale, executePharmacyDemoCashReturn, type PharmacyDemoCashRoot } from '../scripts/pharmacy-demo-finance';
import { withTenantDb } from '../src/lib/tenancy/scoped-db';
import { db } from '../src/lib/db';
import { receiveLot } from '../src/lib/pharmacy/stock-ledger';
import { foldExpectedCash } from '../src/lib/pharmacy/settlement';

// Explicitly synthetic fixtures, ONLY in a newly initialized run-owned cluster.
// Apply all 106 unchanged migrations and prepare-extensions.sql first.
// No root replay, customer evidence, service mocks, or production adapters.
const ownerUrl = process.env.WHA1398_OWNER_URL!;
const runtimeUrl = process.env.DATABASE_URL!;
const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) });
const from = new Date('2020-01-01Z');
const to = new Date('2099-01-01Z');
const day = new Date(new Date().toISOString().slice(0, 10));
const fixtureRun = Date.now();
const namespace = (n: number) => `phdemo_${(fixtureRun + n).toString(16).padStart(24, '0')}_`;
type Fixture = Awaited<ReturnType<typeof fixture>>;
let fresh: Fixture, late: Fixture, foreign: Fixture, legitimate: Fixture;
let sentinelBefore: string;

async function fixture(n: number, servicePackSize?: number) {
  const ns = namespace(n);
  const org = await owner.organization.create({ data: { slug: ns, legalName: ns, displayName: ns, vertical: 'PHARMACY' } });
  const organizationId = org.id;
  await owner.organizationDepartment.create({ data: { organizationId, key: 'synthetic', name: 'Synthetic test only' } });
  const actor = await owner.user.create({ data: { organizationId, name: ns + 'operator', email: ns + '@example.invalid', department: 'synthetic', title: 'Synthetic test only' } });
  const branch = await owner.pharmacyBranch.create({ data: { organizationId, code: ns, name: ns, addressLine: 'Synthetic', city: 'Synthetic', provinceCode: 'QA' } });
  const branchId = branch.id;
  const device = await owner.pharmacyRegisteredDevice.create({ data: { organizationId, branchId, name: ns + 'device', deviceSecretHash: createHash('sha256').update(ns + 'synthetic-only').digest('hex'), enrolledByActorId: actor.id } });
  const drawer = await owner.pharmacyDrawerSession.create({ data: { organizationId, branchId, deviceId: device.id, businessDate: day, openingFloatMinor: 0, openedByActorId: actor.id } });
  const rule = { provisional: false, values: ['SYNTHETIC'] };
  const rules = await owner.jurisdictionRuleSet.create({ data: { code: ns, version: 1, effectiveFrom: from, licenceCategories: rule, permittedSchedules: rule, prescriptionOnlyClasses: {}, prescriptionRetentionDays: {}, controlledRegisterFlags: {}, pharmacistCoverageRule: rule, recordRetentionByClass: {} } });
  await owner.branchRegulatoryProfile.create({ data: { organizationId, branchId, version: 1, effectiveFrom: from, provinceCode: 'QA', jurisdictionRuleSetId: rules.id, premises: { synthetic: true }, licenceCategory: 'SYNTHETIC', licenceNumber: ns, licenceValidFrom: from, licenceValidTo: to, licenceEvidenceFileRef: ns + 'test-only', permittedSchedules: [], qualifiedPersonRegistration: ns, qualifiedPersonValidFrom: from, qualifiedPersonValidTo: to, qualifiedPersonCoverageRosterRef: ns + 'test-only', fiscalStatus: 'SYNTHETIC', retentionPolicy: {} } });
  const medicine = await owner.medicine.create({ data: { organizationId, productName: ns, productFamily: 'FRONT_SHOP', otc: true, saleable: true } });
  const presentation = await owner.presentation.create({ data: { organizationId, medicineId: medicine.id, presentation: 'Synthetic unit' } });
  const pack = await owner.packLevel.create({ data: { organizationId, presentationId: presentation.id, versionGroupId: ns, version: 1, level: servicePackSize === 1 ? 'UNIT' : 'BOX', unitsPerParent: servicePackSize ?? 3, effectiveFrom: from } });
  const batch = await owner.pharmacyManufacturingBatch.create({ data: { organizationId, medicineId: medicine.id, batchNumber: ns, expiresAt: to } });
  const location = await owner.pharmacyStockLocation.create({ data: { organizationId, branchId, code: ns, name: ns, kind: 'STORE' } });
  // GitHub101 path uses the genuine receiveLot -> postReceipt -> arrangementFor
  // service under restricted RLS. No balance insert, rewrite or BREAK_PACK.
  // Schema-owner catalog/operator fixtures above are explicitly TEST-only.
  const lot = servicePackSize === undefined
    ? await owner.pharmacyInventoryLot.create({ data: { organizationId, branchId, manufacturingBatchId: batch.id, packLevelId: pack.id, unitsPerPack: 3, supplierName: ns, supplierInvoiceRef: ns + 'invoice', unitCostMinor: 20, printedMrpMinor: 100, receivedAt: from, receivedExpiresAt: to, receivedExpiryPrecision: 'DAY' } })
    : (await withTenantDb(organizationId, tx => receiveLot(tx, { organizationId, branchId, actorId: actor.id }, {
      manufacturingBatchId: batch.id, packLevelId: pack.id, stockLocationId: location.id,
      unitsPerPack: servicePackSize, quantityUnits: 2 * servicePackSize,
      supplierName: ns, supplierInvoiceRef: ns + 'invoice', unitCostMinor: 20,
      printedMrpMinor: 100, receivedAt: from, receivedExpiresAt: to,
      receivedExpiryPrecision: 'DAY', idempotencyKey: ns + 'service-receipt',
    }), { userId: actor.id, timeout: 30000 })).lot;
  if (servicePackSize === undefined) await owner.pharmacyStockMovement.create({ data: { organizationId, branchId, inventoryLotId: lot.id, stockLocationId: location.id, kind: 'RECEIPT', disposition: 'AVAILABLE', quantityUnits: 3, sealedPackDelta: 0, looseUnitDelta: 3, actorId: actor.id, idempotencyKey: ns + 'synthetic-opening' } });
  const root: PharmacyDemoCashRoot = { scope: { organizationId, branchId, actorId: actor.id }, namespace: ns, businessDate: day, entitlements: { organizationId, vertical: 'PHARMACY', seatLimit: 1, activeSeats: 1, enabledModules: ['pharmacy-counter'], modules: [], limits: {} }, records: [['User', actor.id], ['PharmacyRegisteredDevice', device.id], ['PharmacyDrawerSession', drawer.id], ['PharmacyInventoryLot', lot.id], ['PharmacyStockLocation', location.id]].map(([model, persistedId]) => ({ model: model!, persistedId: persistedId!, planKey: ns + model, receiptReference: ns + 'setup', observedHash: 'synthetic-setup', observedFacts: { organizationId, branchId } })) };
  return { root, input: { deviceId: device.id, drawerSessionId: drawer.id, medicineId: medicine.id, presentationId: presentation.id, packLevelId: pack.id, inventoryLotId: lot.id, stockLocationId: location.id, expectedAmountMinor: servicePackSize === 1 ? 100 : 33, cashReceivedMinor: servicePackSize === 1 ? 150 : 50 } };
}

async function snapshot(f: Fixture) {
  const where = { organizationId: f.root.scope.organizationId };
  return JSON.stringify(await Promise.all([
    owner.pharmacySale.findMany({ where, orderBy: { id: 'asc' } }),
    owner.pharmacySaleLine.findMany({ where, orderBy: { id: 'asc' } }),
    owner.pharmacyTender.findMany({ where, orderBy: { id: 'asc' } }),
    owner.pharmacyStockMovement.findMany({ where, orderBy: { id: 'asc' } }),
    owner.pharmacyStockBalance.findMany({ where }),
    owner.pharmacyDrawerMovement.findMany({ where, orderBy: { id: 'asc' } }),
    owner.financeJournalEntry.findMany({ where, include: { lines: true }, orderBy: { id: 'asc' } }),
    owner.pharmacySaleEvent.findMany({ where, orderBy: { id: 'asc' } }),
    owner.pharmacySaleLineAllocation.findMany({ where, orderBy: { id: 'asc' } }),
    owner.$queryRawUnsafe('SELECT * FROM pharmacy_receipt_number_sequences WHERE "organizationId"=$1 ORDER BY id', where.organizationId),
    owner.$queryRawUnsafe('SELECT * FROM pharmacy_money_idempotency_keys WHERE "organizationId"=$1 ORDER BY id', where.organizationId),
  ]));
}

describe.skipIf(!ownerUrl || !runtimeUrl || !process.env.WHA1398_PG_DIR)('owned disposable PostgreSQL cash-sale proof', () => {
beforeAll(async () => {
  for (const raw of [ownerUrl, runtimeUrl]) {
    const url = new URL(raw);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/qa1398_disposable');
    expect(url.password).toBe('');
  }
  expect(new URL(runtimeUrl).username).toBe('qa1398_runtime');
  expect(new URL(ownerUrl).username).toBe('qa1398_owner');
  expect(new URL(runtimeUrl).port).toBe(new URL(ownerUrl).port);
  const guard = new Client({ connectionString: ownerUrl });
  await guard.connect();
  try {
    const result = await guard.query('SHOW data_directory');
    expect(realpathSync(result.rows[0].data_directory)).toBe(realpathSync(process.env.WHA1398_PG_DIR!));
    expect(realpathSync(process.env.WHA1398_PG_DIR!)).toContain(realpathSync(process.env.PAPERCLIP_SCRATCH_DIR!));
    const count = await guard.query('SELECT count(*)::int AS n FROM pharmacy_sales');
    expect(count.rows[0].n).toBe(0);
  } finally { await guard.end(); }
  fresh = await fixture(13981);
  late = await fixture(13982);
  foreign = await fixture(13983);
  legitimate = await fixture(13984);
  await owner.user.update({ where: { id: legitimate.root.scope.actorId }, data: { name: 'Legitimate sentinel (synthetic only)' } });
  sentinelBefore = (await snapshot(foreign)) + (await snapshot(legitimate));
}, 30000);

afterAll(async () => { await owner.$disconnect(); await db.$disconnect(); });

// NEW 60e6d50 acceptance. Original receiving/cash are setup, not counted cases.
async function returnSetup(n: number) {
  const f = await fixture(n, 1);
  const scope = f.root.scope;
  const original = await withTenantDb(scope.organizationId, tx => executePharmacyDemoCashSale(tx, f.root, f.input), { userId: scope.actorId, timeout: 30000 });
  if (original.status !== 'applied') throw new Error(JSON.stringify(original));
  const quarantine = await owner.pharmacyStockLocation.create({ data: { organizationId: scope.organizationId, branchId: scope.branchId, code: f.root.namespace + 'quarantine', name: 'TEST ONLY quarantine', kind: 'QUARANTINE' } });
  const root = { ...f.root, records: [...f.root.records, ...original.records, { model: 'PharmacyStockLocation', persistedId: quarantine.id, planKey: f.root.namespace + 'quarantine', receiptReference: f.root.namespace + 'setup', observedHash: 'TEST-only-prerequisite', observedFacts: { organizationId: scope.organizationId, branchId: scope.branchId } }] };
  const input = { quarantineLocationId: quarantine.id, reason: 'TEST ONLY full return', integrityDecision: 'TEST ONLY quarantine; no real inspection or authorization claim' };
  // Nonempty same-branch stock sentinel, received through the real service AFTER
  // cash setup. It is a different lot and never a helper target.
  const sourceLot = await owner.pharmacyInventoryLot.findUniqueOrThrow({ where: { id: f.input.inventoryLotId } });
  const sentinel = await withTenantDb(scope.organizationId, tx => receiveLot(tx, scope, {
    manufacturingBatchId: sourceLot.manufacturingBatchId, packLevelId: f.input.packLevelId,
    stockLocationId: f.input.stockLocationId, unitsPerPack: 1, quantityUnits: 2,
    supplierName: f.root.namespace, supplierInvoiceRef: f.root.namespace + 'same-branch-sentinel',
    unitCostMinor: 20, printedMrpMinor: 100, receivedAt: from, receivedExpiresAt: to,
    receivedExpiryPrecision: 'DAY', idempotencyKey: f.root.namespace + 'sentinel-received',
  }), { userId: scope.actorId });
  const sentinelSnapshot = async () => JSON.stringify(await Promise.all([
    owner.pharmacyInventoryLot.findUnique({ where: { id: sentinel.lot.id } }),
    owner.pharmacyStockBalance.findMany({ where: { inventoryLotId: sentinel.lot.id } }),
    owner.pharmacyStockMovement.findMany({ where: { inventoryLotId: sentinel.lot.id } }),
  ]));
  return { f, root, original, input, sentinelSnapshot };
}

async function reversalSnapshot(f: Fixture) {
  const where = { organizationId: f.root.scope.organizationId };
  return JSON.stringify([await snapshot(f), await Promise.all([
    owner.pharmacySaleReturn.findMany({ where, orderBy: { id: 'asc' } }),
    owner.pharmacySaleReturnLine.findMany({ where, orderBy: { id: 'asc' } }),
    owner.pharmacyRefund.findMany({ where, orderBy: { id: 'asc' } }),
  ])]);
}

test('NEW full-return SQL commits quarantine/refund and refuses repeated foreign edited source', async () => {
  const { f, root, original, input, sentinelSnapshot } = await returnSetup(13989);
  const scope = root.scope;
  const sentinel = await sentinelSnapshot();
  const before = await reversalSnapshot(f);
  const invoke = (o = original, i = input) => withTenantDb(scope.organizationId, tx => executePharmacyDemoCashReturn(tx, root, o, i), { userId: scope.actorId, timeout: 30000 });
  for (const [o, i] of [
    [{ ...original, saleId: foreign.input.inventoryLotId }, input],
    [{ ...original, amountMinor: original.amountMinor + 1 }, input],
    [{ ...original, records: original.records.map((r, index) => index ? r : { ...r, observedHash: 'edited-source' }) }, input],
    [original, { ...input, quarantineLocationId: foreign.input.stockLocationId }],
    [original, { ...input, integrityDecision: '' }],
  ] as const) expect((await invoke(o, i)).status).toBe('refused');
  expect(await reversalSnapshot(f)).toBe(before);
  await withTenantDb(scope.organizationId, async tx => {
    expect(await tx.$queryRawUnsafe('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const policies = await tx.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('pharmacy_sale_returns','pharmacy_sale_return_lines','pharmacy_refunds','pharmacy_stock_movements','pharmacy_stock_balances','finance_journal_entries','finance_journal_lines')");
    expect(policies).toHaveLength(7);
    policies.forEach(row => expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true }));
    expect(await tx.pharmacyInventoryLot.findFirst({ where: { id: foreign.input.inventoryLotId } })).toBeNull();
  }, { userId: scope.actorId });
  const result = await invoke();
  expect(result.status).toBe('applied');
  if (result.status !== 'applied') throw new Error(JSON.stringify(result));
  expect(result).toMatchObject({ originalSaleId: original.saleId, refundedCashMinor: 100, drawerCashDeltaMinor: -100, returnedUnits: 1, stockDisposition: 'QUARANTINE', availableStockDelta: 0, quarantineStockDelta: 1, margin: { revenueMinor: 0, cogsMinor: 0, grossMarginMinor: 0 } });
  expect(result.originalReceipt).toEqual(original.receipt);
  const stock = await owner.pharmacyStockBalance.findMany({ where: { inventoryLotId: f.input.inventoryLotId } });
  expect(stock).toHaveLength(2);
  expect(stock.find(b => b.disposition === 'AVAILABLE')).toMatchObject({ onHandUnits: 1, sealedPacks: 1, looseUnits: 0 });
  expect(stock.find(b => b.disposition === 'QUARANTINE')).toMatchObject({ stockLocationId: input.quarantineLocationId, onHandUnits: 1, sealedPacks: 0, looseUnits: 1 });
  const refund = await owner.pharmacyRefund.findUniqueOrThrow({ where: { id: result.refundId } });
  expect(refund).toMatchObject({ saleId: original.saleId, originalTenderId: original.tenderId, amountMinor: 100, providerRef: null, drawerSessionId: f.input.drawerSessionId });
  const drawer = await owner.pharmacyDrawerMovement.findMany({ where: { drawerSessionId: f.input.drawerSessionId } });
  expect(drawer).toHaveLength(2);
  expect(drawer.find(d => d.kind === 'CASH_REFUND')).toMatchObject({ amountMinor: 100 });
  const cashRows = drawer.map(d => { if (d.kind === 'CLOSING_COUNT') throw new Error('Unexpected closing count'); return { kind: d.kind, amountMinor: d.amountMinor }; });
  expect(foldExpectedCash(cashRows)).toBe(0);
  const journals = await owner.financeJournalEntry.findMany({ where: { id: { in: result.reversalJournalIds } }, include: { lines: true } });
  expect(journals).toHaveLength(2);
  for (const j of journals) expect(j.lines.reduce((sum, l) => sum + (l.side === 'DEBIT' ? l.amountMinor : -l.amountMinor), 0)).toBe(0);
  expect(journals.flatMap(j => j.lines).map(l => `${l.accountCode}:${l.side}:${l.amountMinor}`).sort()).toEqual(['CASH:CREDIT:100', 'SALES_CLEARING:DEBIT:100', 'SALES_CLEARING:CREDIT:100', 'SALES_REVENUE:DEBIT:100', 'INVENTORY:DEBIT:20', 'COST_OF_GOODS_SOLD:CREDIT:20'].sort());
  const after = await reversalSnapshot(f);
  expect((await invoke()).status).toBe('refused'); // Refusal proof, NOT root replay.
  expect(await reversalSnapshot(f)).toBe(after);
  expect(await sentinelSnapshot()).toBe(sentinel);
  expect((await snapshot(foreign)) + (await snapshot(legitimate))).toBe(sentinelBefore);
  console.log('NEW_RETURN_SQL', JSON.stringify({ original, result, stock, refund, drawer, journals, refusalInputs: 6, sentinelsUnchanged: true }));
}, 30000);

test('NEW full-return SQL late owning error rolls back reversal and preserves original cash', async () => {
  const { f, root, original, input, sentinelSnapshot } = await returnSetup(13990);
  const before = await reversalSnapshot(f);
  const sentinel = await sentinelSnapshot();
  const injected = new Error('QA1398_AFTER_FULL_RETURN_READBACK');
  await expect(withTenantDb(root.scope.organizationId, async tx => {
    const result = await executePharmacyDemoCashReturn(tx, root, original, input);
    expect(result.status).toBe('applied');
    expect(await tx.pharmacyRefund.count({ where: { originalTenderId: original.tenderId } })).toBe(1);
    throw injected;
  }, { userId: root.scope.actorId, timeout: 30000 })).rejects.toBe(injected);
  expect(await reversalSnapshot(f)).toBe(before);
  expect(await owner.pharmacySale.findUnique({ where: { id: original.saleId } })).toMatchObject({ status: 'COMPLETED', receiptNumber: original.receiptNumber });
  expect(await owner.pharmacyRefund.count({ where: { originalTenderId: original.tenderId } })).toBe(0);
  expect(await sentinelSnapshot()).toBe(sentinel);
  expect((await snapshot(foreign)) + (await snapshot(legitimate))).toBe(sentinelBefore);
  console.log('NEW_RETURN_ROLLBACK_SQL', JSON.stringify({ originalSaleId: original.saleId, originalTenderId: original.tenderId, snapshotEqual: true, sentinelsUnchanged: true, injected: injected.message }));
}, 30000);

test('GitHub101 corrected receiving-to-cash canonical UNIT SQL', async () => {
  const received = await fixture(13985, 1);
  const fractional = await fixture(13986, 3);
  const scope = received.root.scope;
  const before = await owner.pharmacyStockBalance.findMany({ where: { organizationId: scope.organizationId } });
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ inventoryLotId: received.input.inventoryLotId, onHandUnits: 2, sealedPacks: 2, looseUnits: 0 });
  const receiptMovement = await owner.pharmacyStockMovement.findMany({ where: { organizationId: scope.organizationId } });
  expect(receiptMovement).toHaveLength(1);
  expect(receiptMovement[0]).toMatchObject({ kind: 'RECEIPT', quantityUnits: 2, sealedPackDelta: 2, looseUnitDelta: 0 });
  const result = await withTenantDb(scope.organizationId, async tx => {
    expect(await tx.$queryRawUnsafe('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const policies = await tx.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('pharmacy_sales','pharmacy_tenders','pharmacy_stock_balances','pharmacy_stock_movements','finance_journal_entries','finance_journal_lines')");
    expect(policies).toHaveLength(6);
    policies.forEach(row => expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true }));
    expect(await tx.pharmacyInventoryLot.findFirst({ where: { id: foreign.input.inventoryLotId } })).toBeNull();
    return executePharmacyDemoCashSale(tx, received.root, received.input);
  }, { userId: scope.actorId, timeout: 30000 });
  expect(result.status).toBe('applied');
  if (result.status !== 'applied') throw new Error(JSON.stringify(result));
  expect(result).toMatchObject({ amountMinor: 100, cashReceivedMinor: 150, changeGivenMinor: 50, stockBefore: 2, stockAfter: 1, drawerMovementCountDelta: 1, drawerMoneyDeltaMinor: 100, receiptNumber: 1, margin: { revenueMinor: 100, cogsMinor: 20, grossMarginMinor: 80 } });
  const sale = await owner.pharmacySale.findUniqueOrThrow({ where: { id: result.saleId }, include: { lines: { include: { allocations: true } }, tenders: true } });
  expect(sale).toMatchObject({ status: 'COMPLETED', receiptNumber: 1, receiptDeviceId: received.input.deviceId });
  expect(sale.tenders).toHaveLength(1);
  expect(sale.tenders[0]).toMatchObject({ id: result.tenderId, amountMinor: 100, cashReceivedMinor: 150, changeGivenMinor: 50 });
  expect(sale.lines).toHaveLength(1);
  expect(sale.lines[0]!.allocations).toHaveLength(1);
  expect(sale.lines[0]!.allocations[0]).toMatchObject({ inventoryLotId: received.input.inventoryLotId, stockLocationId: received.input.stockLocationId, canonicalUnits: 1 });
  const after = await owner.pharmacyStockBalance.findMany({ where: { organizationId: scope.organizationId } });
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ onHandUnits: 1, sealedPacks: 1, looseUnits: 0 });
  const movements = await owner.pharmacyStockMovement.findMany({ where: { organizationId: scope.organizationId } });
  expect(movements).toHaveLength(2);
  expect(movements.find(m => m.kind === 'SALE')).toMatchObject({ inventoryLotId: received.input.inventoryLotId, quantityUnits: -1, sealedPackDelta: -1, looseUnitDelta: 0 });
  const drawer = await owner.pharmacyDrawerMovement.findMany({ where: { organizationId: scope.organizationId } });
  expect(drawer).toHaveLength(1);
  expect(drawer[0]).toMatchObject({ kind: 'CASH_SALE', amountMinor: 100 });
  const journals = await owner.financeJournalEntry.findMany({ where: { id: { in: result.journalEntryIds } }, include: { lines: true } });
  expect(journals).toHaveLength(2);
  for (const journal of journals) expect(journal.lines.reduce((n, l) => n + (l.side === 'DEBIT' ? l.amountMinor : -l.amountMinor), 0)).toBe(0);
  const legs = journals.flatMap(j => j.lines).map(l => [l.accountCode, l.side, l.amountMinor].join(':')).sort();
  expect(legs).toEqual(['CASH:DEBIT:100', 'COST_OF_GOODS_SOLD:DEBIT:20', 'INVENTORY:CREDIT:20', 'SALES_CLEARING:CREDIT:100', 'SALES_CLEARING:DEBIT:100', 'SALES_REVENUE:CREDIT:100'].sort());
  const fractionalBefore = await snapshot(fractional);
  expect(await owner.pharmacyStockBalance.findFirst({ where: { organizationId: fractional.root.scope.organizationId } })).toMatchObject({ onHandUnits: 6, sealedPacks: 2, looseUnits: 0 });
  const refused = await withTenantDb(fractional.root.scope.organizationId, tx => executePharmacyDemoCashSale(tx, fractional.root, fractional.input), { userId: fractional.root.scope.actorId });
  expect(refused.status).toBe('refused');
  expect(await snapshot(fractional)).toBe(fractionalBefore);
  expect((await snapshot(foreign)) + (await snapshot(legitimate))).toBe(sentinelBefore);
  console.log('GITHUB101_OBSERVED_SQL', JSON.stringify({ receivedLotId: received.input.inventoryLotId, before, receiptMovement, result, sale, after, movements, drawer, journals, legs, fractionalRefusal: refused, sentinelsUnchanged: true }));
}, 30000);

test('runtime is restricted; FORCE RLS hides foreign stock', async () => {
  await withTenantDb(fresh.root.scope.organizationId, async tx => {
    const roles = await tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const rows = await tx.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('pharmacy_sales','pharmacy_tenders','pharmacy_stock_balances','pharmacy_stock_movements','finance_journal_entries','finance_journal_lines')");
    expect(rows).toHaveLength(6);
    rows.forEach(row => expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true }));
    expect(await tx.pharmacyInventoryLot.findFirst({ where: { id: foreign.input.inventoryLotId } })).toBeNull();
  });
});

test('actual cash sale commits generated receipt, stock, drawer and balanced journals', async () => {
  const result = await withTenantDb(fresh.root.scope.organizationId, tx => executePharmacyDemoCashSale(tx, fresh.root, fresh.input), { timeout: 30000, userId: fresh.root.scope.actorId });
  expect(result.status).toBe('applied');
  if (result.status !== 'applied') throw new Error(JSON.stringify(result));
  expect(result).toMatchObject({ amountMinor: 33, cashReceivedMinor: 50, changeGivenMinor: 17, stockBefore: 3, stockAfter: 2, drawerMovementCountDelta: 1, drawerMoneyDeltaMinor: 33, receiptNumber: 1, margin: { revenueMinor: 33, cogsMinor: 20, grossMarginMinor: 13 } });
  const sale = await owner.pharmacySale.findUniqueOrThrow({ where: { id: result.saleId }, include: { lines: { include: { allocations: true } }, tenders: true } });
  expect(sale.status).toBe('COMPLETED');
  expect(sale.receiptDeviceId).toBe(fresh.input.deviceId);
  expect(sale.tenders).toHaveLength(1);
  expect(sale.tenders[0]).toMatchObject({ id: result.tenderId, amountMinor: 33, cashReceivedMinor: 50, changeGivenMinor: 17 });
  expect(sale.lines[0]!.allocations[0]).toMatchObject({ inventoryLotId: fresh.input.inventoryLotId, stockLocationId: fresh.input.stockLocationId, canonicalUnits: 1 });
  const journals = await owner.financeJournalEntry.findMany({ where: { id: { in: result.journalEntryIds } }, include: { lines: true } });
  expect(journals).toHaveLength(2);
  expect(journals.flatMap(j => j.lines)).toHaveLength(6);
  for (const journal of journals) expect(journal.lines.reduce((n, l) => n + (l.side === 'DEBIT' ? l.amountMinor : -l.amountMinor), 0)).toBe(0);
  console.log('OBSERVED_SQL', JSON.stringify({ saleId: result.saleId, tenderId: result.tenderId, receiptNumber: result.receiptNumber, receiptDeviceId: result.receiptDeviceId, journalEntryIds: result.journalEntryIds, allocationIds: result.allocationIds, stockMovementIds: result.stockMovementIds, records: result.records, margin: result.margin }));
});

test('foreign IDs, changed price, missing prerecords, legitimate actor and unsafe cash refuse', async () => {
  const before = await snapshot(late);
  const cases = [
    { root: late.root, input: { ...late.input, inventoryLotId: foreign.input.inventoryLotId } },
    { root: late.root, input: { ...late.input, expectedAmountMinor: 34 } },
    { root: { ...late.root, records: [] }, input: late.input },
    { root: legitimate.root, input: legitimate.input },
    { root: late.root, input: { ...late.input, cashReceivedMinor: Number.MAX_SAFE_INTEGER + 1 } },
  ];
  for (const item of cases) expect((await withTenantDb(item.root.scope.organizationId, tx => executePharmacyDemoCashSale(tx, item.root, item.input))).status).toBe('refused');
  expect(await snapshot(late)).toBe(before);
});

test('late owning-transaction error rolls back every cash-sale row; sentinels unchanged', async () => {
  const before = await snapshot(late);
  const injected = new Error('QA1398_INJECTED_AFTER_COMPLETE_READBACK');
  await expect(withTenantDb(late.root.scope.organizationId, async tx => {
    const result = await executePharmacyDemoCashSale(tx, late.root, late.input);
    expect(result.status).toBe('applied');
    throw injected;
  }, { timeout: 30000, userId: late.root.scope.actorId })).rejects.toBe(injected);
  expect(await snapshot(late)).toBe(before);
  expect((await snapshot(foreign)) + (await snapshot(legitimate))).toBe(sentinelBefore);
});
});
