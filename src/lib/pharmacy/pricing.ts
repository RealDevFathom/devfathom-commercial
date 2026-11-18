import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type PriceScope = { organizationId: string; actorId: string };
const invalid = (message: string): never => {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
};

/** Canonical units are derived only from an unambiguous BOX/STRIP/UNIT chain. */
export function packUnits(
  nodes: readonly {
    id: string;
    parentPackLevelId: string | null;
    unitsPerParent: number;
    level: string;
  }[],
  id: string
): number {
  let node = nodes.find((n) => n.id === id);
  const seen = new Set<string>();
  let units = 1;
  while (node) {
    if (seen.has(node.id)) return invalid('Cyclic pack conversion');
    seen.add(node.id);
    const children = nodes.filter((n) => n.parentPackLevelId === node!.id);
    if (node.level === 'UNIT' && children.length === 0) return units;
    if (children.length !== 1) return invalid('Missing or ambiguous pack conversion');
    node = children[0];
    if (!Number.isSafeInteger(node.unitsPerParent) || node.unitsPerParent <= 0)
      return invalid('Invalid pack conversion');
    units *= node.unitsPerParent;
    if (!Number.isSafeInteger(units)) return invalid('Invalid pack conversion');
  }
  return invalid('Missing pack conversion');
}

export function priceVariance(selling: number | null, mrp: number | null, units: number) {
  const amountMinor = selling === null || mrp === null ? null : selling - mrp;
  return {
    amountMinor,
    percent: amountMinor === null || mrp === 0 ? null : (amountMinor / mrp!) * 100,
    sellingUnitMinor: selling === null ? null : selling / units,
    mrpUnitMinor: mrp === null ? null : mrp / units,
  };
}

