import 'server-only';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import {
  discountPolicySchema,
  estimateDiscountElasticity,
  isRegulatedForDiscount,
  maxDiscountBpsSchema,
  parseDiscountPolicy,
  suggestDiscount,
  type DiscountDemandObservation,
  type DiscountPolicy,
} from './smart-discount';

const DAY_MS = 86_400_000;

/**
 * DEV-66: the organization's owner-set maximum discount, in bps. A missing or corrupt
 * value fails closed (0: no discount), never open.
 */
export async function readMaxDiscountBps(db: ScopedDb, organizationId: string) {
  const organization = await db.organization.findFirst({
    where: { id: organizationId },
    select: { pharmacyMaxDiscountBps: true },
  });
  const parsed = maxDiscountBpsSchema.safeParse(organization?.pharmacyMaxDiscountBps);
  return parsed.success ? parsed.data : 0;
}

/** The live identity the owner check reads, never the session role. */
async function isOrganizationOwner(db: ScopedDb, organizationId: string, userId: string) {
  const user = await db.user.findFirst({
    where: { id: userId, organizationId },
    select: {
      role: true,
      status: true,
      organizationRole: {
        select: {
          key: true,
          isSystem: true,
          permissions: { select: { capability: true, effect: true } },
        },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  return Boolean(user && hasAllCapabilityAccess(user));
}

export const MAX_DISCOUNT_CHANGE_REFUSED = 'Only the owner can change the maximum discount.';

/** DEV-66: the owner's maximum discount, and whether the caller is the owner who may change it. */
export async function readMaxDiscountSettings(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'actorId'>
) {
  const [maxDiscountBps, canChange] = await Promise.all([
    readMaxDiscountBps(db, scope.organizationId),
    isOrganizationOwner(db, scope.organizationId, scope.actorId),
  ]);
  return { maxDiscountBps, canChange };
}

/**
 * DEV-66: the owner alone sets the maximum discount for the whole organization. It binds
 * everyone, the owner included, on every line, promotion and voucher.
 */
export async function saveMaxDiscountBps(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'actorId'>,
  maxDiscountBps: number
) {
  const value = maxDiscountBpsSchema.parse(maxDiscountBps);
  if (!(await isOrganizationOwner(db, scope.organizationId, scope.actorId)))
    throw new TRPCError({ code: 'FORBIDDEN', message: MAX_DISCOUNT_CHANGE_REFUSED });
  const saved = await db.organization.update({
    where: { id: scope.organizationId },
    data: { pharmacyMaxDiscountBps: value },
    select: { pharmacyMaxDiscountBps: true },
  });
  return { maxDiscountBps: saved.pharmacyMaxDiscountBps };
}

/** DEV-66: the branch's discount policy; defaults when none is configured. */
export async function readDiscountPolicy(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId },
    select: { discountPolicy: true },
  });
  return parseDiscountPolicy(branch?.discountPolicy);
}

/**
 * DEV-66: every limit a discounted line must respect: the branch's minimum margin and the
 * owner's maximum discount for the organization.
 */
export async function readDiscountLimits(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
) {
  const [policy, maxDiscountBps] = await Promise.all([
    readDiscountPolicy(db, scope),
    readMaxDiscountBps(db, scope.organizationId),
  ]);
  return { minMarginBps: policy.minMarginBps, maxDiscountBps };
}

export async function readDiscountPolicySettings(db: ScopedDb, scope: LedgerScope) {
  const [branch, maxDiscountBps] = await Promise.all([
    db.pharmacyBranch.findFirst({
      where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
      select: { discountPolicy: true, discountPolicyRevision: true },
    }),
    readMaxDiscountBps(db, scope.organizationId),
  ]);
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND' });
  return {
    policy: parseDiscountPolicy(branch.discountPolicy),
    revision: branch.discountPolicyRevision,
    maxDiscountBps,
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
    packLevelId: string;
    competitorLabel: string;
    observedPriceMinor: number;
    observedAt: Date;
  }
) {
  // The pack level must be a pack of this medicine, so the price is like for like.
  const packLevel = await db.packLevel.findFirst({
    where: {
      organizationId: scope.organizationId,
      id: input.packLevelId,
      presentation: { medicineId: input.medicineId },
    },
    select: { id: true },
  });
  if (!packLevel) throw new TRPCError({ code: 'NOT_FOUND' });
  if (input.observedAt.getTime() > Date.now() + 5 * 60_000)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Observation is in the future.' });
  return db.pharmacyCompetitorPriceObservation.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      medicineId: input.medicineId,
      packLevelId: input.packLevelId,
      competitorLabel: input.competitorLabel,
      observedPriceMinor: input.observedPriceMinor,
      observedAt: input.observedAt,
      recordedByUserId: scope.actorId,
    },
    select: { id: true, observedAt: true },
  });
}

/** One row per medicine, sealed pack, UTC calendar day and side (discounted or full price). */
type DailySalesRow = {
  medicineId: string;
  packLevelId: string;
  day: string;
  discounted: boolean;
  units: bigint | number;
  netMinor: bigint | number;
};

const packKey = (medicineId: string, packLevelId: string) => `${medicineId}\u0000${packLevelId}`;

/**
 * Per sealed pack of the live lots in this branch: MRP is the lowest printed MRP
 * (the cap) and cost the highest unit cost (the conservative margin floor).
 * Competitor prices are per sealed pack as well. Every read is batched across the
 * requested medicines, and sale history is aggregated per day in the database, so
 * the number of queries does not grow with the request or with sales volume.
 */
