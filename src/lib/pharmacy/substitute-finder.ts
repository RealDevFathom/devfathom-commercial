import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export class PharmacySubstituteError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'NOT_EQUIVALENT' | 'NOT_SALEABLE') {
    super(code);
    this.name = 'PharmacySubstituteError';
  }
}

const candidateArgs = {
  include: {
    balances: { where: { disposition: 'AVAILABLE' as const, onHandUnits: { gt: 0 } } },
    batch: { include: { medicine: { include: { strengths: true } } } },
    packLevel: { include: { presentation: true } },
  },
} satisfies Prisma.PharmacyInventoryLotDefaultArgs;

type CandidateLot = Prisma.PharmacyInventoryLotGetPayload<typeof candidateArgs>;

export type SubstituteProposal = {
  medicineId: string;
  presentationId: string;
  inventoryLotId: string;
  packLevelId: string;
  displayName: string;
  strength: string;
  dosageForm: string | null;
  route: string | null;
  availableCanonicalUnits: number;
  priceMinor: number;
  priceDifferenceMinor: number;
  equivalenceBasis: string;
};

function normalized(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase('en') ?? '';
}

function strengthKey(
  strengths: readonly { ingredientId: string; value: { toString(): string }; unit: string }[]
) {
  return strengths
    .map((item) => `${item.ingredientId}:${item.value.toString()}:${normalized(item.unit)}`)
    .sort()
    .join('|');
}

function displayStrength(strengths: readonly { value: { toString(): string }; unit: string }[]) {
  return strengths.map((item) => `${item.value.toString()} ${item.unit}`).join(' + ');
}

/**
 * AI-05: deterministic graph traversal only. A proposal is an inventory fact,
 * not clinical advice, and never mutates a sale or prescription.
 */
export async function findSubstituteProposals(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  input: {
    medicineId: string;
    presentationId: string;
    quantityCanonicalUnits: number;
    referencePriceMinor?: number;
    at?: Date;
  }
): Promise<SubstituteProposal[]> {
  const at = input.at ?? new Date();
  const requested = await db.medicine.findFirst({
    where: { id: input.medicineId, organizationId: scope.organizationId },
    include: { strengths: true, presentations: true },
  });
  const requestedPresentation = requested?.presentations.find(
    (presentation) => presentation.id === input.presentationId
  );
  if (!requested || !requestedPresentation) throw new PharmacySubstituteError('NOT_FOUND');
  // DEV-852: an imported medicine may have no recorded strength. Without ingredient and
  // strength evidence nothing can be proposed as an exact equivalent.
  if (requested.strengths.length === 0) return [];

  const historicalReference =
    input.referencePriceMinor === undefined
      ? await db.pharmacyInventoryLot.findFirst({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            receivedAt: { not: null },
            batch: { medicineId: input.medicineId },
          },
          select: { printedMrpMinor: true, unitsPerPack: true },
          orderBy: { receivedAt: 'desc' },
        })
      : null;
  const referencePriceMinor =
    input.referencePriceMinor ??
    (historicalReference
      ? Math.floor(
          (historicalReference.printedMrpMinor * input.quantityCanonicalUnits) /
            historicalReference.unitsPerPack
        )
      : null);
  if (referencePriceMinor === null) return [];

  const lots: CandidateLot[] = await db.pharmacyInventoryLot.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      receivedAt: { not: null },
      batch: {
        medicineId: { not: input.medicineId },
        state: 'ACTIVE',
        expiresAt: { gt: at },
        medicine: { saleable: true },
      },
      balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
    },
    ...candidateArgs,
  });

  const requestedStrength = strengthKey(requested.strengths);
  const proposals = lots.flatMap((lot): SubstituteProposal[] => {
    const medicine = lot.batch.medicine;
    const presentation = lot.packLevel.presentation;
    const availableCanonicalUnits = lot.balances.reduce(
      (total, balance) => total + balance.onHandUnits,
      0
    );
    const priceMinor = Math.floor(
      (lot.printedMrpMinor * input.quantityCanonicalUnits) / lot.unitsPerPack
    );
    if (
      medicine.strengths.length === 0 ||
      strengthKey(medicine.strengths) !== requestedStrength ||
      normalized(presentation.dosageForm) !== normalized(requestedPresentation.dosageForm) ||
      normalized(presentation.route) !== normalized(requestedPresentation.route) ||
      availableCanonicalUnits < input.quantityCanonicalUnits ||
      priceMinor >= referencePriceMinor
    ) {
      return [];
    }
    return [
      {
        medicineId: medicine.id,
        presentationId: presentation.id,
        inventoryLotId: lot.id,
        packLevelId: lot.packLevelId,
        displayName: medicine.productName,
        strength: displayStrength(medicine.strengths),
        dosageForm: presentation.dosageForm,
        route: presentation.route,
        availableCanonicalUnits,
        priceMinor,
        priceDifferenceMinor: referencePriceMinor - priceMinor,
        equivalenceBasis: 'Exact ingredient(s), strength component(s), dosage form and route',
      },
    ];
  });

  return proposals.sort(
    (left, right) =>
      left.priceMinor - right.priceMinor ||
      left.displayName.localeCompare(right.displayName, 'en') ||
      left.inventoryLotId.localeCompare(right.inventoryLotId, 'en')
  );
}

