import 'server-only';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import {
  competitorObservationSchema,
  smartDiscountPolicySchema,
  suggestSmartDiscount,
  genericDiscountWhatsAppText,
  type SmartDiscountPolicy,
} from './smart-discounting';

/** Resolve current ownership and branch scope inside the caller's transaction. */
export async function assertSmartDiscountOwner(db: ScopedDb, scope: LedgerScope) {
  const actor = await db.user.findFirst({
    where: {
      id: scope.actorId,
      organizationId: scope.organizationId,
      status: 'ACTIVE',
      role: 'ADMIN',
    },
  });
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
  });
  const [context] = await db.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR
      current_setting('app.current_branch_id',true)=${scope.branchId}) AS allowed`;
  if (!actor || !branch || !context?.allowed)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Current owner and branch access are required.',
    });
}

export async function saveSmartDiscountPolicy(
  db: ScopedDb,
  scope: LedgerScope,
  input: SmartDiscountPolicy
) {
  const policy = smartDiscountPolicySchema.parse(input);
  const saved = await db.pharmacySmartDiscountPolicy.upsert({
    where: {
      organizationId_branchId: { organizationId: scope.organizationId, branchId: scope.branchId },
    },
    create: {
      ...policy,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      updatedById: scope.actorId,
    },
    update: { ...policy, updatedById: scope.actorId, updatedAt: new Date() },
  });
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'UPDATE',
      action: 'pharmacyMedicine.setSmartDiscountPolicy',
      targetType: 'PharmacySmartDiscountPolicy',
      targetId: scope.branchId,
      changes: { ...policy, branchId: scope.branchId },
    },
  });
  return saved;
}

export async function recordCompetitorDiscountObservation(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    medicineId: string;
    packLevelId: string;
    competitor: string;
    competitorPriceMinor: number;
    observedDemandUnits: number;
    observedAt: Date;
  }
) {
  const evidence = competitorObservationSchema.parse({
    competitorPriceMinor: input.competitorPriceMinor,
    observedDemandUnits: input.observedDemandUnits,
  });
  const pack = await db.packLevel.findFirst({
    where: {
      id: input.packLevelId,
      organizationId: scope.organizationId,
      presentation: { organizationId: scope.organizationId, medicineId: input.medicineId },
    },
  });
  if (!pack)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pack does not belong to this medicine.' });
  return db.pharmacyCompetitorDiscountObservation.create({
    data: {
      ...input,
      ...evidence,
      id: randomUUID(),
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      actorId: scope.actorId,
    },
  });
}

/** Quotes one received pack; actual sale margin is rechecked against allocated lots. */
export async function readSmartDiscountSuggestion(
  db: ScopedDb,
  scope: LedgerScope,
  inventoryLotId: string
) {
  const policy = await db.pharmacySmartDiscountPolicy.findUnique({
    where: {
      organizationId_branchId: { organizationId: scope.organizationId, branchId: scope.branchId },
    },
  });
  if (!policy)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Configure a margin policy first.',
    });
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: { id: inventoryLotId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { batch: { include: { medicine: true } } },
  });
  if (!lot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Lot not found.' });
  const observations = await db.pharmacyCompetitorDiscountObservation.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      medicineId: lot.batch.medicineId,
      packLevelId: lot.packLevelId,
    },
    orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
    take: 1000,
  });
  const { minimumMarginBps, minimumObservations, targetDemandLiftBps } = policy;
  const suggestion = suggestSmartDiscount(
    {
      rxOnly:
        lot.batch.medicine.rx || lot.batch.medicine.restricted || lot.batch.medicine.controlled,
      mrpMinor: lot.printedMrpMinor,
      unitCostMinor: lot.unitCostMinor * lot.unitsPerPack,
      observations: observations.map(({ competitorPriceMinor, observedDemandUnits }) => ({
        competitorPriceMinor,
        observedDemandUnits,
      })),
    },
    { minimumMarginBps, minimumObservations, targetDemandLiftBps }
  );
  const discountPercent = suggestion.eligible
    ? Math.floor((suggestion.discountMinor * 100) / lot.printedMrpMinor)
    : 0;
  return {
    inventoryLotId: lot.id,
    packLevelId: lot.packLevelId,
    canonicalUnitsInPack: lot.unitsPerPack,
    suggestion,
    genericWhatsAppText:
      discountPercent > 0 && discountPercent < 100
        ? genericDiscountWhatsAppText(discountPercent)
        : null,
  };
}
