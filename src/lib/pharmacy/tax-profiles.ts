import type { PharmacyTaxProductClass, Prisma } from '@/generated/prisma/client';
import { calculateTaxAmount, resolveTaxProfile } from '@/lib/tax/calculator';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export class PharmacyTaxProfileError extends Error {
  constructor(readonly reason: 'INVALID' | 'OVERLAP' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT') {
    super(reason);
    this.name = 'PharmacyTaxProfileError';
  }
}

export type PharmacyTaxRuleInput = {
  productClass: PharmacyTaxProductClass;
  pctHsCode: string;
  sroReference?: string | null;
  exemptionCode?: string | null;
  priceMode: 'EXCLUSIVE' | 'INCLUSIVE';
  rate: string;
  roundingScale?: number;
};

export async function publishPharmacyTaxProfile(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId: string },
  input: {
    name: string;
    effectiveFrom: Date;
    effectiveTo?: Date | null;
    approvalReference: string;
    idempotencyKey: string;
    rules: PharmacyTaxRuleInput[];
  }
) {
  if (
    !input.name.trim() ||
    !input.approvalReference.trim() ||
    input.rules.length === 0 ||
    (input.effectiveTo && input.effectiveFrom >= input.effectiveTo)
  )
    throw new PharmacyTaxProfileError('INVALID');
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.organizationId}:${scope.branchId}:pharmacy-tax`}, 0))`;
  const replay = await db.pharmacyTaxProfileVersion.findFirst({
    where: { organizationId: scope.organizationId, idempotencyKey: input.idempotencyKey },
    include: { rules: true },
  });
  if (replay) return replay;
  const overlap = await db.pharmacyTaxProfileVersion.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'PUBLISHED',
      effectiveFrom: { lt: input.effectiveTo ?? new Date('9999-12-31T23:59:59.999Z') },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveFrom } }],
    },
    select: { id: true },
  });
  if (overlap) throw new PharmacyTaxProfileError('OVERLAP');
  const latest = await db.pharmacyTaxProfileVersion.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  });
  return db.pharmacyTaxProfileVersion.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      name: input.name,
      status: 'PUBLISHED',
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      approvalReference: input.approvalReference,
      approvedAt: new Date(),
      approvedByUserId: scope.actorId,
      idempotencyKey: input.idempotencyKey,
      rules: {
        create: input.rules.map((rule) => ({
          productClass: rule.productClass,
          pctHsCode: rule.pctHsCode,
          sroReference: rule.sroReference,
          sroProvisional: true,
          exemptionCode: rule.exemptionCode,
          priceMode: rule.priceMode,
          rate: rule.rate,
          roundingScale: rule.roundingScale ?? 2,
        })),
      },
    },
    include: { rules: true },
  });
}

export async function calculatePharmacyTax(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    at: Date;
    productClass: PharmacyTaxProductClass;
    pctHsCode: string;
    consideration: string | Prisma.Decimal;
  }
) {
  const profiles = await db.pharmacyTaxProfileVersion.findMany({
    where: { organizationId: input.organizationId, branchId: input.branchId, status: 'PUBLISHED' },
    include: { rules: true },
  });
  const profile = resolveTaxProfile(
    profiles.map((candidate) => ({
      ...candidate,
      status: candidate.status === 'PUBLISHED' ? ('PUBLISHED' as const) : ('DRAFT' as const),
    })),
    input.at
  );
  const selected = profiles
    .find((candidate) => candidate.id === profile.id)
    ?.rules.find(
      (rule) => rule.productClass === input.productClass && rule.pctHsCode === input.pctHsCode
    );
  if (!selected) throw new PharmacyTaxProfileError('NOT_FOUND');
  return {
    profileVersionId: profile.id,
    ruleVersionId: selected.id,
    ...calculateTaxAmount({
      consideration: input.consideration,
      rate: selected.rate,
      priceMode: selected.priceMode,
      roundingScale: selected.roundingScale,
    }),
  };
}