/** POS-10: declining the presented alternatives closes, rather than abandons, the event. */
export async function declineSubstitute(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  demandEventId: string,
  at = new Date()
) {
  const demand = await db.unfulfilledDemandEvent.findFirst({
    where: {
      id: demandEventId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
    select: { id: true },
  });
  if (!demand) throw new PharmacySubstituteError('NOT_FOUND');
  return db.unfulfilledDemandEvent.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: demand.id } },
    data: { reason: 'SUBSTITUTE_DECLINED', status: 'CLOSED', closedAt: at },
  });
}

export type MarginRankedBrand = {
  medicineId: string;
  presentationId: string;
  inventoryLotId: string;
  packLevelId: string;
  displayName: string;
  strength: string;
  dosageForm: string | null;
  route: string | null;
  availableCanonicalUnits: number;
  priceMinor: number;
  costMinor: number;
  marginMinor: number;
  /** Margin as a share of price, in basis points (10_000 = 100%). */
  marginBasisPoints: number;
  requested: boolean;
  equivalenceBasis: string;
};

const EQUIVALENCE_BASIS = 'Exact ingredient(s), strength component(s), dosage form and route';

function equivalenceKey(
  strengths: readonly { ingredientId: string; value: { toString(): string }; unit: string }[],
  presentation: { dosageForm: string | null; route: string | null }
) {
  // A medicine with no recorded strength has no provable salt identity: never group it.
  if (strengths.length === 0) return null;
  return [
    strengthKey(strengths),
    normalized(presentation.dosageForm),
    normalized(presentation.route),
  ].join('#');
}

function availableUnits(lot: CandidateLot) {
  return lot.balances.reduce((total, balance) => total + balance.onHandUnits, 0);
}

function saleableLotWhere(scope: { organizationId: string; branchId: string }, at: Date) {
  return {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    receivedAt: { not: null },
    batch: { state: 'ACTIVE', expiresAt: { gt: at }, medicine: { saleable: true } },
    balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
  } satisfies Prisma.PharmacyInventoryLotWhereInput;
}

function marginBasisPoints(marginMinor: number, priceMinor: number) {
  return priceMinor > 0 ? Math.floor((marginMinor * 10_000) / priceMinor) : 0;
}

/**
 * #745: pharmacist-facing. For the requested salt/strength, rank in-stock brands
 * (including the requested one) by the branch's margin on the requested quantity.
 * Equivalence is exactly the substitute finder's: same ingredient set and strength
 * components, dosage form and route. A different salt or strength is never returned.
 * Margin is printed MRP for the quantity less the lot's recorded unit cost.
 */
export async function rankSameSaltBrandsByMargin(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  input: {
    medicineId: string;
    presentationId: string;
    quantityCanonicalUnits: number;
    limit?: number;
    at?: Date;
  }
): Promise<MarginRankedBrand[]> {
  const at = input.at ?? new Date();
  const requested = await db.medicine.findFirst({
    where: { id: input.medicineId, organizationId: scope.organizationId },
    include: { strengths: true, presentations: true },
  });
  const requestedPresentation = requested?.presentations.find(
    (presentation) => presentation.id === input.presentationId
  );
  if (!requested || !requestedPresentation) throw new PharmacySubstituteError('NOT_FOUND');
  const requestedKey = equivalenceKey(requested.strengths, requestedPresentation);
  if (requestedKey === null) return [];

  const lots: CandidateLot[] = await db.pharmacyInventoryLot.findMany({
    where: saleableLotWhere(scope, at),
    ...candidateArgs,
  });

  const ranked = lots.flatMap((lot): MarginRankedBrand[] => {
    const medicine = lot.batch.medicine;
    const presentation = lot.packLevel.presentation;
    const available = availableUnits(lot);
    if (
      equivalenceKey(medicine.strengths, presentation) !== requestedKey ||
      available < input.quantityCanonicalUnits ||
      lot.unitsPerPack <= 0
    ) {
      return [];
    }
    const priceMinor = Math.floor(
      (lot.printedMrpMinor * input.quantityCanonicalUnits) / lot.unitsPerPack
    );
    const costMinor = lot.unitCostMinor * input.quantityCanonicalUnits;
    const marginMinor = priceMinor - costMinor;
    return [
      {
        medicineId: medicine.id,
        presentationId: presentation.id,
        inventoryLotId: lot.id,
        packLevelId: lot.packLevelId,
        displayName: medicine.productName,
        strength: displayStrength(medicine.strengths),
        dosageForm: presentation.dosageForm,
        route: presentation.route,
        availableCanonicalUnits: available,
        priceMinor,
        costMinor,
        marginMinor,
        marginBasisPoints: marginBasisPoints(marginMinor, priceMinor),
        requested: medicine.id === input.medicineId,
        equivalenceBasis: EQUIVALENCE_BASIS,
      },
    ];
  });

  ranked.sort(
    (left, right) =>
      right.marginMinor - left.marginMinor ||
      left.priceMinor - right.priceMinor ||
      left.displayName.localeCompare(right.displayName, 'en') ||
      left.inventoryLotId.localeCompare(right.inventoryLotId, 'en')
  );
  return input.limit === undefined ? ranked : ranked.slice(0, input.limit);
}

