import 'server-only';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import {
  discountPolicySchema,
  estimateDiscountElasticity,
  parseDiscountPolicy,
  suggestDiscount,
  type DiscountDemandObservation,
  type DiscountPolicy,
} from './smart-discount';

const DAY_MS = 86_400_000;

/** DEV-66: the branch's discount policy; defaults when none is configured. */
export async function readDiscountPolicy(db: ScopedDb, scope: LedgerScope) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId },
    select: { discountPolicy: true },
  });
  return parseDiscountPolicy(branch?.discountPolicy);
}

export async function readDiscountPolicySettings(db: ScopedDb, scope: LedgerScope) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
    select: { discountPolicy: true, discountPolicyRevision: true },
  });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND' });
  return {
    policy: parseDiscountPolicy(branch.discountPolicy),
    revision: branch.discountPolicyRevision,
  };
}

export async function saveDiscountPolicy(
  db: ScopedDb,
  scope: LedgerScope,
  input: { revision: number; policy: DiscountPolicy }
) {
  const policy = discountPolicySchema.parse(input.policy);
  const saved = await db.pharmacyBranch.updateMany({
    where: {
      organizationId: scope.organizationId,
      id: scope.branchId,
      active: true,
      discountPolicyRevision: input.revision,
    },
    data: {
      discountPolicy: policy as Prisma.InputJsonValue,
      discountPolicyRevision: { increment: 1 },
    },
  });
  if (saved.count !== 1)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Discount policy changed. Reload before saving.',
    });
  return { policy, revision: input.revision + 1 };
}

export async function recordCompetitorPrice(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    medicineId: string;
    competitorLabel: string;
    observedPriceMinor: number;
    observedAt: Date;
  }
) {
  const medicine = await db.medicine.findFirst({
    where: { organizationId: scope.organizationId, id: input.medicineId },
    select: { id: true },
  });
  if (!medicine) throw new TRPCError({ code: 'NOT_FOUND' });
  if (input.observedAt.getTime() > Date.now() + 5 * 60_000)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Observation is in the future.' });
  return db.pharmacyCompetitorPriceObservation.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      medicineId: input.medicineId,
      competitorLabel: input.competitorLabel,
      observedPriceMinor: input.observedPriceMinor,
      observedAt: input.observedAt,
      recordedByUserId: scope.actorId,
    },
    select: { id: true, observedAt: true },
  });
}

/**
 * Per sealed pack of the live lots in this branch: MRP is the lowest printed MRP
 * (the cap) and cost the highest unit cost (the conservative margin floor).
 * Competitor prices are per sealed pack as well.
 */
export async function readDiscountSuggestions(
  db: ScopedDb,
  scope: LedgerScope,
  input: { medicineIds: readonly string[]; now?: Date }
) {
  const now = input.now ?? new Date();
  const policy = await readDiscountPolicy(db, scope);
  const medicines = await db.medicine.findMany({
    where: { organizationId: scope.organizationId, id: { in: [...input.medicineIds] } },
    select: { id: true, productName: true, rx: true, restricted: true, controlled: true },
  });
  const since = new Date(now.getTime() - policy.lookbackDays * DAY_MS);
  const competitorSince = new Date(now.getTime() - policy.competitorPriceMaxAgeDays * DAY_MS);
  return Promise.all(
    medicines.map(async (medicine) => {
      const base = { medicineId: medicine.id, productName: medicine.productName };
      if (medicine.rx || medicine.restricted || medicine.controlled)
        return {
          ...base,
          suggestion: suggestDiscount({
            medicine,
            mrpMinor: 0,
            unitPriceMinor: 0,
            unitCostMinor: 0,
            policy,
            elasticity: null,
            lowestCompetitorPriceMinor: null,
          }),
          elasticity: null,
        };
      const lots = await db.pharmacyInventoryLot.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          receivedExpiresAt: { gt: now },
          packLevel: { presentation: { medicineId: medicine.id } },
        },
        select: {
          packLevelId: true,
          printedMrpMinor: true,
          unitCostMinor: true,
          unitsPerPack: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      if (!lots.length) return { ...base, suggestion: null, elasticity: null };
      // Compare like with like: only lots of the newest lot's pack level.
      const packLevelId = lots[0]!.packLevelId;
      const packLots = lots.filter((lot) => lot.packLevelId === packLevelId);
      const mrpMinor = Math.min(...packLots.map((lot) => lot.printedMrpMinor));
      const costMinor = Math.max(...packLots.map((lot) => lot.unitCostMinor * lot.unitsPerPack));
      const unitsPerPack = lots[0]!.unitsPerPack;
      const [competitor, saleLines] = await Promise.all([
        db.pharmacyCompetitorPriceObservation.findFirst({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            medicineId: medicine.id,
            observedAt: { gte: competitorSince },
          },
          orderBy: { observedPriceMinor: 'asc' },
          select: { observedPriceMinor: true },
        }),
        db.pharmacySaleLine.findMany({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            medicineId: medicine.id,
            createdAt: { gte: since },
            sale: { status: 'COMPLETED' },
          },
          select: {
            createdAt: true,
            canonicalUnits: true,
            grossMinor: true,
            discountMinor: true,
          },
        }),
      ]);
      const observations: DiscountDemandObservation[] = saleLines.map((line) => ({
        day: line.createdAt.toISOString().slice(0, 10),
        units: line.canonicalUnits,
        netMinor: line.grossMinor - line.discountMinor,
        discounted: line.discountMinor > 0,
      }));
      const estimate = estimateDiscountElasticity(observations, policy.minObservationDays);
      return {
        ...base,
        packLevelId,
        unitsPerPack,
        suggestion: suggestDiscount({
          medicine,
          mrpMinor,
          unitPriceMinor: mrpMinor,
          unitCostMinor: costMinor,
          policy,
          elasticity: estimate?.elasticity ?? null,
          lowestCompetitorPriceMinor: competitor?.observedPriceMinor ?? null,
        }),
        elasticity: estimate,
      };
    })
  );
}
