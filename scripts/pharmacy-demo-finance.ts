import { createHash } from 'node:crypto';
import { canonicalUnits, priceFromLot } from '../src/lib/pharmacy/medicine';
import { isPharmacyDemoNamespace } from './pharmacy-demo-contract';
import type {
  DemoGap,
  PharmacyDemoContext,
  PharmacyDemoPlan,
  PharmacyDemoResult,
} from './pharmacy-demo-contract';

/** Internal tooling only. Root must validate identity, branch assignment, module
 * and report capabilities, approved references and receipt/tombstones FIRST.
 * These facts are not an authorization token and must never come from a client.
 * No DB client, transaction, executable main or mutation is owned here.
 */
export type PharmacyDemoFinanceContext = PharmacyDemoContext;

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
  if (!isPharmacyDemoNamespace(scope.namespace)) throw new Error('INVALID_DEMO_NAMESPACE');
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
    // Observations bind the quote, but never authorize a service call.
    observations: canonicalObservations(context),
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
  const gaps: DemoGap[] = pharmacyDemoFinanceGaps.map((gap) => ({
    function: gap.service,
    status: 'OWNER-INPUT',
    reason: gap.reason,
  }));
  gaps.push({
    function: 'finance-reports.grossMargin',
    status: 'UNSEEDED',
    reason:
      'The data-only context cannot authorize a report or establish retained sale-line ownership. Require the genuine scoped service context and root receipt reconciliation; journal arithmetic alone is not money/stock proof.',
  });
  if (!stock)
    gaps.push({
      function: 'medicine.priceFromLot',
      status: 'OWNER-INPUT',
      reason:
        'Supply observed lot price and approved pack conversions; no stock reference was supplied.',
    });
  if (stock) {
    const required = [
      ['medicine', stock.medicineId],
      ['presentation', stock.presentationId],
      ['location', stock.stockLocationId],
      ...stock.units.map((unit) => ['pack', unit.packLevelId]),
    ];
    for (const [kind, id] of required) {
      const matches = context.references.filter((item) => item.kind === kind && item.id === id);
      if (
        matches.length !== 1 ||
        !matches[0]!.approved ||
        !matches[0]!.observedHash ||
        matches[0]!.organizationId !== context.organizationId ||
        matches[0]!.branchId !== context.branchId
      )
        gaps.push({
          function: 'finance.reference',
          status: 'OWNER-INPUT',
          reason: `Missing or ambiguous scoped observation: ${kind}:${id}`,
        });
    }
  }
  gaps.sort((a, b) => {
    const left = JSON.stringify(a),
      right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const plan = {
    lane: 'finance',
    namespace: scope.namespace,
    digest: createHash('sha256').update(JSON.stringify({ facts, gaps })).digest('hex'),
    // Quotes are not persistent records. No model/ID or expected posted facts invented.
    records: [],
    gaps,
  } satisfies PharmacyDemoPlan;
  return { ...facts, ...plan };
}

function canonicalObservations(context: PharmacyDemoContext) {
  const order = <T>(items: T[]) =>
    items.sort((a, b) => {
      const left = JSON.stringify(a),
        right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return {
    actors: order(
      context.actors.map((actor) => ({
        userId: actor.userId,
        actorId: actor.actorId,
        organizationId: actor.organizationId,
        branchId: actor.branchId,
        active: actor.active,
        synthetic: actor.synthetic,
        capabilities: [...actor.capabilities].sort(),
      }))
    ),
    references: order(
      context.references.map((item) => ({
        kind: item.kind,
        id: item.id,
        organizationId: item.organizationId,
        branchId: item.branchId,
        approved: item.approved,
        observedHash: item.observedHash,
      }))
    ),
    modules: order(context.modules.map((module) => ({ key: module.key, enabled: module.enabled }))),
  };
}

/** Pure assertion over genuine grossMargin output; not a DB execution adapter. */
export interface PharmacyDemoMarginRow {
  key: string | null;
  revenueMinor: number;
  discountMinor: number;
  cogsMinor: number;
  grossMarginMinor: number;
}
/** No runnable root/service contract has been supplied. Manual observations are
 * never authority, even when every approved/synthetic/capability flag is true.
 * Refuse before any service call; do not invent a transaction or callback adapter.
 */
export async function executePharmacyDemoFinance(
  context: PharmacyDemoFinanceContext,
  stock: PharmacyDemoFinanceStock | undefined,
  expectedPlanHash: string
): Promise<PharmacyDemoResult> {
  const plan = planPharmacyDemoFinance(context, stock);
  if (plan.digest !== expectedPlanHash)
    return { status: 'refused', unmetPrerequisites: ['PLAN_CHANGED'] };
  return {
    status: 'refused',
    unmetPrerequisites: plan.gaps.map((gap) => `${gap.function}: ${gap.reason}`),
  };
}

/** Root must establish retained-line ownership before supplying IDs. This pure
 * check never claims authorization, live revenue or tender/stock reconciliation.
 */
export function inspectPharmacyDemoJournalArithmetic(
  source: readonly PharmacyDemoMarginRow[],
  ids: readonly string[]
) {
  if (ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length)
    throw new Error('INVALID_RETAINED_LINES');
  ids.forEach(ref);
  const rows = source.filter((row) => row.key !== null && ids.includes(row.key));
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
    moneyStockReconciled: false as const,
    drawerProof: false as const,
    journalInspection:
      rows.length === ids.length
        ? ('JOURNAL_ARITHMETIC_ONLY' as const)
        : ('MISSING_JOURNAL_LINES' as const),
    rows,
  };
}
