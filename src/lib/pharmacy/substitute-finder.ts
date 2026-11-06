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
  requiresPharmacist: boolean;
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
        requiresPharmacist: Boolean(
          requested.rx ||
          requested.restricted ||
          requested.controlled ||
          medicine.rx ||
          medicine.restricted ||
          medicine.controlled
        ),
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
