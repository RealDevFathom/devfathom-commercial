import type { PharmacyTaxProductClass, Prisma } from '@/generated/prisma/client';
import { pharmacyCalendarDayRange } from './business-day';
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
    effectiveFrom: Date | string;
    effectiveTo?: Date | string | null;
    approvalReference: string;
    idempotencyKey: string;
    rules: PharmacyTaxRuleInput[];
  },
  timeZone?: string | null
) {
  const calendarStart = (day: string) => pharmacyCalendarDayRange(day, day, timeZone).from;
  let effectiveFrom =
    typeof input.effectiveFrom === 'string'
      ? calendarStart(input.effectiveFrom)
      : input.effectiveFrom;
  let effectiveTo =
    typeof input.effectiveTo === 'string' ? calendarStart(input.effectiveTo) : input.effectiveTo;
  if (
    !input.name.trim() ||
    !input.approvalReference.trim() ||
    input.rules.length === 0 ||
    (typeof input.effectiveFrom === typeof input.effectiveTo &&
      effectiveTo &&
      effectiveFrom >= effectiveTo)
  )
    throw new PharmacyTaxProfileError('INVALID');
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.organizationId}:${scope.branchId}:pharmacy-tax`}, 0))`;
  const replay = await db.pharmacyTaxProfileVersion.findFirst({
    where: { organizationId: scope.organizationId, idempotencyKey: input.idempotencyKey },
    include: { rules: true },
  });
  if (replay) return replay;
  if (typeof input.effectiveFrom === 'string') {
    // The old date picker published this label as midnight UTC. Join a replacement
    // to that exact approved end while holding the same lock as the overlap check.
    const previous = await db.pharmacyTaxProfileVersion.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'PUBLISHED',
        effectiveTo: new Date(input.effectiveFrom),
      },
      select: { effectiveTo: true },
    });
    if (previous?.effectiveTo) effectiveFrom = previous.effectiveTo;
  }
  if (typeof input.effectiveTo === 'string') {
    const following = await db.pharmacyTaxProfileVersion.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'PUBLISHED',
        effectiveFrom: new Date(input.effectiveTo),
      },
      select: { effectiveFrom: true },
    });
    if (following) effectiveTo = following.effectiveFrom;
  }
  if (effectiveTo && effectiveFrom >= effectiveTo) throw new PharmacyTaxProfileError('INVALID');
  const overlap = await db.pharmacyTaxProfileVersion.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'PUBLISHED',
      effectiveFrom: { lt: effectiveTo ?? new Date('9999-12-31T23:59:59.999Z') },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }],
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
      effectiveFrom,
      effectiveTo,
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
