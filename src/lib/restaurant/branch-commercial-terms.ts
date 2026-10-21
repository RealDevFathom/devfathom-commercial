import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { BranchCommercialTerms } from './commercial-terms';

export type { BranchCommercialTerms };

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
  const [profiles, policy] = await Promise.all([
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
    db.restaurantServiceChargePolicyVersion.findFirst({
      where: { branchId, ...effectiveWindow },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
      select: { rate: true },
    }),
  ]);

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
