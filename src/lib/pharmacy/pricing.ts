import { enforceOperatingMode } from './operating-mode';
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
async function lockPrices(db: ScopedDb, scope: PriceScope) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${scope.organizationId}), hashtext('pharmacy-pack-prices'))`
  );
}

export async function confirmPriceChanges(db: ScopedDb, scope: PriceScope, ids: readonly string[]) {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
    return invalid('Select 1–100 distinct notices');
  return db.$transaction(async (tx) => {
    const scoped = tx as ScopedDb;
    await lockPrices(scoped, scope);
    const results = [];
    for (const id of [...ids].sort()) {
      const proposal = await scoped.pharmacyPriceChangeProposal.findFirst({
        where: { organizationId: scope.organizationId, id },
        include: { ingest: true },
      });
      if (!proposal) throw new TRPCError({ code: 'NOT_FOUND', message: 'Price notice not found' });
      const existing = await scoped.pharmacyPackPrice.findFirst({
        where: { organizationId: scope.organizationId, proposalId: id },
      });
      if (proposal.status === 'CONFIRMED') {
        if (!existing) return invalid('Legacy confirmation needs pack mapping and review');
        results.push(proposal);
        continue;
      }
      const notice = proposal.ingest.priceNotice as {
        presentation?: string;
        packLevel?: string;
      } | null;
      const pack = await resolveNoticePack(
        scoped,
        scope.organizationId,
        proposal.medicineId,
        notice?.presentation,
        notice?.packLevel,
        proposal.effectiveDate
      );
      if (!pack || pack.id !== proposal.packLevelId || proposal.ingest.matchStatus !== 'MATCHED')
        return invalid('Notice needs unambiguous presentation/pack mapping');
      const previous = await currentPackPrice(
        scoped,
        scope.organizationId,
        pack.id,
        proposal.effectiveDate
      );
      const price = await scoped.pharmacyPackPrice.create({
        data: {
          organizationId: scope.organizationId,
          presentationId: pack.presentationId,
          packLevelId: pack.id,
          mrpMinor: proposal.notifiedPriceMinor,
          sellingPriceMinor: previous?.sellingPriceMinor ?? null,
          effectiveFrom: proposal.effectiveDate,
          source: 'drap',
          proposalId: id,
          createdById: scope.actorId,
        },
      });
      results.push(
        await scoped.pharmacyPriceChangeProposal.update({
          where: { organizationId_id: { organizationId: scope.organizationId, id } },
          data: { status: 'CONFIRMED', confirmedById: scope.actorId, confirmedAt: new Date() },
        })
      );
      await scoped.auditLog.create({
        data: {
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          source: 'TRPC',
          category: 'PHARMACY',
          operation: 'UPDATE',
          action: 'pharmacyMedicine.confirmPrices',
          targetType: 'PharmacyPackPrice',
          targetId: price.id,
          changes: {
            previousMrpMinor: previous?.mrpMinor ?? null,
            mrpMinor: price.mrpMinor,
            packLevelId: pack.id,
            effectiveFrom: price.effectiveFrom.toISOString(),
            proposalId: id,
            branchOverrides: 'preserved; review derived from org version',
          },
        },
      });
    }
    return results;
  });
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
    pin?: string;
    approvedByUserId?: string;
  }
) {
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
    await enforceOperatingMode(
      scoped,
      { ...scope, branchId: input.branchId ?? null },
      {
        kind: 'OVERRIDE',
        makerIds: [scope.actorId],
        checkerId: input.approvedByUserId,
        targetType: 'PharmacyPackPrice',
        targetId: input.packLevelId,
        pin: input.pin,
      }
    );
    const { pin: _pin, approvedByUserId: _checker, ...priceInput } = input;
    void _pin;
    void _checker;
    const price = await scoped.pharmacyPackPrice.create({
      data: {
        ...priceInput,
        organizationId: scope.organizationId,
        presentationId: pack.presentationId,
        isOverride: !!input.branchId,
        source: 'manual',
        createdById: scope.actorId,
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
        },
      },
    });
    return price;
  });
}

export async function priceIntelligence(db: ScopedDb, scope: PriceScope) {
  const now = new Date();
  const notices = await db.pharmacyDrapIngest.findMany({
    where: { organizationId: scope.organizationId, kind: 'PRICE' },
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
      eligible: mapped && proposal?.status === 'PROPOSED',
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