export async function currentPackPrice(
  db: ScopedDb,
  organizationId: string,
  packLevelId: string,
  at = new Date(),
  branchId: string | null = null
) {
  return db.pharmacyPackPrice.findFirst({
    where: { organizationId, packLevelId, branchId, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
}

/** Exact named presentation and level, active on the notice's effective date. */
export async function resolveNoticePack(
  db: ScopedDb,
  organizationId: string,
  medicineId: string,
  presentation: string | undefined,
  level: string | undefined,
  at: Date
) {
  if (!presentation || !level) return null;
  const packs = await db.packLevel.findMany({
    where: {
      organizationId,
      level,
      presentation: { organizationId, medicineId, presentation },
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
  });
  if (packs.length !== 1) return null;
  const pack = packs[0]!;
  const nodes = await db.packLevel.findMany({
    where: {
      organizationId,
      presentationId: pack.presentationId,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
  });
  try {
    packUnits(nodes, pack.id);
  } catch {
    return null;
  }
  return pack;
}

// All policy writers share this transaction lock; unique effective dates also
// reject conflicting writes rather than silently choosing an arbitrary winner.
export async function lockPrices(db: ScopedDb, scope: PriceScope) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${scope.organizationId}), hashtext('pharmacy-pack-prices'))`
  );
}

/** DEV-693 owner decision (#1318): the one answer to any attempt to confirm a DRAP notice. */
export const DRAP_PRICE_INFORMATION_ONLY =
  'DRAP price notices are for information only and never change a price. Set the pack price yourself from the MRP printed on the pack.';

/**
 * DEV-693: a DRAP notice must never change a price, because shelf stock can
 * predate a DRAP price order. Every price-change proposal was drafted from a
 * DRAP notice (its ingest is required), so confirming one is refused before any
 * write. The proposal rows stay exactly as they are, as history. Owners set
 * prices with `setManualPackPrice`, which this does not touch.
 */
export async function confirmPriceChanges(
  db: ScopedDb,
  scope: PriceScope,
  ids: readonly string[]
): Promise<never> {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
    return invalid('Select 1–100 distinct notices');
  for (const id of [...ids].sort()) {
    const proposal = await db.pharmacyPriceChangeProposal.findFirst({
      where: { organizationId: scope.organizationId, id },
      select: { id: true, ingestId: true },
    });
    if (!proposal) throw new TRPCError({ code: 'NOT_FOUND', message: 'Price notice not found' });
  }
  return invalid(DRAP_PRICE_INFORMATION_ONLY);
}

/** Explicit policy input, never inferred from the last sale. Admin-only router. */
export async function setManualPackPrice(
  db: ScopedDb,
  scope: PriceScope,
  input: {
    packLevelId: string;
    branchId?: string;
    mrpMinor: number;
    sellingPriceMinor: number | null;
    effectiveFrom: Date;
  },
  /** DEV-928: who proposed this price when `scope.actorId` is the approver replaying it. */
  proposedById?: string
) {
  // MRP is the legal ceiling; a selling policy above it is never valid.
  if (input.sellingPriceMinor !== null && input.sellingPriceMinor > input.mrpMinor)
    return invalid('Selling price cannot exceed MRP');
  return db.$transaction(async (tx) => {
    const scoped = tx as ScopedDb;
    await lockPrices(scoped, scope);
    const pack = await scoped.packLevel.findFirst({
      where: { organizationId: scope.organizationId, id: input.packLevelId },
      include: { presentation: true },
    });
    if (!pack || pack.presentation.organizationId !== scope.organizationId)
      return invalid('Pack not found');
    if (
      input.branchId &&
      !(await scoped.pharmacyBranch.findFirst({
        where: { organizationId: scope.organizationId, id: input.branchId },
      }))
    )
      return invalid('Branch not found');
    const orgPrice = await scoped.pharmacyPackPrice.findFirst({
      where: { organizationId: scope.organizationId, packLevelId: pack.id, branchId: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    // DEV-928: the price this one replaces, in the same scope (this branch, or the
    // organisation-wide price), read before the append-only insert.
    const previous = await scoped.pharmacyPackPrice.findFirst({
      where: {
        organizationId: scope.organizationId,
        packLevelId: pack.id,
        branchId: input.branchId ?? null,
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    const price = await scoped.pharmacyPackPrice.create({
      data: {
        ...input,
        organizationId: scope.organizationId,
        presentationId: pack.presentationId,
        isOverride: !!input.branchId,
        source: 'manual',
        createdById: scope.actorId,
        proposedById: proposedById ?? scope.actorId,
        reviewedOrgPriceId: input.branchId ? orgPrice?.id : null,
      },
    });
    await scoped.auditLog.create({
      data: {
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        source: 'TRPC',
        category: 'PHARMACY',
        operation: 'CREATE',
        action: 'pharmacyMedicine.setPackPrice',
        targetType: 'PharmacyPackPrice',
        targetId: price.id,
        changes: {
          mrpMinor: price.mrpMinor,
          sellingPriceMinor: price.sellingPriceMinor,
          effectiveFrom: price.effectiveFrom.toISOString(),
          branchId: price.branchId,
          packLevelId: price.packLevelId,
          proposedById: price.proposedById,
          approvedById: scope.actorId,
          previousMrpMinor: previous?.mrpMinor ?? null,
          previousSellingPriceMinor: previous?.sellingPriceMinor ?? null,
        },
      },
    });
    return price;
  });
}

export async function priceIntelligence(db: ScopedDb, scope: PriceScope) {
  const now = new Date();
  const notices = await db.pharmacyDrapIngest.findMany({
    // DEV-693: a notice that raised an official-price alert is information only
    // and is listed with the alerts, not in this confirm queue.
    where: { organizationId: scope.organizationId, kind: 'PRICE', priceAlerts: { none: {} } },
    include: { priceChanges: { include: { medicine: { include: { aliases: true } } } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const rows = [];
  for (const ingest of notices) {
    const proposal = ingest.priceChanges.at(0);
    const notice = ingest.priceNotice as {
      presentation?: string;
      packLevel?: string;
      notifiedPriceMinor?: number;
      effectiveDate?: string;
      drapRegistrationNumber?: string;
    } | null;
    const pack = proposal
      ? await resolveNoticePack(
          db,
          scope.organizationId,
          proposal.medicineId,
          notice?.presentation,
          notice?.packLevel,
          proposal.effectiveDate
        )
      : null;
    const mapped = !!pack && pack.id === proposal?.packLevelId && ingest.matchStatus === 'MATCHED';
    const current = mapped ? await currentPackPrice(db, scope.organizationId, pack!.id, now) : null;
    const nodes = mapped
      ? await db.packLevel.findMany({
          where: {
            organizationId: scope.organizationId,
            presentationId: pack!.presentationId,
            effectiveFrom: { lte: proposal!.effectiveDate },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: proposal!.effectiveDate } }],
          },
        })
      : [];
    const units = mapped ? packUnits(nodes, pack!.id) : null;
    rows.push({
      id: ingest.id,
      proposalId: proposal?.id ?? null,
      reference: ingest.sourceReference,
      medicine:
        proposal?.medicine.productName ?? notice?.drapRegistrationNumber ?? 'Unmatched medicine',
      aliases: proposal?.medicine.aliases.map((a) => a.value) ?? [],
      presentation: notice?.presentation ?? 'Not supplied',
      packLevel: notice?.packLevel ?? 'Not supplied',
      packLevelId: pack?.id ?? null,
      units,
      status: !mapped ? 'NEEDS_MAPPING' : proposal!.status,
      // DEV-803: the proposal's own end state, kept even when the notice is unmapped.
      proposalStatus: proposal?.status ?? null,
      // DEV-693: DRAP notices are information only; none can be confirmed.
      eligible: false,
      effectiveDate:
        proposal?.effectiveDate ?? (notice?.effectiveDate ? new Date(notice.effectiveDate) : null),
      notifiedMrpMinor: proposal?.notifiedPriceMinor ?? notice?.notifiedPriceMinor ?? null,
      confirmedMrpMinor: current?.mrpMinor ?? null,
      sellingPriceMinor: current?.sellingPriceMinor ?? null,
      ...priceVariance(current?.sellingPriceMinor ?? null, current?.mrpMinor ?? null, units ?? 1),
    });
  }
  // Org-wide safety capability sees only org prices. Branch override amounts are
  // admin-only; this queue discloses no branch data to ordinary safety operators.
  const packs = await db.packLevel.findMany({
    where: {
      organizationId: scope.organizationId,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    include: { presentation: { include: { medicine: { include: { aliases: true } } } } },
    orderBy: [{ presentationId: 'asc' }, { id: 'asc' }],
  });
  const policies = await db.pharmacyPackPrice.findMany({
    where: { organizationId: scope.organizationId, branchId: null, effectiveFrom: { lte: now } },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  });
  const currentPolicies = new Map<string, (typeof policies)[number]>();
  for (const policy of policies) {
    if (!currentPolicies.has(policy.packLevelId)) currentPolicies.set(policy.packLevelId, policy);
  }
  const packRows = packs.flatMap((pack) => {
    const policy = currentPolicies.get(pack.id);
    if (!policy) return [];
    let units: number | null = null;
    try {
      units = packUnits(
        packs.filter((p) => p.presentationId === pack.presentationId),
        pack.id
      );
    } catch {
      // Keep same-pack variance available; ambiguous conversions have no unit preview.
    }
    const variance = priceVariance(policy.sellingPriceMinor, policy.mrpMinor, units ?? 1);
    return [
      {
        id: pack.id,
        medicineId: pack.presentation.medicineId,
        medicine: pack.presentation.medicine.productName,
        aliases: pack.presentation.medicine.aliases.map((a) => a.value),
        presentation: pack.presentation.presentation,
        packLevel: pack.level,
        units,
        effectiveDate: policy.effectiveFrom,
        source: policy.source,
        confirmedMrpMinor: policy.mrpMinor,
        sellingPriceMinor: policy.sellingPriceMinor,
        ...variance,
        mrpUnitMinor: units === null ? null : variance.mrpUnitMinor,
        sellingUnitMinor: units === null ? null : variance.sellingUnitMinor,
      },
    ];
  });
  return { asOf: now, rows, packRows };
}

export async function priceOverrides(db: ScopedDb, scope: PriceScope, branchId?: string) {
  const prices = await db.pharmacyPackPrice.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: branchId ?? { not: null },
      isOverride: true,
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  const result = [];
  for (const price of prices) {
    const org = await db.pharmacyPackPrice.findFirst({
      where: {
        organizationId: scope.organizationId,
        packLevelId: price.packLevelId,
        branchId: null,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const pack = await db.packLevel.findFirst({
      where: { organizationId: scope.organizationId, id: price.packLevelId },
      include: { presentation: { include: { medicine: true } } },
    });
    const branch = await db.pharmacyBranch.findFirst({
      where: { organizationId: scope.organizationId, id: price.branchId! },
    });
    result.push({
      ...price,
      branchName: branch?.name ?? price.branchId,
      medicine: pack?.presentation.medicine.productName ?? 'Unavailable medicine',
      presentation: pack?.presentation.presentation ?? price.presentationId,
      packLevel: pack?.level ?? price.packLevelId,
      needsReview: price.reviewedOrgPriceId !== (org?.id ?? null),
    });
  }
  return result;
}
