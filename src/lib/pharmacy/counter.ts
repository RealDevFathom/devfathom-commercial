/**
 * PH-POS — the counter's read side (POS-02 search, the FEFO cart, POS-08
 * receipts).
 *
 * Every decision this module reports is made by an existing kernel rather than
 * re-derived here: `blockReasonFor` decides what is sellable (INV-03),
 * `planAllocation`'s FEFO order decides the nearest safe expiry (INV-02),
 * `priceFromLot` decides price (MED-08), and `resolveCounterSaleUnits` decides the
 * pack/strip/unit toggle. A counter that computed its own "what is safe" rule
 * would eventually disagree with the ledger that actually posts the sale.
 *
 * READ-ONLY. Nothing here writes, allocates, or issues a receipt number.
 */

import { counterLabel } from './counter-label';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  blockReasonFor,
  type AllocationCandidate,
  type BlockReason,
  type StockDisposition,
} from './inventory';
import {
  previewSaleLine,
  resolveCounterSaleUnits,
  type CounterPackMismatch,
  type SaleUnitKind,
  type SaleUnitOption,
} from './counter-pricing';
import { counterReceiptTotals, type CounterReceipt } from './counter-receipt';
import { mrpRoundingIncrementForLot, normalizeMedicineText } from './medicine';
import { readReceiptIdentity } from './receipt-identity';
import type { LedgerScope } from './stock-ledger';

export class PharmacyCounterError extends Error {
  constructor(readonly reason: 'NOT_FOUND' | 'CROSS_BRANCH_REFERENCE' | 'INVALID_QUERY') {
    super(reason);
  }
}

export type CounterScope = Pick<LedgerScope, 'organizationId' | 'branchId'>;

/** How a row was reached, so the operator can trust an unfamiliar match. */
export type CounterMatchKind = 'BARCODE' | 'ALIAS' | 'NAME' | 'INGREDIENT' | 'PRESENTATION';

export type CounterSearchRow = {
  medicineId: string;
  displayName: string;
  brandName: string | null;
  manufacturer: string | null;
  /** Rendered strength components, for example `500 mg + 30 mg`. */
  strength: string | null;
  presentationId: string;
  presentation: string;
  dosageForm: string | null;
  route: string | null;
  matchedOn: CounterMatchKind;
  /** The lot FEFO would draw from first; null when nothing is sellable. */
  recommendedLotId: string | null;
  packLevelId: string | null;
  unitsPerPack: number | null;
  printedMrpMinor: number | null;
  roundingIncrementMinor: number;
  batchNumber: string | null;
  /** ISO instant of the nearest SAFE expiry; null when nothing is sellable. */
  nearestSafeExpiry: string | null;
  /** Safe canonical units on hand for this branch (blocked stock excluded). */
  onHandUnits: number;
  /** The saleable arrangement, per available sale unit (POS-02). */
  saleableUnits: Array<{
    kind: SaleUnitKind;
    levelLabel: string;
    canonicalUnitsPerSaleUnit: number;
    wholeUnits: number;
    unitPriceMinor: number;
    proRataCeilingMinor: number;
  }>;
  saleUnits: SaleUnitOption[];
  /**
   * DEV-724: set only when stock is on hand but neither the received lot nor the
   * medicine's own pack setup yields a priceable sale unit, so the counter can
   * say what to fix instead of guessing.
   */
  packMismatch?: CounterPackMismatch | null;
  restriction: {
    rx: boolean;
    otc: boolean;
    restricted: boolean;
    controlled: boolean;
    highAlert: boolean;
    lasa: boolean;
  };
  storage: {
    coldChain: boolean;
    /** The location kind holding the recommended lot, for the shelf marker. */
    locationKind: string | null;
    locationCode: string | null;
    /** Actual location name for the recommended FEFO lot; never inferred. */
    locationName?: string | null;
  };
  /** Why otherwise-present stock cannot be sold, deduplicated (INV-03). */
  blocked: BlockReason[];
};

type LotRow = {
  id: string;
  packLevelId: string;
  unitsPerPack: number;
  printedMrpMinor: number;
  receivedAt: Date | null;
  batch: { batchNumber: string; expiresAt: Date; state: string; medicineId: string };
};

