import 'server-only';

import { outstandingTransferLine } from './transfer-manifest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { blockReasonFor } from './inventory';
import { loadStockCandidatesForRead } from './stock-ledger';
import { procurementBranchIds } from './procurement-access';
import {
  buildLostDemandAdvice,
  evaluateLostDemandTriggers,
  isAdviceSuppressed,
  resolveLostDemandTriggerConfig,
  type AlternateFact,
  type BranchStockFact,
  type DistributorFact,
  type LostDemandAdvice,
  type LostDemandEventFact,
  type LostDemandTriggerConfig,
} from './lost-demand-advice';

const DAY_MS = 86_400_000;
const MAX_EVENTS = 5_000;
const MAX_GROUPS = 25;
/**
 * Statuses of orders that still count as inbound. An open DRAFT counts too, so a
 * draft already raised from this advice is not suggested a second time.
 */
const OPEN_ORDER_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'SENT', 'RECEIVING'] as const;
/** Transfers not yet dispatched: requested or allocated stock still at the donor. */
const UNDISPATCHED_TRANSFER_STATUSES = ['DRAFT', 'ALLOCATED', 'APPROVED'] as const;
/** Transfers still owed to their destination. */
const OPEN_TRANSFER_STATUSES = [
  ...UNDISPATCHED_TRANSFER_STATUSES,
  'DISPATCHED',
  'PARTIALLY_RECEIVED',
  'EXCEPTION',
] as const;
const MAX_PENDING_TRANSFER_LINES = 500;
/** Statuses of orders whose terms a distributor actually agreed to supply. */
const PLACED_ORDER_STATUSES = ['APPROVED', 'SENT', 'RECEIVING'] as const;

export type LostDemandScope = { organizationId: string; branchId: string; actorId: string };

function normalized(value: string | null | undefined) {
  return (value ?? '').trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');
}

type StrengthRow = { ingredientId: string; value: { toString(): string }; unit: string };

/** Same salt and strength: identical ingredient, amount and unit set. */
export function saltStrengthKey(strengths: readonly StrengthRow[]) {
  return strengths
    .map((item) => `${item.ingredientId}:${item.value.toString()}:${normalized(item.unit)}`)
    .sort()
    .join('|');
}

export async function loadLostDemandTriggerConfig(
  db: ScopedDb,
  scope: LostDemandScope
): Promise<LostDemandTriggerConfig> {
  const row = await db.pharmacyLostDemandTriggerSetting.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
  });
  return resolveLostDemandTriggerConfig(row);
}

/**
 * Sellable units per branch: the stock ledger's own read (net of supplier claims
 * and customer restock reservations) with every INV-03 block applied, so expired,
 * recalled, quarantined or unreceived stock never counts as on hand or as surplus.
 */
async function availableUnits(
  db: ScopedDb,
  organizationId: string,
  medicineId: string,
  branchIds: readonly string[],
  at: Date
) {
  const totals = new Map<string, number>();
  for (const branchId of branchIds) {
    const candidates = await loadStockCandidatesForRead(
      db,
      { organizationId, branchId },
      medicineId
    );
    totals.set(
      branchId,
      candidates
        .filter((candidate) => blockReasonFor(candidate, { organizationId, branchId, at }) === null)
        .reduce((total, candidate) => total + candidate.availableUnits, 0)
    );
  }
  return totals;
}

/**
 * Daily demand per branch, each over that branch's own forecast window. Summed in
 * the database: one query per distinct window, one row per branch.
 */