export async function readDiscountSuggestions(
  db: ScopedDb,
  scope: LedgerScope,
  input: { medicineIds: readonly string[]; now?: Date }
) {
  const now = input.now ?? new Date();
  const [policy, maxDiscountBps, medicines] = await Promise.all([
    readDiscountPolicy(db, scope),
    readMaxDiscountBps(db, scope.organizationId),
    db.medicine.findMany({
      where: { organizationId: scope.organizationId, id: { in: [...input.medicineIds] } },
      select: { id: true, productName: true, rx: true, restricted: true, controlled: true },
    }),
  ]);
  const since = new Date(now.getTime() - policy.lookbackDays * DAY_MS);
  const competitorSince = new Date(now.getTime() - policy.competitorPriceMaxAgeDays * DAY_MS);
  // Regulated stock is never promoted, so nothing is read for it.
  const candidateIds = medicines
    .filter((medicine) => !isRegulatedForDiscount(medicine))
    .map((medicine) => medicine.id);
  const lots = candidateIds.length
    ? await db.pharmacyInventoryLot.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          // Only stock the branch can sell now: received, active and unexpired
          // batch, and an available balance above zero.
          receivedAt: { not: null },
          batch: { state: 'ACTIVE', expiresAt: { gt: now }, medicine: { saleable: true } },
          balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
          packLevel: { presentation: { medicineId: { in: candidateIds } } },
        },
        select: {
          packLevelId: true,
          printedMrpMinor: true,
          unitCostMinor: true,
          unitsPerPack: true,
          packLevel: { select: { presentation: { select: { medicineId: true } } } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      })
    : [];
  // Compare like with like: per medicine, only lots of its newest lot's pack level,
  // aggregated over every eligible lot of that pack (never a truncated sample).
  const packs = new Map<
    string,
    { packLevelId: string; unitsPerPack: number; mrpMinor: number; costMinor: number }
  >();
  for (const lot of lots) {
    const medicineId = lot.packLevel.presentation.medicineId;
    const pack = packs.get(medicineId);
    const costMinor = lot.unitCostMinor * lot.unitsPerPack;
    if (!pack)
      packs.set(medicineId, {
        packLevelId: lot.packLevelId,
        unitsPerPack: lot.unitsPerPack,
        mrpMinor: lot.printedMrpMinor,
        costMinor,
      });
    else if (pack.packLevelId === lot.packLevelId) {
      pack.mrpMinor = Math.min(pack.mrpMinor, lot.printedMrpMinor);
      pack.costMinor = Math.max(pack.costMinor, costMinor);
    }
  }
  const stockedIds = [...packs.keys()];
  const [competitorRows, salesRows] = stockedIds.length
    ? await Promise.all([
        db.pharmacyCompetitorPriceObservation.groupBy({
          by: ['medicineId', 'packLevelId'],
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            medicineId: { in: stockedIds },
            packLevelId: { in: [...new Set([...packs.values()].map((p) => p.packLevelId))] },
            observedAt: { gte: competitorSince },
          },
          _min: { observedPriceMinor: true },
        }),
        db.$queryRaw<DailySalesRow[]>`
          SELECT l."medicineId", l."packLevelId",
                 to_char(l."createdAt", 'YYYY-MM-DD') AS day,
                 (l."discountMinor" > 0) AS discounted,
                 SUM(l."canonicalUnits") AS units,
                 SUM(l."grossMinor" - l."discountMinor") AS "netMinor"
            FROM "pharmacy_sale_lines" l
            JOIN "pharmacy_sales" s
              ON s."organizationId" = l."organizationId"
             AND s."branchId" = l."branchId"
             AND s."id" = l."saleId"
           WHERE l."organizationId" = ${scope.organizationId}
             AND l."branchId" = ${scope.branchId}
             AND l."medicineId" = ANY(${stockedIds}::text[])
             AND l."createdAt" >= ${since}
             AND s."status" = 'COMPLETED'
           GROUP BY 1, 2, 3, 4`,
      ])
    : [[], []];
  const competitorMin = new Map(
    competitorRows.map((row) => [
      packKey(row.medicineId, row.packLevelId),
      row._min.observedPriceMinor ?? null,
    ])
  );
  // Demand evidence for the selected sealed pack only; other pack sizes price differently.
  const demand = new Map<string, DiscountDemandObservation[]>();
  for (const row of salesRows) {
    const key = packKey(row.medicineId, row.packLevelId);
    const rows = demand.get(key) ?? [];
    rows.push({
      day: row.day,
      units: Number(row.units),
      netMinor: Number(row.netMinor),
      discounted: row.discounted,
    });
    demand.set(key, rows);
  }
  return medicines.map((medicine) => {
    const base = { medicineId: medicine.id, productName: medicine.productName };
    if (isRegulatedForDiscount(medicine))
      return {
        ...base,
        suggestion: suggestDiscount({
          medicine,
          mrpMinor: 0,
          unitPriceMinor: 0,
          unitCostMinor: 0,
          policy,
          maxDiscountBps,
          elasticity: null,
          lowestCompetitorPriceMinor: null,
        }),
        elasticity: null,
      };
    const pack = packs.get(medicine.id);
    if (!pack) return { ...base, suggestion: null, elasticity: null };
    const key = packKey(medicine.id, pack.packLevelId);
    const estimate = estimateDiscountElasticity(demand.get(key) ?? [], policy.minObservationDays);
    return {
      ...base,
      packLevelId: pack.packLevelId,
      unitsPerPack: pack.unitsPerPack,
      suggestion: suggestDiscount({
        medicine,
        mrpMinor: pack.mrpMinor,
        unitPriceMinor: pack.mrpMinor,
        unitCostMinor: pack.costMinor,
        policy,
        maxDiscountBps,
        elasticity: estimate?.elasticity ?? null,
        lowestCompetitorPriceMinor: competitorMin.get(key) ?? null,
      }),
      elasticity: estimate,
    };
  });
}
