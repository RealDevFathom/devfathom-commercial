import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export class PharmacySubstituteError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'NOT_EQUIVALENT' | 'NOT_SALEABLE') {
    super(code);
    this.name = 'PharmacySubstituteError';
  }
}

const candidateArgs = (scope: { organizationId: string; branchId: string }) =>
  ({
    include: {
      balances: {
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          disposition: 'AVAILABLE' as const,
          onHandUnits: { gt: 0 },
        },
      },
      batch: { include: { medicine: { include: { strengths: true } } } },
      packLevel: { include: { presentation: true } },
    },
  }) satisfies Prisma.PharmacyInventoryLotDefaultArgs;

type CandidateLot = Prisma.PharmacyInventoryLotGetPayload<ReturnType<typeof candidateArgs>>;

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

export type MarginOptimizedBrandProposal = SubstituteProposal & {
  costMinor: number;
  marginMinor: number;
  marginBps: number;
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
      balances: {
        some: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          disposition: 'AVAILABLE',
          onHandUnits: { gt: 0 },
        },
      },
    },
    ...candidateArgs(scope),
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

/**
 * #745: pharmacist/purchasing decision support for brand mix. Unlike the
 * patient-savings finder above, this ranks only exact, saleable equivalents by
 * the observed lot margin. It remains read-only and deliberately does not
 * infer an equivalent salt, strength, form, or route.
 */
export async function findMarginOptimizedBrandProposals(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  input: {
    medicineId: string;
    presentationId: string;
    quantityCanonicalUnits: number;
    at?: Date;
  }
): Promise<MarginOptimizedBrandProposal[]> {
  const at = input.at ?? new Date();
  const requested = await db.medicine.findFirst({
    where: { id: input.medicineId, organizationId: scope.organizationId },
    include: { strengths: true, presentations: true },
  });
  const requestedPresentation = requested?.presentations.find(
    (presentation) => presentation.id === input.presentationId
  );
  if (!requested || !requestedPresentation) throw new PharmacySubstituteError('NOT_FOUND');

  const lots: CandidateLot[] = await db.pharmacyInventoryLot.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      receivedAt: { not: null },
      batch: {
        state: 'ACTIVE',
        expiresAt: { gt: at },
        medicine: { saleable: true },
      },
      balances: {
        some: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          disposition: 'AVAILABLE',
          onHandUnits: { gt: 0 },
        },
      },
    },
    ...candidateArgs(scope),
  });

  const requestedStrength = strengthKey(requested.strengths);
  const proposals = lots.flatMap((lot): MarginOptimizedBrandProposal[] => {
    const medicine = lot.batch.medicine;
    const presentation = lot.packLevel.presentation;
    // Do not rely on relation integrity or RLS alone: legacy/mocked rows must
    // still be incapable of inflating this branch's saleable quantity.
    const availableCanonicalUnits = lot.balances
      .filter(
        (balance) =>
          balance.organizationId === scope.organizationId && balance.branchId === scope.branchId
      )
      .reduce((total, balance) => total + balance.onHandUnits, 0);
    if (
      strengthKey(medicine.strengths) !== requestedStrength ||
      normalized(presentation.dosageForm) !== normalized(requestedPresentation.dosageForm) ||
      normalized(presentation.route) !== normalized(requestedPresentation.route) ||
      availableCanonicalUnits < input.quantityCanonicalUnits
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
        availableCanonicalUnits,
        priceMinor,
        priceDifferenceMinor: 0,
        costMinor,
        marginMinor,
        marginBps: priceMinor > 0 ? Math.trunc((marginMinor * 10_000) / priceMinor) : 0,
        equivalenceBasis: 'Exact ingredient(s), strength component(s), dosage form and route',
      },
    ];
  });

  // "Margin optimiser" means contribution for the requested quantity. Rate is
  // only a deterministic tie-breaker; purchasing decisions optimize cash
  // contribution rather than silently changing semantics when pack prices vary.
  return proposals.sort(
    (left, right) =>
      right.marginMinor - left.marginMinor ||
      right.marginBps - left.marginBps ||
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
