import type { TaxProfile, TaxRule } from './tax-calculator';

export type BranchCommercialTerms = {
  profiles: Array<{
    id: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    status: TaxProfile['status'];
    approvalReference: string | null;
    approvedAt: string | null;
  }>;
  rules: Array<{
    id: string;
    profileVersionId: string;
    paymentCategory: string;
    priceMode: TaxRule['priceMode'];
    rate: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    status: TaxRule['status'];
    approvalReference: string | null;
    approvedAt: string | null;
    sourceExpiresAt: string | null;
  }>;
  serviceChargeRate: string | null;
};

export type CommercialTermsQuote = {
  profiles: TaxProfile[];
  rules: TaxRule[];
  serviceChargeRate: string | null;
};

function date(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

/** Turn the terminal JSON payload into the dates the tax quote compares. */
export function reviveCommercialTerms(terms: BranchCommercialTerms): CommercialTermsQuote {
  return {
    serviceChargeRate: terms.serviceChargeRate,
    profiles: terms.profiles.map((profile) => ({
      id: profile.id,
      effectiveFrom: new Date(profile.effectiveFrom),
      effectiveTo: date(profile.effectiveTo),
      status: profile.status,
      approvalReference: profile.approvalReference,
      approvedAt: date(profile.approvedAt),
    })),
    rules: terms.rules.map((rule) => ({
      id: rule.id,
      profileVersionId: rule.profileVersionId,
      paymentCategory: rule.paymentCategory,
      priceMode: rule.priceMode,
      rate: rule.rate,
      effectiveFrom: new Date(rule.effectiveFrom),
      effectiveTo: date(rule.effectiveTo),
      status: rule.status,
      approvalReference: rule.approvalReference,
      approvedAt: date(rule.approvedAt),
      sourceExpiresAt: date(rule.sourceExpiresAt),
    })),
  };
}