async function dailyDemand(
  db: ScopedDb,
  organizationId: string,
  medicineId: string,
  windowByBranch: ReadonlyMap<string, number>,
  now: Date
) {
  const branchesByWindow = new Map<number, string[]>();
  for (const [branchId, days] of windowByBranch)
    branchesByWindow.set(days, [...(branchesByWindow.get(days) ?? []), branchId]);
  const rates = new Map<string, number>([...windowByBranch.keys()].map((id) => [id, 0]));
  for (const [days, branchIds] of branchesByWindow) {
    const sums = await db.pharmacySaleLine.groupBy({
      by: ['branchId'],
      where: {
        organizationId,
        branchId: { in: branchIds },
        medicineId,
        createdAt: { gte: new Date(now.getTime() - days * DAY_MS), lte: now },
        sale: { status: 'COMPLETED' },
      },
      _sum: { canonicalUnits: true },
    });
    for (const row of sums) rates.set(row.branchId, (row._sum.canonicalUnits ?? 0) / days);
  }
  return rates;
}

/**
 * Transfers already in motion for one medicine: units still owed to this branch
 * (requested, allocated, approved or in transit) count as on order, and units a
 * donor has been asked for but not yet dispatched are not offered again.
 */
async function pendingTransfers(
  db: ScopedDb,
  scope: LostDemandScope,
  medicineId: string,
  donorBranchIds: readonly string[]
) {
  const lines = await db.pharmacyInterbranchTransferLine.findMany({
    where: {
      ...outstandingTransferLine,
      organizationId: scope.organizationId,
      sourceLot: { batch: { medicineId } },
      transfer: {
        status: { in: [...OPEN_TRANSFER_STATUSES] },
        OR: [{ toBranchId: scope.branchId }, { fromBranchId: { in: [...donorBranchIds] } }],
      },
    },
    take: MAX_PENDING_TRANSFER_LINES + 1,
    select: {
      warehouseReservation: { select: { id: true } },
      quantityUnits: true,
      receivedUnits: true,
      transfer: { select: { fromBranchId: true, toBranchId: true, status: true } },
    },
  });
  // Never present a truncated set of transfers as the whole picture.
  if (lines.length > MAX_PENDING_TRANSFER_LINES)
    throw new Error('Pending transfers exceed the supported window.');
  let inboundUnits = 0;
  const committedByDonor = new Map<string, number>();
  const undispatched = new Set<string>(UNDISPATCHED_TRANSFER_STATUSES);
  for (const line of lines) {
    if (line.transfer.toBranchId === scope.branchId)
      inboundUnits += Math.max(0, line.quantityUnits - line.receivedUnits);
    // Warehouse reservations already moved these units out of AVAILABLE on the stock ledger.
    if (
      !line.warehouseReservation &&
      line.transfer.fromBranchId !== scope.branchId &&
      undispatched.has(line.transfer.status)
    )
      committedByDonor.set(
        line.transfer.fromBranchId,
        (committedByDonor.get(line.transfer.fromBranchId) ?? 0) + line.quantityUnits
      );
  }
  return { inboundUnits, committedByDonor };
}

async function onOrderUnits(db: ScopedDb, scope: LostDemandScope, medicineId: string) {
  const lines = await db.pharmacyPurchaseOrderLine.findMany({
    where: {
      organizationId: scope.organizationId,
      medicineId,
      purchaseOrder: { branchId: scope.branchId, status: { in: [...OPEN_ORDER_STATUSES] } },
    },
    select: {
      orderedCanonicalUnits: true,
      bonusCanonicalUnits: true,
      goodsReceiptLines: {
        where: { goodsReceipt: { status: 'POSTED' } },
        select: { acceptedCanonicalUnits: true, rejectedCanonicalUnits: true },
      },
    },
  });
  return lines.reduce((total, line) => {
    const settled = line.goodsReceiptLines.reduce(
      (sum, receipt) => sum + receipt.acceptedCanonicalUnits + receipt.rejectedCanonicalUnits,
      0
    );
    return total + Math.max(0, line.orderedCanonicalUnits + line.bonusCanonicalUnits - settled);
  }, 0);
}

