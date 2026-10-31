import type { Prisma } from '@/generated/prisma/client';

export type PublishTaxRule = {
  ruleCode: string;
  paymentCategory: 'CASH' | 'CARD' | 'OTHER';
  rate: string;
  priceMode: 'EXCLUSIVE' | 'INCLUSIVE';
};

export type PublishTaxProfile = {
  organizationId: string;
  branchId: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  approvalReference: string;
  idempotencyKey: string;
  payloadHash: string;
  source: {
    authorityCode: string;
    documentTitle: string;
    sourceUrl: string;
    contentHash: string;
    retrievedAt: Date;
  };
  rules: PublishTaxRule[];
  presetId?: string;
  eligibilityEvidence: Prisma.InputJsonValue;
  profileName?: string;
  jurisdictionCode?: string;
  priceMode?: 'EXCLUSIVE' | 'INCLUSIVE';
  evidenceKind?: string;
  replaceOpenProfile?: boolean;
};

/** Shared, lock-serialized publication path for curated and customer-supplied profiles. */
export async function publishTaxProfile(tx: Prisma.TransactionClient, input: PublishTaxProfile) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}:${input.branchId}`}, 0))`;

  const replay = await tx.restaurantTaxProfileVersion.findUnique({
    where: {
      organizationId_activationIdempotencyKey: {
        organizationId: input.organizationId,
        activationIdempotencyKey: input.idempotencyKey,
      },
    },
    include: { rules: true },
  });
  if (replay)
    return replay.activationPayloadHash === input.payloadHash
      ? ({ kind: 'replay' as const, profile: replay } as const)
      : ({ kind: 'idempotency-conflict' as const } as const);

  const current = await tx.restaurantTaxProfileVersion.findFirst({
    where: {
      branchId: input.branchId,
      status: 'PUBLISHED',
      effectiveFrom: { lt: input.effectiveFrom },
      effectiveTo: null,
    },
    include: { rules: true },
  });
  if (current && !input.replaceOpenProfile) return { kind: 'occupied' as const };

  const overlap = await tx.restaurantTaxProfileVersion.findFirst({
    where: {
      ...(current ? { id: { not: current.id } } : {}),
      branchId: input.branchId,
      status: 'PUBLISHED',
      effectiveFrom: { lt: input.effectiveTo ?? new Date('9999-12-31T23:59:59.999Z') },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveFrom } }],
    },
    select: { id: true },
  });
  if (overlap) return { kind: 'occupied' as const };

  if (current) {
    await tx.restaurantTaxRuleVersion.updateMany({
      where: { profileVersionId: current.id, effectiveTo: null },
      data: { effectiveTo: input.effectiveFrom },
    });
    await tx.restaurantTaxProfileVersion.update({
      where: { id: current.id },
      data: { effectiveTo: input.effectiveFrom },
    });
  }

  const source = await tx.restaurantTaxOfficialSource.upsert({
    where: {
      organizationId_contentHash: {
        organizationId: input.organizationId,
        contentHash: input.source.contentHash,
      },
    },
    update: {},
    create: input.source,
  });
  const latest = await tx.restaurantTaxProfileVersion.findFirst({
    where: { branchId: input.branchId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  });
  const now = new Date();
  const profile = await tx.restaurantTaxProfileVersion.create({
    data: {
      branchId: input.branchId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      status: 'PUBLISHED',
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      approvalReference: input.approvalReference,
      approvedAt: now,
      publishedAt: now,
      presetId: input.presetId,
      activationIdempotencyKey: input.idempotencyKey,
      activationPayloadHash: input.payloadHash,
      eligibilityEvidence: input.eligibilityEvidence,
      profileName: input.profileName,
      jurisdictionCode: input.jurisdictionCode,
      priceMode: input.priceMode,
      evidenceKind: input.evidenceKind,
      rules: {
        create: input.rules.map((rule) => ({
          ...rule,
          officialSourceId: source.id,
          status: 'PUBLISHED' as const,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          approvalReference: input.approvalReference,
          approvedAt: now,
          publishedAt: now,
        })),
      },
    },
    include: { rules: true },
  });
  return { kind: 'created' as const, profile };
}
