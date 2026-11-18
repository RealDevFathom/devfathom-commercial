import { readPrepaidAccount } from './prepaid-tiers';
import { pricePrepaidSale } from './prepaid-discount';
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
import { parseShelfLabelCode } from './shelf-label-code';
import type { LedgerScope } from './stock-ledger';
import { BATCH_NOT_RECORDED, compareKnownExpiryFirst } from './unrecorded-batch';

export class PharmacyCounterError extends Error {
  constructor(readonly reason: 'NOT_FOUND' | 'CROSS_BRANCH_REFERENCE' | 'INVALID_QUERY') {
    super(reason);
  }
}

export type CounterScope = Pick<LedgerScope, 'organizationId' | 'branchId'>;

/** How a row was reached, so the operator can trust an unfamiliar match. */
export type CounterMatchKind = 'BARCODE' | 'ALIAS' | 'NAME' | 'INGREDIENT' | 'PRESENTATION';

export type CounterCatalogRow = {
  medicineId: string;
  displayName: string;
  brandName: string | null;
  manufacturer: string | null;
  /** Rendered strength components, for example `500 mg + 30 mg`. */
  strength: string | null;
  /** DEV-862: salt and strength, e.g. `paracetamol 500 mg`; null when none recorded. */
  composition?: string | null;
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
  /** DEV-853: also null when the shown lot's batch number was never recorded. */
  batchNumber: string | null;
  /**
   * ISO instant of the nearest SAFE expiry; null when nothing is sellable or
   * (DEV-853) when the shown lot's expiry was never recorded.
   */
  nearestSafeExpiry: string | null;
  /** Safe canonical units on hand for this branch (blocked stock excluded). */
  onHandUnits: number;
  /**
   * DEV-90: set only on a shelf-label scan, where `onHandUnits` is that lot's own
   * units. The medicine-wide safe total, for shortage capture and substitutes.
   */
  medicineOnHandUnits?: number;
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
  /**
   * DEV-90: the exact lot a scanned shelf sticker names. Set only when the query
   * was a shelf-label code of this branch. When it differs from
   * `recommendedLotId`, selling it is a FEFO override like any other.
   */
  labelLot?: CounterLabelLot | null;
};

export type CounterLabelLot = {
  inventoryLotId: string;
  /** DEV-853: null when the batch number was never recorded. */
  batchNumber: string | null;
  /** DEV-853: null when the expiry was never recorded. */
  expiresAt: string | null;
  printedMrpMinor: number;
  /** Safe canonical units of this lot alone. */
  sellableUnits: number;
  /** Why the lot cannot be sold; null when it can. */
  blockedBy: BlockReason | null;
};

export type CounterSearchRow = CounterCatalogRow & {
  /** DEV-878: server-resolved suggestions for an unavailable search match. */
  stockAlternatives?: {
    ingredientRecorded: boolean;
    exact: CounterCatalogRow[];
    other: CounterCatalogRow[];
    /** More same-ingredient brands may be in stock than were checked. */
    truncated: boolean;
  };
  /**
   * DEV-907: owner-enabled "also in stock at another branch" line. Set only when
   * the owner switched it on, this branch has none of the medicine, and it is not
   * a controlled drug. Branch names of the same organization only — never a
   * quantity, price, batch, customer or any other detail of the other branch.
   */
  otherBranchAvailability?: {
    branchNames: string[];
    /** More branches hold it than are named. */
    more: boolean;
  };
};

type LotRow = {
  id: string;
  packLevelId: string;
  unitsPerPack: number;
  printedMrpMinor: number;
  receivedAt: Date | null;
  batch: { batchNumber: string | null; expiresAt: Date | null; state: string; medicineId: string };
};