type BalanceRow = {
  inventoryLotId: string;
  stockLocationId: string;
  disposition: StockDisposition;
  onHandUnits: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * A strength component as a counter reads it: `500 mg`, `2.5 mg`, `500 mg + 30 mg`.
 *
 * Only FRACTIONAL trailing zeros are trimmed. Trimming them positionally would
 * turn a `500` stored as a Decimal into `5` — a hundredfold strength error on
 * the one field a pharmacist reads back before handing the medicine over.
 */
export function renderStrengthValue(value: unknown): string {
  const raw = String(value);
  return raw.includes('.') ? raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : raw;
}

function renderStrength(components: readonly { value: unknown; unit: string }[]): string | null {
  if (components.length === 0) return null;
  return components
    .map((component) => `${renderStrengthValue(component.value)} ${component.unit}`)
    .join(' + ');
}

/**
 * POS-02: every field a counter searches by.
 *
 * A scanned barcode is resolved by exact normalized code and wins outright —
 * a gun that resolves to a fuzzy name match is a gun that sells the wrong
 * medicine. Everything else is a prefix/substring match on the normalized
 * forms MED-03 already stores.
 */
async function matchMedicineIds(
  db: ScopedDb,
  scope: CounterScope,
  query: string,
  limit: number
): Promise<Map<string, { kind: CounterMatchKind; rank: number }>> {
  const trimmed = query.trim();
  if (trimmed.length < 2) throw new PharmacyCounterError('INVALID_QUERY');
  const normalized = normalizeMedicineText(trimmed);
  const matches = new Map<string, { kind: CounterMatchKind; rank: number }>();
  const remember = (medicineId: string, kind: CounterMatchKind, rank: number) => {
    const existing = matches.get(medicineId);
    if (!existing || rank < existing.rank) matches.set(medicineId, { kind, rank });
  };

  const barcode = normalized
    ? await db.medicineBarcode.findFirst({
        where: {
          organizationId: scope.organizationId,
          normalizedCode: normalized,
          presentation: { medicine: { saleable: true } },
        },
        select: { presentation: { select: { medicineId: true } } },
      })
    : null;
  if (barcode) {
    // DEV-575: a scanned code that resolves exactly is the answer. Skipping the
    // fuzzy lookups keeps scan-to-cart to one indexed read, and a lone row lets
    // the scanner path add it without a pick list.
    remember(barcode.presentation.medicineId, 'BARCODE', 0);
    return matches;
  }

  // Read prefixes before substrings so a limited alphabetical substring read
  // cannot discard the relevant medicine. Each stage remains bounded and its
  // independent reads run together (DEV-575).
  const textMatches = async (operator: 'startsWith' | 'contains') => {
    const text = { [operator]: trimmed, mode: 'insensitive' as const };
    return Promise.all([
      db.medicine.findMany({
        where: {
          organizationId: scope.organizationId,
          saleable: true,
          OR: [
            { productName: text },
            { brandName: text },
            { manufacturer: text },
            { drapRegistrationNumber: text },
          ],
        },
        select: { id: true },
        orderBy: [{ productName: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      }),
      db.medicineStrengthComponent.findMany({
        where: {
          organizationId: scope.organizationId,
          medicine: { saleable: true },
          OR: [{ ingredient: { name: text } }, { unit: text }],
        },
        select: { medicineId: true },
        orderBy: [{ medicineId: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      }),
      db.presentation.findMany({
        where: {
          organizationId: scope.organizationId,
          medicine: { saleable: true },
          OR: [{ presentation: text }, { dosageForm: text }, { route: text }],
        },
        select: { medicineId: true },
        orderBy: [{ medicineId: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      }),
    ]);
  };
  const [aliases, prefixes] = await Promise.all([
    normalized
      ? db.medicineAlias.findMany({
          where: {
            organizationId: scope.organizationId,
            normalizedValue: { startsWith: normalized },
            medicine: { saleable: true },
          },
          select: { medicineId: true },
          orderBy: [{ normalizedValue: 'asc' }, { medicineId: 'asc' }],
          take: limit + 1,
        })
      : Promise.resolve([] as { medicineId: string }[]),
    textMatches('startsWith'),
  ]);
  for (const alias of aliases) remember(alias.medicineId, 'ALIAS', 2);
  const rememberText = (
    [byName, byIngredient, byPresentation]: Awaited<ReturnType<typeof textMatches>>,
    ranks: readonly [number, number, number]
  ) => {
    for (const medicine of byName) remember(medicine.id, 'NAME', ranks[0]);
    for (const component of byIngredient) remember(component.medicineId, 'INGREDIENT', ranks[1]);
    for (const presentation of byPresentation)
      remember(presentation.medicineId, 'PRESENTATION', ranks[2]);
  };
  rememberText(prefixes, [1, 3, 4]);
  if (matches.size <= limit) rememberText(await textMatches('contains'), [5, 6, 7]);

  return matches;
}

function candidateFrom(scope: CounterScope, lot: LotRow, balance: BalanceRow): AllocationCandidate {
  return {
    inventoryLotId: lot.id,
    stockLocationId: balance.stockLocationId,
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    batchState: lot.batch.state as AllocationCandidate['batchState'],
    disposition: balance.disposition,
    expiresAt: lot.batch.expiresAt,
    receivedAt: lot.receivedAt,
    availableUnits: balance.onHandUnits,
  };
}

/**
 * POS-02 result rows for one branch.
 *
 * A medicine with no sellable stock is still returned — with `onHandUnits: 0`
 * and its block reasons — because "we do not have it" is the answer that lets
 * the operator raise a POS-10 demand event, and hiding the row would make the
 * counter look like the medicine does not exist.
 */
export async function searchCounterCatalog(
  db: ScopedDb,
  scope: CounterScope,
  input: { query: string; limit?: number; at?: Date }
): Promise<{ rows: CounterSearchRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const at = input.at ?? new Date();
  const matches = await matchMedicineIds(db, scope, input.query, limit);
  const medicineIds = [...matches.keys()];
  if (medicineIds.length > limit) {
    // Relevance must decide admission too, before hydration. Keep the original
    // read order when all candidates fit; it has no bearing on displayed rank.
    medicineIds.sort((left, right) => matches.get(left)!.rank - matches.get(right)!.rank);
    medicineIds.length = limit;
  }
  if (medicineIds.length === 0) return { rows: [], truncated: false };

  const [medicines, lots, packLevels, mrps] = await Promise.all([
    db.medicine.findMany({
      where: { organizationId: scope.organizationId, id: { in: medicineIds }, saleable: true },
      include: {
        strengths: { include: { ingredient: { select: { name: true } } } },
        presentations: { orderBy: { createdAt: 'asc' } },
      },
    }),
    db.pharmacyInventoryLot.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        batch: { medicineId: { in: medicineIds } },
      },
      select: {
        id: true,
        packLevelId: true,
        unitsPerPack: true,
        printedMrpMinor: true,
        receivedAt: true,
        batch: {
          select: { batchNumber: true, expiresAt: true, state: true, medicineId: true },
        },
      },
    }),
    db.packLevel.findMany({
      where: {
        organizationId: scope.organizationId,
        presentation: { medicineId: { in: medicineIds } },
      },
      select: {
        id: true,
        level: true,
        parentPackLevelId: true,
        unitsPerParent: true,
        presentationId: true,
        effectiveFrom: true,
        effectiveTo: true,
        versionGroupId: true,
      },
    }),
    db.medicinePackMrp.findMany({
      where: {
        organizationId: scope.organizationId,
        packLevel: { presentation: { medicineId: { in: medicineIds } } },
      },
      select: { packLevelId: true, batchReference: true, roundingIncrementMinor: true },
    }),
  ]);

  const lotIds = lots.map((lot) => lot.id);
  const balances = lotIds.length
    ? await db.pharmacyStockBalance.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          inventoryLotId: { in: lotIds },
        },
        select: {
          inventoryLotId: true,
          stockLocationId: true,
          disposition: true,
          onHandUnits: true,
        },
      })
    : [];

  const locationIds = [...new Set(balances.map((balance) => balance.stockLocationId))];
  const locations = locationIds.length
    ? await db.pharmacyStockLocation.findMany({
        where: { organizationId: scope.organizationId, id: { in: locationIds } },
        select: { id: true, kind: true, code: true, name: true },
      })
    : [];
  const locationById = new Map(locations.map((location) => [location.id, location]));

  const lotsByMedicine = new Map<string, LotRow[]>();
  for (const lot of lots) {
    const bucket = lotsByMedicine.get(lot.batch.medicineId) ?? [];
    bucket.push(lot as LotRow);
    lotsByMedicine.set(lot.batch.medicineId, bucket);
  }
  const balancesByLot = new Map<string, BalanceRow[]>();
  for (const balance of balances) {
    const bucket = balancesByLot.get(balance.inventoryLotId) ?? [];
    bucket.push(balance as BalanceRow);
    balancesByLot.set(balance.inventoryLotId, bucket);
  }
  const packLevelsByPresentation = new Map<string, (typeof packLevels)[number][]>();
  for (const level of packLevels) {
    const bucket = packLevelsByPresentation.get(level.presentationId) ?? [];
    bucket.push(level);
    packLevelsByPresentation.set(level.presentationId, bucket);
  }
  const presentationByPackLevel = new Map(
    packLevels.map((level) => [level.id, level.presentationId])
  );
  const levelLabelByPackLevel = new Map(packLevels.map((level) => [level.id, level.level]));

  const rows: CounterSearchRow[] = [];
  for (const medicine of medicines) {
    const scope_ = { organizationId: scope.organizationId, branchId: scope.branchId, at };
    const medicineLots = lotsByMedicine.get(medicine.id) ?? [];

    let onHandUnits = 0;
    const blocked = new Set<BlockReason>();
    let best: { lot: LotRow; locationId: string } | null = null;
    const sellableLots = new Map<string, LotRow>();

    for (const lot of medicineLots) {
      for (const balance of balancesByLot.get(lot.id) ?? []) {
        const candidate = candidateFrom(scope, lot, balance);
        const reason = blockReasonFor(candidate, scope_);
        if (reason !== null) {
          // EMPTY is an exhausted bucket, not a condition an operator acts on.
          if (reason !== 'EMPTY') blocked.add(reason);
          continue;
        }
        onHandUnits += balance.onHandUnits;
        sellableLots.set(lot.id, lot);
        const better =
          best === null ||
          lot.batch.expiresAt.getTime() < best.lot.batch.expiresAt.getTime() ||
          (lot.batch.expiresAt.getTime() === best.lot.batch.expiresAt.getTime() &&
            lot.id.localeCompare(best.lot.id) < 0);
        if (better) best = { lot, locationId: balance.stockLocationId };
      }
    }

    const presentationId =
      (best && presentationByPackLevel.get(best.lot.packLevelId)) ??
      medicine.presentations[0]?.id ??
      null;
    if (!presentationId) continue;
    const presentation =
      medicine.presentations.find((entry) => entry.id === presentationId) ??
      medicine.presentations[0]!;

    let saleUnits: SaleUnitOption[] = [];
    let packMismatch: CounterPackMismatch | null = null;
    if (best) {
      // A lot whose received pack disagrees with the medicine's pack setup is
      // still sold through that setup, priced from the same lot exactly as the
      // server prices the line; only a setup that cannot price it reports why.
      ({ saleUnits, packMismatch } = resolveCounterSaleUnits({
        packLevels: packLevelsByPresentation.get(presentationId) ?? [],
        lotPackLevelId: best.lot.packLevelId,
        lotPackLevelLabel: levelLabelByPackLevel.get(best.lot.packLevelId) ?? null,
        lotUnitsPerPack: best.lot.unitsPerPack,
        otherLotUnitsPerPack: [...sellableLots.values()]
          .filter((lot) => lot.id !== best!.lot.id)
          .map((lot) => lot.unitsPerPack),
        dosageForm: presentation.dosageForm,
        at,
      }));
    }

    // The same (pack level, batch) lookup the sale writer uses, so the quoted
    // price is the charged price even when batches carry different increments.
    const roundingIncrementMinor = best
      ? mrpRoundingIncrementForLot(mrps, {
          packLevelId: best.lot.packLevelId,
          batchNumber: best.lot.batch.batchNumber,
        })
      : 1;

    const saleableUnits = best
      ? saleUnits.map((option) => {
          const preview = previewSaleLine({
            option,
            quantity: 1,
            printedMrpMinor: best!.lot.printedMrpMinor,
            unitsPerPack: best!.lot.unitsPerPack,
            roundingIncrementMinor,
            availableUnits: onHandUnits,
          });
          return {
            kind: option.kind,
            levelLabel: option.levelLabel,
            canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
            wholeUnits: Math.floor(onHandUnits / option.canonicalUnitsPerSaleUnit),
            unitPriceMinor: preview.unitPriceMinor,
            proRataCeilingMinor: preview.proRataCeilingMinor,
          };
        })
      : [];

    const location = best ? locationById.get(best.locationId) : undefined;
    rows.push({
      medicineId: medicine.id,
      displayName: medicine.productName,
      brandName: medicine.brandName,
      manufacturer: medicine.manufacturer,
      strength: renderStrength(medicine.strengths),
      presentationId,
      presentation: presentation.presentation,
      dosageForm: presentation.dosageForm,
      route: presentation.route,
      matchedOn: matches.get(medicine.id)?.kind ?? 'NAME',
      recommendedLotId: best?.lot.id ?? null,
      packLevelId: best?.lot.packLevelId ?? null,
      unitsPerPack: best?.lot.unitsPerPack ?? null,
      printedMrpMinor: best?.lot.printedMrpMinor ?? null,
      roundingIncrementMinor,
      batchNumber: best?.lot.batch.batchNumber ?? null,
      nearestSafeExpiry: best?.lot.batch.expiresAt.toISOString() ?? null,
      onHandUnits,
      saleableUnits,
      saleUnits,
      packMismatch,
      restriction: {
        rx: medicine.rx,
        otc: medicine.otc,
        restricted: medicine.restricted,
        controlled: medicine.controlled,
        highAlert: medicine.highAlert,
        lasa: medicine.lasa,
      },
      storage: {
        coldChain: medicine.coldChain,
        locationKind: location?.kind ?? null,
        locationCode: location?.code ?? null,
        locationName: location?.name ?? null,
      },
      blocked: [...blocked].sort(),
    });
  }

  rows.sort(
    (left, right) =>
      (matches.get(left.medicineId)?.rank ?? 8) - (matches.get(right.medicineId)?.rank ?? 8) ||
      Number(right.onHandUnits > 0) - Number(left.onHandUnits > 0) ||
      left.displayName.localeCompare(right.displayName) ||
      left.medicineId.localeCompare(right.medicineId)
  );
  return { rows, truncated: matches.size > medicineIds.length };
}

export type CounterCartLine = {
  saleLineId: string;
  medicineId: string;
  medicineName: string;
  strength: string | null;
  presentation: string;
  saleUnit: SaleUnitKind;
  quantity: number;
  canonicalUnits: number;
  unitPriceMinor: number;
  proRataCeilingMinor: number;
  discountMinor: number;
  /** #727: the automatic promotion that priced this line, as issued. */
  promotionName?: string | null;
  lineTotalMinor: number;
  rx: boolean;
  controlled: boolean;
  restricted: boolean;
  highAlert: boolean;
  lasa: boolean;
  coldChain: boolean;
  /** #724: active salts from the ingredient graph, for the duplicate-salt notice. */
  activeIngredients?: Array<{ ingredientId: string; name: string }>;
  /** An emergency controlled supply was recorded for this line (open follow-up). */
  emergencySupply: boolean;
  /** DEV-629: the prescription line a pharmacist attached to this sale line, if any. */
  prescriptionLineId?: string | null;
  /** DEV-629: a pharmacist signed the RX-03 review of this sale line (its sale release). */
  prescriptionSigned?: boolean;
  /** What FEFO actually took, batch by batch (POS-03: cart shows allocation). */
  allocations: Array<{
    inventoryLotId: string;
    batchNumber: string;
    expiresAt: string;
    canonicalUnits: number;
    stockLocationCode: string | null;
    /** True when this lot is not the one FEFO recommended first. */
    overridden: boolean;
  }>;
};

/** #722: one recorded payment row of a (possibly split) bill. */
export type CounterCartTender = {
  tenderId: string;
  type: string;
  amountMinor: number;
};

export type CounterCart = {
  saleId: string;
  status: string;
  receiptNumber: number | null;
  lines: CounterCartLine[];
  /** Recorded payments in the order taken; optional for older cached responses. */
  tenders?: CounterCartTender[];
  totals: { grossMinor: number; discountMinor: number; netMinor: number; tenderedMinor: number };
};

async function saleInScope(db: ScopedDb, scope: CounterScope, saleId: string) {
  const sale = await db.pharmacySale.findFirst({
    where: { id: saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: {
      tenders: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      lines: {
        orderBy: { createdAt: 'asc' },
        include: {
          medicine: {
            include: { strengths: { include: { ingredient: { select: { name: true } } } } },
          },
          presentation: true,
          allocations: {
            orderBy: { id: 'asc' },
            include: {
              lot: { include: { batch: true } },
            },
          },
        },
      },
    },
  });
  if (!sale) throw new PharmacyCounterError('CROSS_BRANCH_REFERENCE');
  return sale;
}

/** The open bill, with the FEFO allocation each line actually drew. */
export async function readCounterCart(
  db: ScopedDb,
  scope: CounterScope,
  saleId: string
): Promise<CounterCart> {
  const sale = await saleInScope(db, scope, saleId);
  const locationIds = [
    ...new Set(sale.lines.flatMap((line) => line.allocations.map((a) => a.stockLocationId))),
  ];
  const locations = locationIds.length
    ? await db.pharmacyStockLocation.findMany({
        where: { organizationId: scope.organizationId, id: { in: locationIds } },
        select: { id: true, code: true },
      })
    : [];
  const locationById = new Map(locations.map((location) => [location.id, location.code]));
  const controlledLineIds = sale.lines
    .filter((line) => line.medicine.controlled)
    .map((line) => line.id);
  const emergencyFollowUps = controlledLineIds.length
    ? await db.pharmacyEmergencyRxFollowUp.findMany({
        where: { organizationId: scope.organizationId, saleLineId: { in: controlledLineIds } },
        select: { saleLineId: true },
      })
    : [];
  const emergencyLineIds = new Set(emergencyFollowUps.map((row) => row.saleLineId));
  // DEV-629: settlement releases a referenced non-controlled line only on a signed RX-03 review.
  const referencedLineIds = sale.lines
    .filter((line) => !line.medicine.controlled && line.prescriptionLineId)
    .map((line) => line.id);
  const signedReviews = referencedLineIds.length
    ? await db.pharmacyPharmacistReviewItem.findMany({
        where: {
          organizationId: scope.organizationId,
          saleLineId: { in: referencedLineIds },
          decisions: { some: { kind: 'SIGN', signedAt: { not: null } } },
        },
        select: { saleLineId: true },
      })
    : [];
  const signedLineIds = new Set(signedReviews.map((row) => row.saleLineId));

  const lines: CounterCartLine[] = sale.lines.map((line) => {
    // The earliest expiry among this line's own allocations is what FEFO would
    // have taken first; anything later on the same line was a batch override.
    const earliest = line.allocations.reduce<Date | null>(
      (best, allocation) =>
        best === null || allocation.lot.batch.expiresAt.getTime() < best.getTime()
          ? allocation.lot.batch.expiresAt
          : best,
      null
    );
    return {
      saleLineId: line.id,
      medicineId: line.medicineId,
      medicineName: line.medicine.productName,
      strength: renderStrength(line.medicine.strengths),
      presentation: line.presentation.presentation,
      saleUnit: line.saleUnit as SaleUnitKind,
      quantity: line.quantity,
      canonicalUnits: line.canonicalUnits,
      unitPriceMinor: line.unitPriceMinor,
      proRataCeilingMinor: line.proRataCeilingMinor,
      discountMinor: line.discountMinor,
      promotionName: line.promotionName,
      lineTotalMinor: line.grossMinor - line.discountMinor,
      rx: line.medicine.rx,
      controlled: line.medicine.controlled,
      restricted: line.medicine.restricted,
      highAlert: line.medicine.highAlert,
      lasa: line.medicine.lasa,
      coldChain: line.medicine.coldChain,
      activeIngredients: line.medicine.strengths.map((component) => ({
        ingredientId: component.ingredientId,
        name: component.ingredient.name,
      })),
      emergencySupply: emergencyLineIds.has(line.id),
      prescriptionLineId: line.prescriptionLineId,
      prescriptionSigned: signedLineIds.has(line.id),
      allocations: line.allocations.map((allocation) => ({
        inventoryLotId: allocation.inventoryLotId,
        batchNumber: allocation.lot.batch.batchNumber,
        expiresAt: allocation.lot.batch.expiresAt.toISOString(),
        canonicalUnits: allocation.canonicalUnits,
        stockLocationCode: locationById.get(allocation.stockLocationId) ?? null,
        overridden:
          earliest !== null && allocation.lot.batch.expiresAt.getTime() > earliest.getTime(),
      })),
    };
  });

  const grossMinor = sale.lines.reduce((total, line) => total + line.grossMinor, 0);
  const discountMinor = lines.reduce((total, line) => total + line.discountMinor, 0);
  return {
    saleId: sale.id,
    status: sale.status,
    receiptNumber: sale.receiptNumber,
    lines,
    // Allowlisted: actor, device and provider references stay server-side.
    tenders: sale.tenders.map((tender) => ({
      tenderId: tender.id,
      type: tender.type,
      amountMinor: tender.amountMinor,
    })),
    totals: {
      grossMinor,
      discountMinor,
      netMinor: grossMinor - discountMinor,
      tenderedMinor: sale.tenders.reduce((total, tender) => total + tender.amountMinor, 0),
    },
  };
}

/**
 * POS-08: the receipt model for one sale.
 *
 * Purely derived. Reprinting calls this again and gets the same receipt number,
 * because only `applyPharmacyTender` can issue one.
 */
export async function readCounterReceipt(
  db: ScopedDb,
  scope: CounterScope,
  saleId: string,
  branch: { name: string; currency: string }
): Promise<CounterReceipt> {
  const sale = await saleInScope(db, scope, saleId);
  if (sale.lines.length === 0) throw new PharmacyCounterError('NOT_FOUND');

  const events = await db.pharmacySaleEvent.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId,
      kind: 'COMPLETED',
    },
    select: { payload: true, actorId: true },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
  });
  const snapshot = readReceiptIdentity(events, sale);
  // The person completing payment can differ from the person opening the bill.
  const completion = snapshot
    ? events.find(
        ({ payload }) =>
          payload !== null &&
          typeof payload === 'object' &&
          'receiptIdentitySnapshotVersion' in payload
      )
    : events[0];
  const cashier = completion?.actorId
    ? await db.user.findFirst({
        where: { id: completion.actorId, organizationId: scope.organizationId },
        select: { name: true },
      })
    : null;
  const lines = sale.lines.map((line) => {
    const identity = snapshot?.lines.find((row) => row.saleLineId === line.id);
    const descriptiveAllocations =
      identity?.allocations ??
      line.allocations.map((allocation) => ({
        allocationId: allocation.id,
        inventoryLotId: allocation.inventoryLotId,
        batchNumber: null,
        expiresAt: null,
        canonicalUnits: allocation.canonicalUnits,
      }));
    const allocations = descriptiveAllocations.map((allocation) => ({
      ...allocation,
      grossMinor:
        line.allocations.find((row) => row.id === allocation.allocationId)?.grossMinor ?? null,
    }));
    return {
      saleLineId: line.id,
      identityStatus: identity ? ('ISSUED' as const) : ('UNAVAILABLE' as const),
      medicineName: identity?.medicineName ?? 'Historical identity unavailable',
      strength: identity?.strength ?? null,
      presentation: identity?.presentation ?? 'Historical identity unavailable',
      allocations,
      // Compatibility fields never associate the first lot with the entire line.
      batchNumber:
        identity?.allocations
          .map((row) => `${row.batchNumber} (${row.canonicalUnits} units)`)
          .join('; ') ?? 'Historical batches unavailable',
      expiresAt: identity?.allocations.length === 1 ? identity.allocations[0]!.expiresAt : '',
      saleUnit: line.saleUnit as SaleUnitKind,
      quantity: line.quantity,
      canonicalUnits: line.canonicalUnits,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor,
      promotionName: line.promotionName,
      lineTotalMinor: line.grossMinor - line.discountMinor,
    };
  });
  const tenders = sale.tenders.map((tender) => ({
    tenderId: tender.id,
    type: tender.type,
    amountMinor: tender.amountMinor,
    cashReceivedMinor: tender.cashReceivedMinor,
    changeGivenMinor: tender.changeGivenMinor,
  }));

  const device = sale.receiptDeviceId
    ? await db.pharmacyRegisteredDevice.findFirst({
        where: {
          id: sale.receiptDeviceId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
        select: { name: true },
      })
    : null;
  return {
    saleId: sale.id,
    receiptNumber: sale.receiptNumber,
    counterLabel: counterLabel(sale.receiptDeviceId, device?.name),
    branchName: branch.name,
    businessDate: sale.businessDate ? sale.businessDate.toISOString().slice(0, 10) : null,
    completedAt: sale.completedAt ? sale.completedAt.toISOString() : null,
    cashierName: cashier?.name ?? null,
    currency: branch.currency,
    lines,
    tenders,
    totals: counterReceiptTotals({ lines, tenders }),
  };
}