/** The terms this branch itself was last supplied on; another branch's never leak in. */
async function distributorFacts(
  db: ScopedDb,
  scope: LostDemandScope,
  medicineId: string
): Promise<DistributorFact[]> {
  const lines = await db.pharmacyPurchaseOrderLine.findMany({
    where: {
      organizationId: scope.organizationId,
      medicineId,
      purchaseOrder: {
        branchId: scope.branchId,
        status: { in: [...PLACED_ORDER_STATUSES] },
        supplier: { active: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      packLevelId: true,
      canonicalUnitsPerPack: true,
      orderedPacks: true,
      bonusPacks: true,
      listPricePerPackMinor: true,
      discountBps: true,
      rebateBps: true,
      taxBps: true,
      taxCreditable: true,
      leadTimeDays: true,
      createdAt: true,
      purchaseOrder: {
        select: {
          id: true,
          supplierId: true,
          sentAt: true,
          supplier: { select: { name: true } },
          goodsReceipts: {
            where: { status: 'POSTED' },
            orderBy: { receivedAt: 'asc' },
            take: 1,
            select: { receivedAt: true },
          },
        },
      },
    },
  });
  const latest = new Map<string, DistributorFact>();
  for (const line of lines) {
    const order = line.purchaseOrder;
    if (latest.has(order.supplierId)) continue;
    const receivedAt = order.goodsReceipts[0]?.receivedAt;
    const observedLead =
      order.sentAt && receivedAt && receivedAt >= order.sentAt
        ? Math.ceil((receivedAt.getTime() - order.sentAt.getTime()) / DAY_MS)
        : null;
    latest.set(order.supplierId, {
      supplierId: order.supplierId,
      supplierName: order.supplier.name,
      medicineId,
      packLevelId: line.packLevelId,
      canonicalUnitsPerPack: line.canonicalUnitsPerPack,
      lastListPricePerPackMinor: line.listPricePerPackMinor,
      lastDiscountBps: line.discountBps,
      lastRebateBps: line.rebateBps ?? 0,
      lastTaxBps: line.taxBps ?? 0,
      lastTaxCreditable: line.taxCreditable ?? false,
      lastOrderedAt: line.createdAt,
      scheme:
        line.bonusPacks > 0 ? { buyPacks: line.orderedPacks, bonusPacks: line.bonusPacks } : null,
      leadTimeDays: line.leadTimeDays ?? observedLead,
    });
  }
  return [...latest.values()];
}

async function alternateFacts(
  db: ScopedDb,
  scope: LostDemandScope,
  medicine: { id: string; strengths: StrengthRow[] },
  now: Date
): Promise<AlternateFact[]> {
  const key = saltStrengthKey(medicine.strengths);
  if (!key) return [];
  const candidates = await db.medicine.findMany({
    where: {
      organizationId: scope.organizationId,
      id: { not: medicine.id },
      saleable: true,
      strengths: { some: { ingredientId: { in: medicine.strengths.map((s) => s.ingredientId) } } },
    },
    take: 50,
    select: { id: true, productName: true, brandName: true, strengths: true },
  });
  const matches = candidates.filter((row) => saltStrengthKey(row.strengths) === key);
  const alternates: AlternateFact[] = [];
  for (const row of matches.slice(0, 10)) {
    const stock = await availableUnits(db, scope.organizationId, row.id, [scope.branchId], now);
    const lastSale = await db.pharmacySaleLine.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        medicineId: row.id,
        sale: { status: 'COMPLETED' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        quantity: true,
        canonicalUnits: true,
        grossMinor: true,
        discountMinor: true,
        unitCostMinor: true,
      },
    });
    alternates.push({
      medicineId: row.id,
      label: row.brandName ?? row.productName,
      availableUnits: stock.get(scope.branchId) ?? 0,
      // Net of the line's recorded discount (promotion, voucher or manual), so a
      // discounted last sale never overstates the margin or its ranking.
      marginPerUnitMinor:
        lastSale && lastSale.canonicalUnits > 0
          ? Math.floor(
              (lastSale.grossMinor -
                lastSale.discountMinor -
                lastSale.unitCostMinor * lastSale.quantity) /
                lastSale.canonicalUnits
            )
          : null,
    });
  }
  return alternates;
}

