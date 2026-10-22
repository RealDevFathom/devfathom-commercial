import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { BranchCommercialTerms } from './commercial-terms';

export type { BranchCommercialTerms };

export class BranchCommercialTermsError extends Error {
  readonly code = 'SERVICE_CHARGE_POLICY_CONFLICT' as const;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * The published tax profile and the service-charge rate a draft check must use.
 * The branch comes from the terminal, never from the request.
 */
export async function loadBranchCommercialTerms(
  db: ScopedDb,
  branchId: string,
  at: Date
): Promise<BranchCommercialTerms> {
  const effectiveWindow = {
    effectiveFrom: { lte: at },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
  };
  const [profiles, policies] = await Promise.all([
    db.restaurantTaxProfileVersion.findMany({
      where: { branchId, status: 'PUBLISHED', ...effectiveWindow },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        effectiveFrom: true,
        effectiveTo: true,
        status: true,
        approvalReference: true,
        approvedAt: true,
        rules: {
          where: { status: 'PUBLISHED', ...effectiveWindow },
          select: {
            id: true,
            profileVersionId: true,
            paymentCategory: true,
            priceMode: true,
            rate: true,
            effectiveFrom: true,
            effectiveTo: true,
            status: true,
            approvalReference: true,
            approvedAt: true,
            officialSource: { select: { expiresAt: true } },
          },
        },
      },
    }),
    db.restaurantServiceChargePolicyVersion.findMany({
      where: { branchId, ...effectiveWindow },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
      take: 2,
      select: { rate: true },
    }),
  ]);

  // Publication prevents overlapping intervals, but do not silently choose one
  // if corrupt or legacy data violates that invariant. Ambiguous commercial
  // terms must deny pricing rather than undercharge a check.
  if (policies.length > 1) {
    throw new BranchCommercialTermsError('Conflicting service-charge policies are in effect.');
  }
  const policy = policies[0];

  return {
    profiles: profiles.map((profile) => ({
      id: profile.id,
      effectiveFrom: profile.effectiveFrom.toISOString(),
      effectiveTo: iso(profile.effectiveTo),
      status: profile.status,
      approvalReference: profile.approvalReference,
      approvedAt: iso(profile.approvedAt),
    })),
    rules: profiles.flatMap((profile) =>
      profile.rules.map((rule) => ({
        id: rule.id,
        profileVersionId: rule.profileVersionId,
        paymentCategory: rule.paymentCategory,
        priceMode: rule.priceMode,
        rate: rule.rate.toString(),
        effectiveFrom: rule.effectiveFrom.toISOString(),
        effectiveTo: iso(rule.effectiveTo),
        status: rule.status,
        approvalReference: rule.approvalReference,
        approvedAt: iso(rule.approvedAt),
        sourceExpiresAt: iso(rule.officialSource.expiresAt),
      }))
    ),
    serviceChargeRate: policy ? policy.rate.toString() : null,
  };
}
