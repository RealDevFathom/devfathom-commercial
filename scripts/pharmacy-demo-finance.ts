import { createHash } from 'node:crypto';
import { canonicalUnits, priceFromLot } from '../src/lib/pharmacy/medicine';

/** Internal tooling only. Root must validate identity, branch assignment, module
 * and report capabilities, approved references and receipt/tombstones FIRST.
 * These facts are not an authorization token and must never come from a client.
 * No DB client, transaction, executable main or mutation is owned here.
 */
export interface PharmacyDemoFinanceContext {
  organizationId: string;
  branchId: string;
  ownerUserId: string;
  namespace: string;
  businessDate: string;
  scenarioAt: string;
  timezone: string;
  currency: 'PKR';
  pharmacySalesEnabled: boolean;
  financialReportsAuthorized: boolean;
}

export interface PharmacyDemoFinanceStock {
  medicineId: string;
  presentationId: string;
  inventoryLotId: string;
  stockLocationId: string;
  printedMrpMinor: number;
  unitsPerPack: number;
  /** Real pre-approved conversion for each offered sale unit, supplied by root. */
  units: readonly {
    saleUnit: 'PACK' | 'STRIP' | 'UNIT';
    packLevelId: string;
    canonicalUnitsPerSaleUnit: number;
  }[];
}

export const pharmacyDemoFinanceGaps = [
  {
    scenario: 'open-sale',
    service: 'sales.createSale',
    reason:
      'OWNER-INPUT: createSale has no namespace/idempotency input. Root must supply atomic retained receipt binding and tombstone reconciliation before creating a draft.',
  },
  {
    scenario: 'sale-tender',
    service: 'sales.addSaleLine / settlement.applyPharmacyTender',
    reason:
      'OWNER-INPUT: approved stock, service actor, existing drawer/device and regulatory eligibility must be validated. addSaleLine allocates stock even while OPEN; replay must recover exact line/allocation refs before calling it again.',
  },
  {
    scenario: 'partial-full-return',
    service: 'sales.returnSaleLine / settlement.refundPharmacyTender',
    reason:
      'OWNER-INPUT: returnSaleLine chooses one allocation; stock return and refund are separate. Require supplied quarantine/integrity decision and exact allocation, tender, refund and journal reconciliation before replay.',
  },
  {
    scenario: 'void',
    service: 'sales.changeSaleStatus',
    reason:
      'OWNER-INPUT: void accepts OPEN only and reverses allocations; root must prove no prior tender and retain/reconcile the resulting state. It is not a refund workflow.',
  },
] as const;

function ref(value: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 128)
    throw new Error('INVALID_REFERENCE');
  return value;
}

function integer(value: number, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new Error('INVALID_ARITHMETIC');
  return value;
}

/** Fixed maximum: one approved lot, one example per PACK/STRIP/UNIT, quantity 1.
 * Arithmetic is a quote only: no allocated cost, revenue or stock proof implied.
 */
export function planPharmacyDemoFinance(
  context: PharmacyDemoFinanceContext,
  stock?: PharmacyDemoFinanceStock
) {
  const scope = {
    organizationId: ref(context.organizationId),
    branchId: ref(context.branchId),
    ownerUserId: ref(context.ownerUserId),
    namespace: ref(context.namespace),
  };
  if (!/^pharmacy-demo:[a-zA-Z0-9:_-]+$/.test(scope.namespace))
    throw new Error('INVALID_DEMO_NAMESPACE');
  if (context.currency !== 'PKR') throw new Error('INVALID_CURRENCY');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(context.businessDate) ||
    !Number.isFinite(Date.parse(context.businessDate)) ||
    new Date(context.businessDate).toISOString().slice(0, 10) !== context.businessDate
  )
    throw new Error('INVALID_BUSINESS_DATE');
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(context.scenarioAt) ||
    !Number.isFinite(Date.parse(context.scenarioAt))
  )
    throw new Error('INVALID_SCENARIO_AT');
  new Intl.DateTimeFormat('en', { timeZone: context.timezone }).format(
    new Date(context.scenarioAt)
  );
  const units = stock?.units ?? [];
  if (
    stock &&
    (units.length < 1 ||
      units.length > 3 ||
      new Set(units.map((unit) => unit.saleUnit)).size !== units.length)
  )
    throw new Error('INVALID_UNIT_EXAMPLES');
  const examples = stock
    ? [...units]
        .sort((a, b) => a.saleUnit.localeCompare(b.saleUnit))
        .map((unit) => {
          if (!['PACK', 'STRIP', 'UNIT'].includes(unit.saleUnit))
            throw new Error('INVALID_UNIT_EXAMPLES');
          const factor = integer(unit.canonicalUnitsPerSaleUnit, true);
          const pack = integer(stock.unitsPerPack, true);
          if (
            factor > pack ||
            pack % factor !== 0 ||
            (unit.saleUnit === 'PACK' && factor !== pack) ||
            (unit.saleUnit === 'UNIT' && factor !== 1)
          )
            throw new Error('INVALID_UNIT_EXAMPLES');
          const price = priceFromLot({
            printedMrpMinor: integer(stock.printedMrpMinor),
            canonicalUnitsInPack: pack,
            canonicalUnitsPerSaleUnit: factor,
          });
          return {
            ref: `${scope.namespace}:finance:${unit.saleUnit.toLowerCase()}`,
            medicineId: ref(stock.medicineId),
            presentationId: ref(stock.presentationId),
            inventoryLotId: ref(stock.inventoryLotId),
            stockLocationId: ref(stock.stockLocationId),
            packLevelId: ref(unit.packLevelId),
            saleUnit: unit.saleUnit,
            quantity: 1,
            canonicalUnits: canonicalUnits(1, [factor]),
            unitPriceMinor: integer(price.unitPriceMinor),
            proRataCeilingMinor: integer(price.proRataCeilingMinor),
          };
        })
    : [];
  const facts = {
    version: 1,
    scope,
    businessDate: context.businessDate,
    scenarioAt: new Date(context.scenarioAt).toISOString(),
    timezone: context.timezone,
    currency: context.currency,
    pharmacySalesEnabled: context.pharmacySalesEnabled,
    financialReportsAuthorized: context.financialReportsAuthorized,
    // Include source price even when rounding produces the same quote.
    sourcePrice: stock
      ? { printedMrpMinor: stock.printedMrpMinor, unitsPerPack: stock.unitsPerPack }
      : null,
    examples,
    gaps: pharmacyDemoFinanceGaps,
    coverage: 'ARITHMETIC_ONLY' as const,
    regulatory: 'UNSEEDED/OWNER-INPUT' as const,
    writesEnabled: false as const,
  };
  return { ...facts, hash: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
}