/**
 * Read-only. Loads recorded facts for one branch and returns the advice cards whose
 * configured triggers fired and that a human has not ignored since the last request.
 */
export async function readLostDemandAdvice(
  db: ScopedDb,
  scope: LostDemandScope,
  now: Date = new Date()
): Promise<{ config: LostDemandTriggerConfig; currency: string; advice: LostDemandAdvice[] }> {
  const config = await loadLostDemandTriggerConfig(db, scope);
  const organization = await db.organization.findFirst({
    where: { id: scope.organizationId },
    select: { currency: true },
  });
  const currency = organization?.currency ?? 'PKR';
  const since = new Date(
    now.getTime() - Math.max(config.requestWindowDays, config.lossWindowDays) * DAY_MS
  );
  const rows = await db.unfulfilledDemandEvent.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      createdAt: { gte: since, lte: now },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_EVENTS + 1,
    select: {
      id: true,
      createdAt: true,
      saleId: true,
      visitId: true,
      visitType: true,
      status: true,
      estLossPkrMinor: true,
      requestedMedicineId: true,
      requestedText: true,
      strength: true,
      saleUnit: true,
      quantity: true,
      estimatedValueMinor: true,
      medicine: {
        select: { id: true, productName: true, brandName: true, strengths: true },
      },
    },
  });

  // Never present a truncated request count or walk-out denominator as complete.
  if (rows.length > MAX_EVENTS)
    throw new Error('Lost-demand history exceeds the supported window.');
  const isWalkOut = (row: (typeof rows)[number]) =>
    row.visitType ? row.visitType === 'WALK_OUT' : row.saleId === null;
  const medicines = new Map<string, { id: string; label: string; strengths: StrengthRow[] }>();
  const keyCounts = new Map<string, Map<string, number>>();
  const events: LostDemandEventFact[] = rows
    .filter((row) => row.status !== 'RECOVERED')
    .map((row) => {
      let demandKey: string;
      let label: string;
      if (row.medicine) {
        const salt = saltStrengthKey(row.medicine.strengths);
        demandKey = salt ? `salt:${salt}` : `sku:${row.medicine.id}`;
        label = row.medicine.brandName ?? row.medicine.productName;
        medicines.set(row.medicine.id, {
          id: row.medicine.id,
          label,
          strengths: row.medicine.strengths,
        });
        const counts = keyCounts.get(demandKey) ?? new Map<string, number>();
        counts.set(row.medicine.id, (counts.get(row.medicine.id) ?? 0) + 1);
        keyCounts.set(demandKey, counts);
      } else {
        demandKey = `text:${normalized(row.requestedText)}|${normalized(row.strength)}`.slice(
          0,
          300
        );
        label = [row.requestedText?.trim(), row.strength?.trim()].filter(Boolean).join(' ');
      }
      return {
        id: row.id,
        visitId: row.visitId,
        createdAt: row.createdAt,
        demandKey,
        medicineId: row.medicine?.id ?? null,
        label,
        // Only base units convert without a pack hierarchy; other units are left out.
        canonicalUnits: row.saleUnit === 'UNIT' ? row.quantity : null,
        estimatedValueMinor: row.estLossPkrMinor ?? row.estimatedValueMinor,
        walkOut: isWalkOut(row),
      };
    });

  const requestFrom = new Date(now.getTime() - config.requestWindowDays * DAY_MS);
  const completedSales = await db.pharmacySale.count({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'COMPLETED',
      createdAt: { gte: requestFrom, lte: now },
    },
  });
  const walkOuts = new Set(
    rows
      .filter((row) => isWalkOut(row) && row.createdAt.getTime() >= requestFrom.getTime())
      .map((row) => row.visitId ?? row.id)
  ).size;
  const triggers = evaluateLostDemandTriggers(events, { completedSales, walkOuts }, config, now);

  const decisions = await db.pharmacyLostDemandAdviceDecision.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      demandKey: { in: triggers.map((trigger) => trigger.demandKey) },
    },
    orderBy: { createdAt: 'desc' },
    select: { demandKey: true, createdAt: true },
  });
  const lastDecision = new Map<string, Date>();
  for (const row of decisions)
    if (!lastDecision.has(row.demandKey)) lastDecision.set(row.demandKey, row.createdAt);

  const allowedBranchIds = await procurementBranchIds(db, scope.organizationId, scope.actorId);
  const donorBranches = await db.pharmacyBranch.findMany({
    where: {
      organizationId: scope.organizationId,
      active: true,
      id: { not: scope.branchId, in: allowedBranchIds },
    },
    select: { id: true, name: true },
  });
  // Each donor keeps the reserve its own branch settings call for.
  const donorSettings = donorBranches.length
    ? await db.pharmacyLostDemandTriggerSetting.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: { in: donorBranches.map((branch) => branch.id) },
        },
      })
    : [];
  // Each donor's reserve uses its own settings throughout: its own cover days and
  // its own forecast window for the demand rate that cover multiplies.
  const donorPlanning = new Map(
    donorBranches.map((branch) => {
      const own = resolveLostDemandTriggerConfig(
        donorSettings.find((row) => row.branchId === branch.id)
      );
      return [
        branch.id,
        {
          coverageDays: own.defaultLeadTimeDays + own.safetyStockDays,
          forecastWindowDays: own.forecastWindowDays,
        },
      ];
    })
  );
  const forecastWindowByBranch = new Map<string, number>([
    [scope.branchId, config.forecastWindowDays],
    ...donorBranches.map(
      (branch) => [branch.id, donorPlanning.get(branch.id)!.forecastWindowDays] as const
    ),
  ]);

  const advice: LostDemandAdvice[] = [];
  for (const trigger of triggers) {
    if (advice.length >= MAX_GROUPS) break;
    if (isAdviceSuppressed(trigger, lastDecision.get(trigger.demandKey))) continue;
    const counts = keyCounts.get(trigger.demandKey);
    const primaryId = counts
      ? [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
      : null;
    const primary = primaryId ? (medicines.get(primaryId) ?? null) : null;
    if (!primary) {
      advice.push(
        buildLostDemandAdvice({
          trigger,
          config,
          medicineId: null,
          dailyDemandUnits: 0,
          onHandUnits: 0,
          onOrderUnits: 0,
          distributors: [],
          alternates: [],
          donors: [],
          currency,
        })
      );
      continue;
    }
    const branchIds = [scope.branchId, ...donorBranches.map((branch) => branch.id)];
    const [stock, demand, inbound, distributors, alternates, transfers] = await Promise.all([
      availableUnits(db, scope.organizationId, primary.id, branchIds, now),
      dailyDemand(db, scope.organizationId, primary.id, forecastWindowByBranch, now),
      onOrderUnits(db, scope, primary.id),
      distributorFacts(db, scope, primary.id),
      alternateFacts(db, scope, primary, now),
      pendingTransfers(
        db,
        scope,
        primary.id,
        donorBranches.map((branch) => branch.id)
      ),
    ]);
    const donors: BranchStockFact[] = donorBranches.map((branch) => ({
      branchId: branch.id,
      branchName: branch.name,
      availableUnits: Math.max(
        0,
        (stock.get(branch.id) ?? 0) - (transfers.committedByDonor.get(branch.id) ?? 0)
      ),
      dailyDemandUnits: demand.get(branch.id) ?? 0,
      coverageDays: donorPlanning.get(branch.id)?.coverageDays,
    }));
    advice.push(
      buildLostDemandAdvice({
        trigger: { ...trigger, label: primary.label },
        config,
        medicineId: primary.id,
        dailyDemandUnits: demand.get(scope.branchId) ?? 0,
        onHandUnits: stock.get(scope.branchId) ?? 0,
        onOrderUnits: inbound + transfers.inboundUnits,
        distributors,
        alternates,
        donors,
        currency,
      })
    );
  }
  return { config, currency, advice };
}