type BalanceRow = {
  inventoryLotId: string;
  stockLocationId: string;
  disposition: StockDisposition;
  onHandUnits: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** DEV-878: bound on same-ingredient candidates checked per distinct ingredient set. */
const MAX_ALTERNATIVE_CANDIDATES = 20;
/** DEV-907: branch names named on one availability line. */
const MAX_OTHER_BRANCH_NAMES = 3;

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

export function renderStrength(
  components: readonly { value: unknown; unit: string }[]
): string | null {
  if (components.length === 0) return null;
  return components
    .map((component) => `${renderStrengthValue(component.value)} ${component.unit}`)
    .join(' + ');
}

/**
 * DEV-862: the salt and strength a stock list shows under the product name,
 * for example `paracetamol 500 mg` or `paracetamol 500 mg + caffeine 30 mg`.
 * Returns null when nothing is recorded, so the caller renders nothing extra.
 */
export function renderStockComposition(
  components: readonly { value: unknown; unit: string; ingredient: { name: string } }[]
): string | null {
  if (components.length === 0) return null;
  return components
    .map((c) => `${c.ingredient.name.trim()} ${renderStrengthValue(c.value)} ${c.unit}`.trim())
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
): Promise<{
  matches: Map<string, { kind: CounterMatchKind; rank: number }>;
  labelLotId: string | null;
}> {
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
    return { matches, labelLotId: null };
  }

  // A shelf code resolves only inside this organization and branch. Invalid
  // internal codes also fail closed instead of entering fuzzy catalogue search.
  if (/^71\d{14}$/.test(trimmed)) {
    const labelNumber = parseShelfLabelCode(trimmed);
    const lot =
      labelNumber === null
        ? null
        : await db.pharmacyInventoryLot.findFirst({
            where: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              shelfLabelNumber: labelNumber,
            },
            select: { id: true, batch: { select: { medicineId: true } } },
          });
    if (lot) remember(lot.batch.medicineId, 'BARCODE', 0);
    return { matches, labelLotId: lot?.id ?? null };
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
          OR: [{ productName: text }, { brandName: text }],
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
  // Manufacturer and registration number are weaker signals than a name, brand
  // or alias. They are read in the later stage, so they can never displace a
  // brand alias from the bounded first-stage candidates.
  const producerMatches = (operator: 'startsWith' | 'contains') =>
    db.medicine.findMany({
      where: {
        organizationId: scope.organizationId,
        saleable: true,
        OR: [
          { manufacturer: { [operator]: trimmed, mode: 'insensitive' as const } },
          { drapRegistrationNumber: { [operator]: trimmed, mode: 'insensitive' as const } },
        ],
      },
      select: { id: true },
      orderBy: [{ productName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
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
  if (matches.size <= limit) {
    const [producerPrefixes, producerContains, contains] = await Promise.all([
      producerMatches('startsWith'),
      producerMatches('contains'),
      textMatches('contains'),
    ]);
    for (const medicine of producerPrefixes) remember(medicine.id, 'NAME', 2.5);
    rememberText(contains, [5, 6, 7]);
    for (const medicine of producerContains) remember(medicine.id, 'NAME', 5.5);
  }

  return { matches, labelLotId: null };
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
  input: {
    query: string;
    limit?: number;
    at?: Date;
    /** DEV-907: the owner's switch, read by the server; never taken from the client. */
    otherBranchAvailability?: boolean;
  }
): Promise<{ rows: CounterSearchRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const at = input.at ?? new Date();
  const { matches, labelLotId } = await matchMedicineIds(db, scope, input.query, limit);
  const medicineIds = [...matches.keys()];
  if (medicineIds.length > limit) {
    // Relevance must decide admission too, before hydration. Keep the original
    // read order when all candidates fit; it has no bearing on displayed rank.
    medicineIds.sort((left, right) => matches.get(left)!.rank - matches.get(right)!.rank);
    medicineIds.length = limit;
  }
  if (medicineIds.length === 0) return { rows: [], truncated: false };

  const { rows, medicines } = await hydrateCounterRows(
    db,
    scope,
    matches,
    medicineIds,
    at,
    labelLotId
  );
  const unavailable = rows.filter((row) => !hasSellableUnit(row));
  const sourceById = new Map(medicines.map((medicine) => [medicine.id, medicine]));
  const ingredientSets = unavailable.flatMap((row) => {
    const source = sourceById.get(row.medicineId)!;
    const ids = [...new Set(source.strengths.map((component) => component.ingredientId))];
    return ids.length ? [ids] : [];
  });
  // Query only this tenant's ingredient graph. No brand dictionary or historical
  // price is needed, and equal or more expensive brands remain eligible. Each
  // distinct ingredient set has its own bound, so one common ingredient cannot
  // crowd out the suggestions for another unavailable match.
  const distinctSets = [
    ...new Map(ingredientSets.map((ids) => [JSON.stringify([...ids].sort()), ids])),
  ];
  const candidatesBySet = new Map(
    await Promise.all(
      distinctSets.map(async ([key, ids]) => {
        const found = await db.medicine.findMany({
          where: {
            organizationId: scope.organizationId,
            saleable: true,
            strengths: { every: { ingredientId: { in: ids } } },
            AND: ids.map((ingredientId) => ({ strengths: { some: { ingredientId } } })),
            // Only medicines that can have sellable stock at this branch, so the
            // bound is spent on in-stock brands. The row kernel still applies the
            // full sellability rules to each lot.
            batches: {
              some: {
                state: 'ACTIVE',
                // DEV-853: an unrecorded expiry is never treated as expired.
                OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
                lots: {
                  some: {
                    branchId: scope.branchId,
                    receivedAt: { not: null, lte: at },
                    balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
                  },
                },
              },
            },
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          // One extra row tells us the bound was reached.
          take: MAX_ALTERNATIVE_CANDIDATES + 1,
        });
        return [
          key,
          {
            ids: found.slice(0, MAX_ALTERNATIVE_CANDIDATES).map((medicine) => medicine.id),
            truncated: found.length > MAX_ALTERNATIVE_CANDIDATES,
          },
        ] as const;
      })
    )
  );
  const candidateIds = [...new Set([...candidatesBySet.values()].flatMap((entry) => entry.ids))];
  const alternatives = candidateIds.length
    ? await hydrateCounterRows(
        db,
        scope,
        // An alternative is reached through the stored ingredient graph.
        new Map(candidateIds.map((id) => [id, { kind: 'INGREDIENT' as const, rank: 0 }])),
        candidateIds,
        at
      )
    : { rows: [], medicines: [] };
  const alternativeById = new Map(
    alternatives.medicines.map((medicine) => [medicine.id, medicine])
  );
  for (const row of unavailable) {
    const source = sourceById.get(row.medicineId)!;
    const ingredientRecorded = source.strengths.length > 0;
    const exact: CounterSearchRow[] = [];
    const other: CounterSearchRow[] = [];
    for (const candidate of alternatives.rows) {
      const medicine = alternativeById.get(candidate.medicineId)!;
      if (
        !ingredientRecorded ||
        candidate.medicineId === row.medicineId ||
        !hasSellableUnit(candidate) ||
        ingredientSetKey(source.strengths) !== ingredientSetKey(medicine.strengths)
      )
        continue;
      // The sale writer allocates FEFO across every presentation of a medicine, so
      // the quoted row is medicine-wide. A medicine is an exact equivalent only when
      // every presentation of both the requested and the candidate medicine has one
      // recorded dosage form and the same route; a requested medicine with several
      // forms cannot say which one was asked for, so its suggestions stay under other.
      const same =
        strengthComponentKey(source.strengths) === strengthComponentKey(medicine.strengths) &&
        normalizedForm(row.dosageForm) !== '' &&
        hasOnlyPresentation(source.presentations, row) &&
        hasOnlyPresentation(medicine.presentations, row);
      (same ? exact : other).push(candidate);
    }
    row.stockAlternatives = {
      ingredientRecorded,
      exact: exact.sort(compareStockAlternatives),
      other: other.sort(compareStockAlternatives),
      truncated: candidatesBySet.get(ingredientSetKey(source.strengths))?.truncated ?? false,
    };
  }
  if (input.otherBranchAvailability) {
    // Only a medicine this branch has none of, and never a controlled drug: the
    // row flag is checked here and the stored flag again in the read itself.
    const outOfStock = unavailable.filter(
      (row) => (row.medicineOnHandUnits ?? row.onHandUnits) === 0 && !row.restriction.controlled
    );
    const elsewhere = await readOtherBranchAvailability(
      db,
      scope,
      outOfStock.map((row) => row.medicineId),
      at
    );
    for (const row of outOfStock) {
      const names = elsewhere.get(row.medicineId);
      if (!names?.length) continue;
      row.otherBranchAvailability = {
        branchNames: names.slice(0, MAX_OTHER_BRANCH_NAMES),
        more: names.length > MAX_OTHER_BRANCH_NAMES,
      };
    }
  }
  return { rows, truncated: matches.size > medicineIds.length };
}

/**
 * DEV-907: the names of the other active branches of this organization that hold
 * sellable-looking stock of each medicine: an active, unexpired batch of a
 * non-controlled medicine, received, with an AVAILABLE balance above zero.
 *
 * The read is pinned to the caller's organization (and RLS pins it again), so
 * another organization's stock can never appear. Only branch names leave this
 * function; quantities, prices, batches and lots are never selected.
 */
export async function readOtherBranchAvailability(
  db: ScopedDb,
  scope: CounterScope,
  medicineIds: readonly string[],
  at: Date
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (medicineIds.length === 0) return result;
  const lotFilter = {
    organizationId: scope.organizationId,
    receivedAt: { not: null, lte: at },
    batch: {
      organizationId: scope.organizationId,
      medicineId: { in: [...medicineIds] },
      state: 'ACTIVE' as const,
      // DEV-853: an unrecorded expiry is never treated as expired.
      OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
      medicine: { organizationId: scope.organizationId, controlled: false },
    },
    balances: {
      some: {
        organizationId: scope.organizationId,
        disposition: 'AVAILABLE' as const,
        onHandUnits: { gt: 0 },
      },
    },
  };
  const branches = await db.pharmacyBranch.findMany({
    where: {
      organizationId: scope.organizationId,
      active: true,
      id: { not: scope.branchId },
      inventoryLots: { some: lotFilter },
    },
    select: {
      id: true,
      name: true,
      inventoryLots: { where: lotFilter, select: { batch: { select: { medicineId: true } } } },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  for (const branch of branches) {
    if (branch.id === scope.branchId) continue;
    for (const medicineId of new Set(branch.inventoryLots.map((lot) => lot.batch.medicineId))) {
      const names = result.get(medicineId) ?? [];
      names.push(branch.name);
      result.set(medicineId, names);
    }
  }
  return result;
}

/**
 * The sale allocator's FEFO order (`byFefo` in inventory.ts): expiry, then the
 * oldest receipt, then lot id, so the quoted lot is the lot the sale charges.
 */
function fefoBefore(lot: LotRow, best: LotRow) {
  return (
    (compareKnownExpiryFirst(lot.batch.expiresAt, best.batch.expiresAt) ||
      (lot.receivedAt?.getTime() ?? 0) - (best.receivedAt?.getTime() ?? 0) ||
      lot.id.localeCompare(best.id)) < 0
  );
}

function hasSellableUnit(row: CounterSearchRow) {
  return row.onHandUnits > 0 && row.saleableUnits.some((unit) => unit.wholeUnits > 0);
}

function hasOnlyPresentation(
  presentations: readonly { dosageForm: string | null; route: string | null }[],
  form: { dosageForm: string | null; route: string | null }
) {
  return (
    presentations.length > 0 &&
    presentations.every(
      (presentation) =>
        normalizedForm(presentation.dosageForm) === normalizedForm(form.dosageForm) &&
        normalizedForm(presentation.route) === normalizedForm(form.route)
    )
  );
}

function normalizedForm(value: string | null) {
  return value?.trim().toLowerCase() ?? '';
}

type StrengthComponent = { ingredientId: string; value: unknown; unit: string };

function ingredientSetKey(strengths: readonly StrengthComponent[]) {
  return JSON.stringify([...new Set(strengths.map((component) => component.ingredientId))].sort());
}

function strengthComponentKey(strengths: readonly StrengthComponent[]) {
  return JSON.stringify(
    strengths
      .map((component) => [
        component.ingredientId,
        renderStrengthValue(component.value),
        component.unit.trim().toLowerCase(),
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  );
}

/** Price per canonical unit, compared exactly by cross-multiplying pack MRP and size. */
function comparePerUnitPrice(left: CounterSearchRow, right: CounterSearchRow) {
  return (
    (left.printedMrpMinor ?? 0) * (right.unitsPerPack ?? 1) -
    (right.printedMrpMinor ?? 0) * (left.unitsPerPack ?? 1)
  );
}

function compareStockAlternatives(left: CounterSearchRow, right: CounterSearchRow) {
  return (
    // DEV-853: an unrecorded expiry sorts after every known one.
    (left.nearestSafeExpiry ?? '\uffff').localeCompare(right.nearestSafeExpiry ?? '\uffff') ||
    comparePerUnitPrice(left, right) ||
    left.displayName.localeCompare(right.displayName) ||
    left.presentationId.localeCompare(right.presentationId)
  );
}

/** Shared stock, pack and pricing read; suggestions use the same kernels as search. */
async function hydrateCounterRows(
  db: ScopedDb,
  scope: CounterScope,
  matches: ReadonlyMap<string, { kind: CounterMatchKind; rank: number }>,
  medicineIds: string[],
  at: Date,
  // DEV-90: the lot a scanned shelf sticker names; alternatives never carry one.
  labelLotId: string | null = null
) {
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
    let labelLot: CounterLabelLot | null = null;
    let labelLotRow: LotRow | null = null;
    let labelLotLocationId: string | null = null;
    const sellableLots = new Map<string, LotRow>();

    for (const lot of medicineLots) {
      if (lot.id === labelLotId) {
        labelLotRow = lot;
        labelLot = {
          inventoryLotId: lot.id,
          batchNumber: lot.batch.batchNumber,
          expiresAt: lot.batch.expiresAt?.toISOString() ?? null,
          printedMrpMinor: lot.printedMrpMinor,
          sellableUnits: 0,
          blockedBy: null,
        };
      }
      let lotBlockedBy: BlockReason | null = null;
      for (const balance of balancesByLot.get(lot.id) ?? []) {
        const candidate = candidateFrom(scope, lot, balance);
        const reason = blockReasonFor(candidate, scope_);
        if (reason !== null) {
          if (lotBlockedBy === null || lotBlockedBy === 'EMPTY') lotBlockedBy = reason;
          // EMPTY is an exhausted bucket, not a condition an operator acts on.
          if (reason !== 'EMPTY') blocked.add(reason);
          continue;
        }
        if (labelLot?.inventoryLotId === lot.id) {
          labelLot.sellableUnits += balance.onHandUnits;
          labelLotLocationId ??= balance.stockLocationId;
        }
        onHandUnits += balance.onHandUnits;
        sellableLots.set(lot.id, lot);
        const better = best === null || fefoBefore(lot, best.lot);
        if (better) best = { lot, locationId: balance.stockLocationId };
      }
      if (labelLot?.inventoryLotId === lot.id && labelLot.sellableUnits === 0) {
        labelLot.blockedBy = lotBlockedBy ?? 'EMPTY';
      }
    }

    // A lot disappearing between the exact lookup and catalogue read is not a
    // licence to return an ordinary medicine row and bill a different lot.
    if (labelLotId && !labelLot) continue;
    const availableUnits = labelLot ? labelLot.sellableUnits : onHandUnits;

    // DEV-90: a sellable shelf-label lot is the one being sold, so its own pack
    // conversion and price drive the sale units, even when it is not FEFO's lot.
    const priced: LotRow | null =
      labelLotRow && labelLot?.blockedBy === null ? labelLotRow : (best?.lot ?? null);

    const presentationId =
      (priced && presentationByPackLevel.get(priced.packLevelId)) ??
      medicine.presentations[0]?.id ??
      null;
    if (!presentationId) continue;
    const presentation =
      medicine.presentations.find((entry) => entry.id === presentationId) ??
      medicine.presentations[0]!;

    let saleUnits: SaleUnitOption[] = [];
    let packMismatch: CounterPackMismatch | null = null;
    if (priced) {
      // A lot whose received pack disagrees with the medicine's pack setup is
      // still sold through that setup, priced from the same lot exactly as the
      // server prices the line; only a setup that cannot price it reports why.
      ({ saleUnits, packMismatch } = resolveCounterSaleUnits({
        packLevels: packLevelsByPresentation.get(presentationId) ?? [],
        lotPackLevelId: priced.packLevelId,
        lotPackLevelLabel: levelLabelByPackLevel.get(priced.packLevelId) ?? null,
        lotUnitsPerPack: priced.unitsPerPack,
        otherLotUnitsPerPack: (labelLotId ? [] : [...sellableLots.values()])
          .filter((lot) => lot.id !== priced!.id)
          .map((lot) => lot.unitsPerPack),
        dosageForm: presentation.dosageForm,
        presentation: presentation.presentation,
        at,
      }));
    }

    // The same (pack level, batch) lookup the sale writer uses, so the quoted
    // price is the charged price even when batches carry different increments.
    const roundingIncrementMinor = priced
      ? mrpRoundingIncrementForLot(mrps, {
          packLevelId: priced.packLevelId,
          batchNumber: priced.batch.batchNumber,
        })
      : 1;

    const saleableUnits = priced
      ? saleUnits.map((option) => {
          const preview = previewSaleLine({
            option,
            quantity: 1,
            printedMrpMinor: priced!.printedMrpMinor,
            unitsPerPack: priced!.unitsPerPack,
            roundingIncrementMinor,
            availableUnits,
          });
          return {
            kind: option.kind,
            levelLabel: option.levelLabel,
            canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
            wholeUnits: Math.floor(availableUnits / option.canonicalUnitsPerSaleUnit),
            unitPriceMinor: preview.unitPriceMinor,
            proRataCeilingMinor: preview.proRataCeilingMinor,
          };
        })
      : [];

    // A sellable scanned lot is shown as itself: its batch, expiry and shelf.
    const shown: { lot: LotRow; locationId: string | null } | null =
      labelLotRow && labelLot?.blockedBy === null
        ? { lot: labelLotRow, locationId: labelLotLocationId }
        : best;
    const location = shown?.locationId ? locationById.get(shown.locationId) : undefined;
    rows.push({
      medicineId: medicine.id,
      displayName: medicine.productName,
      brandName: medicine.brandName,
      manufacturer: medicine.manufacturer,
      strength: renderStrength(medicine.strengths),
      composition: renderStockComposition(medicine.strengths),
      presentationId,
      presentation: presentation.presentation,
      dosageForm: presentation.dosageForm,
      route: presentation.route,
      matchedOn: matches.get(medicine.id)?.kind ?? 'NAME',
      recommendedLotId: best?.lot.id ?? null,
      packLevelId: priced?.packLevelId ?? null,
      unitsPerPack: priced?.unitsPerPack ?? null,
      printedMrpMinor: priced?.printedMrpMinor ?? null,
      roundingIncrementMinor,
      batchNumber: shown?.lot.batch.batchNumber ?? null,
      nearestSafeExpiry: shown?.lot.batch.expiresAt?.toISOString() ?? null,
      onHandUnits: availableUnits,
      ...(labelLotId ? { medicineOnHandUnits: onHandUnits } : {}),
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
      ...(labelLotId ? { labelLot } : {}),
    });
  }

  rows.sort(
    (left, right) =>
      (matches.get(left.medicineId)?.rank ?? 8) - (matches.get(right.medicineId)?.rank ?? 8) ||
      Number(right.onHandUnits > 0) - Number(left.onHandUnits > 0) ||
      left.displayName.localeCompare(right.displayName) ||
      left.medicineId.localeCompare(right.medicineId)
  );
  return { rows, medicines };
}

export type CounterCartLine = {
  saleLineId: string;
  medicineId: string;
  medicineName: string;
  strength: string | null;
  presentation: string;
  dosageForm?: string | null;
  saleUnit: SaleUnitKind;
  quantity: number;
  canonicalUnits: number;
  unitPriceMinor: number;
  proRataCeilingMinor: number;
  discountMinor: number;
  tierDiscountMinor?: number;
  tierName?: string | null;
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
    /** DEV-853: null when the batch number was never recorded. */
    batchNumber: string | null;
    /** DEV-853: null when the expiry was never recorded. */
    expiresAt: string | null;
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
  prepaidBalanceMinor?: number;
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
  const sale = await pricePrepaidSale(db, await saleInScope(db, scope, saleId));
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
    // DEV-853: only known expiries take part; an unrecorded one is never an override.
    const earliest = line.allocations.reduce<Date | null>((best, allocation) => {
      const expiresAt = allocation.lot.batch.expiresAt;
      return expiresAt !== null && (best === null || expiresAt.getTime() < best.getTime())
        ? expiresAt
        : best;
    }, null);
    return {
      saleLineId: line.id,
      medicineId: line.medicineId,
      medicineName: line.medicine.productName,
      strength: renderStrength(line.medicine.strengths),
      presentation: line.presentation.presentation,
      dosageForm: line.presentation.dosageForm,
      saleUnit: line.saleUnit as SaleUnitKind,
      quantity: line.quantity,
      canonicalUnits: line.canonicalUnits,
      unitPriceMinor: line.unitPriceMinor,
      proRataCeilingMinor: line.proRataCeilingMinor,
      discountMinor: line.discountMinor,
      tierDiscountMinor: line.tierDiscountMinor,
      tierName: line.tierName,
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
        expiresAt: allocation.lot.batch.expiresAt?.toISOString() ?? null,
        canonicalUnits: allocation.canonicalUnits,
        stockLocationCode: locationById.get(allocation.stockLocationId) ?? null,
        overridden:
          earliest !== null &&
          allocation.lot.batch.expiresAt !== null &&
          allocation.lot.batch.expiresAt.getTime() > earliest.getTime(),
      })),
    };
  });

  const grossMinor = sale.lines.reduce((total, line) => total + line.grossMinor, 0);
  const discountMinor = lines.reduce((total, line) => total + line.discountMinor, 0);
  return {
    prepaidBalanceMinor: sale.customerId
      ? ((await readPrepaidAccount(db, scope.organizationId, sale.customerId))?.balanceMinor ?? 0)
      : 0,
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
      medicineName: identity?.medicineName ?? 'Original item details unavailable',
      manufacturer: identity?.manufacturer ?? null,
      strength: identity?.strength ?? null,
      presentation: identity?.presentation ?? 'Original item details unavailable',
      allocations,
      // Compatibility fields never associate the first lot with the entire line.
      batchNumber:
        identity?.allocations
          // DEV-853: an unrecorded batch reads exactly "Batch not recorded".
          .map((row) => `${row.batchNumber ?? BATCH_NOT_RECORDED} (${row.canonicalUnits} units)`)
          .join('; ') ?? 'Historical batches unavailable',
      expiresAt: identity?.allocations.length === 1 ? identity.allocations[0]!.expiresAt : '',
      saleUnit: line.saleUnit as SaleUnitKind,
      quantity: line.quantity,
      canonicalUnits: line.canonicalUnits,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: line.discountMinor,
      tierDiscountMinor: line.tierDiscountMinor,
      tierName: line.tierName,
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
    offlineReference: sale.offlineReceiptReference ?? null,
    branchName: branch.name,
    businessDate: sale.businessDate ? sale.businessDate.toISOString().slice(0, 10) : null,
    completedAt: sale.completedAt ? sale.completedAt.toISOString() : null,
    cashierName: cashier?.name ?? null,
    buyerName: snapshot?.buyerName ?? null,
    ...(snapshot?.cashMemoIdentity !== undefined
      ? { cashMemoIdentity: snapshot.cashMemoIdentity }
      : {}),
    currency: branch.currency,
    lines,
    tenders,
    totals: counterReceiptTotals({ lines, tenders }),
  };
}