/** Matches finance-reports.grossMargin's result and scope/input. Root binds its
 * existing scoped transaction: (scope, input) => grossMargin(tx, scope, input).
 * No alternative accounting query or write adapter is accepted.
 */
export interface PharmacyDemoMarginRow {
  key: string | null;
  revenueMinor: number;
  discountMinor: number;
  cogsMinor: number;
  grossMarginMinor: number;
}
export type PharmacyDemoMarginReader = (
  scope: { organizationId: string; branchId: string },
  input: { from: Date; to: Date; by: 'line' }
) => Promise<PharmacyDemoMarginRow[]>;

/** Read-only domain execution. Supplied line IDs must already belong to this
 * namespace's retained receipt; caller validates ownership before this call.
 * Report output proves journal arithmetic only, never tender/stock/drawer proof.
 * Failed reads propagate: do not disguise outages as missing demo coverage.
 */
export async function executePharmacyDemoFinance(
  context: PharmacyDemoFinanceContext,
  stock: PharmacyDemoFinanceStock | undefined,
  expectedPlanHash: string,
  inspection?: {
    from: string;
    to: string;
    retainedSaleLineIds: readonly string[];
    readGrossMargin: PharmacyDemoMarginReader;
  }
) {
  const plan = planPharmacyDemoFinance(context, stock);
  if (plan.hash !== expectedPlanHash) throw new Error('PLAN_CHANGED');
  const base = {
    planHash: plan.hash,
    status: 'BLOCKED' as const,
    writes: 0,
    gaps: plan.gaps,
    moneyStockReconciled: false as const,
    drawerProof: false as const,
  };
  if (!inspection || !context.pharmacySalesEnabled || !context.financialReportsAuthorized)
    return { ...base, journalInspection: 'UNSEEDED/OWNER-INPUT' as const, rows: [] };
  const ids = inspection.retainedSaleLineIds;
  if (ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length)
    throw new Error('INVALID_RETAINED_LINES');
  ids.forEach(ref);
  const from = new Date(inspection.from),
    to = new Date(inspection.to);
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to ||
    to.getTime() - from.getTime() > 31 * 86400000
  )
    throw new Error('INVALID_REPORT_PERIOD');
  const rows = (
    await inspection.readGrossMargin(
      {
        organizationId: context.organizationId,
        branchId: context.branchId,
      },
      { from, to, by: 'line' }
    )
  ).filter((row) => row.key !== null && ids.includes(row.key));
  if (new Set(rows.map((row) => row.key)).size !== rows.length)
    throw new Error('DUPLICATE_REPORT_LINE');
  for (const row of rows) {
    const values = [row.revenueMinor, row.discountMinor, row.cogsMinor, row.grossMarginMinor];
    if (
      !values.every(Number.isSafeInteger) ||
      row.revenueMinor - row.discountMinor - row.cogsMinor !== row.grossMarginMinor
    )
      throw new Error('JOURNAL_MARGIN_MISMATCH');
  }
  return {
    ...base,
    journalInspection:
      rows.length === ids.length
        ? ('JOURNAL_ARITHMETIC_ONLY' as const)
        : ('MISSING_JOURNAL_LINES' as const),
    rows,
  };
}