export type BrandMixOption = {
  medicineId: string;
  displayName: string;
  presentationId: string;
  availableCanonicalUnits: number;
  /** Margin per sealed pack of `unitsPerPack` canonical units, from the newest received lot. */
  unitsPerPack: number;
  packMarginMinor: number;
  marginBasisPoints: number;
};

export type BrandMixSuggestion = {
  strength: string;
  dosageForm: string | null;
  route: string | null;
  equivalenceBasis: string;
  /** Highest-margin brand first. */
  brands: BrandMixOption[];
  /** Brands whose per-unit margin trails the leader by more than zero and at least the configured threshold. */
  lowerMarginMedicineIds: string[];
};

/** Exact per-canonical-unit margin comparison without rounding: a/b vs c/d. */
function compareUnitMargin(left: BrandMixOption, right: BrandMixOption) {
  return right.packMarginMinor * left.unitsPerPack - left.packMarginMinor * right.unitsPerPack;
}

/**
 * #745: purchasing view. Within each exact salt/strength/form/route group that the
 * branch stocks under two or more brands, list brands by per-unit margin so the
 * buyer can shift the mix toward the higher-margin brand. Suggestion only: it
 * never creates or edits an order. `minUnitMarginGainMinor` (margin gain per
 * canonical unit) is configurable, default 0, rather than a hardcoded research figure.
 */
export async function suggestHigherMarginBrandMix(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  input: { minUnitMarginGainMinor?: number; at?: Date } = {}
): Promise<BrandMixSuggestion[]> {
  const at = input.at ?? new Date();
  const threshold = input.minUnitMarginGainMinor ?? 0;
  const lots: CandidateLot[] = await db.pharmacyInventoryLot.findMany({
    where: saleableLotWhere(scope, at),
    ...candidateArgs,
    orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
  });

  const groups = new Map<string, { sample: CandidateLot; brands: Map<string, BrandMixOption> }>();
  for (const lot of lots) {
    const medicine = lot.batch.medicine;
    const presentation = lot.packLevel.presentation;
    const key = equivalenceKey(medicine.strengths, presentation);
    if (key === null || lot.unitsPerPack <= 0) continue;
    const group = groups.get(key) ?? { sample: lot, brands: new Map() };
    groups.set(key, group);
    const existing = group.brands.get(medicine.id);
    if (existing) {
      existing.availableCanonicalUnits += availableUnits(lot);
      continue;
    }
    // Lots arrive newest first, so the first lot per brand carries the current price and cost.
    const packMarginMinor = lot.printedMrpMinor - lot.unitCostMinor * lot.unitsPerPack;
    group.brands.set(medicine.id, {
      medicineId: medicine.id,
      displayName: medicine.productName,
      presentationId: presentation.id,
      availableCanonicalUnits: availableUnits(lot),
      unitsPerPack: lot.unitsPerPack,
      packMarginMinor,
      marginBasisPoints: marginBasisPoints(packMarginMinor, lot.printedMrpMinor),
    });
  }

  const suggestions: BrandMixSuggestion[] = [];
  for (const { sample, brands } of groups.values()) {
    if (brands.size < 2) continue;
    const ranked = [...brands.values()].sort(
      (left, right) =>
        compareUnitMargin(left, right) ||
        left.displayName.localeCompare(right.displayName, 'en') ||
        left.medicineId.localeCompare(right.medicineId, 'en')
    );
    const leader = ranked[0]!;
    const lowerMarginMedicineIds = ranked
      .slice(1)
      .filter((brand) => {
        const gain = compareUnitMargin(brand, leader);
        return gain > 0 && gain >= threshold * leader.unitsPerPack * brand.unitsPerPack;
      })
      .map((brand) => brand.medicineId);
    if (lowerMarginMedicineIds.length === 0) continue;
    suggestions.push({
      strength: displayStrength(sample.batch.medicine.strengths),
      dosageForm: sample.packLevel.presentation.dosageForm,
      route: sample.packLevel.presentation.route,
      equivalenceBasis: EQUIVALENCE_BASIS,
      brands: ranked,
      lowerMarginMedicineIds,
    });
  }
  return suggestions.sort(
    (left, right) =>
      left.strength.localeCompare(right.strength, 'en') ||
      (left.dosageForm ?? '').localeCompare(right.dosageForm ?? '', 'en')
  );
}
