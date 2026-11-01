import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Valid persisted regulatory state for sales fixtures that exercise other gates. */
export function pharmacyRegulatoryFixture(branchId: string) {
  const validFrom = new Date(Date.now() - 86_400_000);
  const validTo = new Date(Date.now() + 365 * 86_400_000);
  const rules = {
    id: `rules_${branchId}`,
    code: `TEST-${branchId}`,
    version: 1,
    effectiveFrom: validFrom,
    licenceCategories: { provisional: false, values: ['PHARMACY'] },
    permittedSchedules: { provisional: false, values: ['OTC', 'RX', 'CONTROLLED'] },
    prescriptionOnlyClasses: { provisional: false, values: ['RX'] },
    prescriptionRetentionDays: { provisional: false, values: {} },
    controlledRegisterFlags: { provisional: false, values: {} },
    pharmacistCoverageRule: { provisional: false, values: {} },
    recordRetentionByClass: { provisional: false, values: {} },
  };
  const profile = {
    branchId,
    version: 1,
    effectiveFrom: validFrom,
    provinceCode: 'PK-PB',
    jurisdictionRuleSetId: rules.id,
    premises: { addressLine: '1 Test Road', city: 'Lahore' },
    licenceCategory: 'PHARMACY',
    licenceNumber: 'TEST-LICENCE',
    licenceValidFrom: validFrom,
    licenceValidTo: validTo,
    licenceEvidenceFileRef: '/api/files/test-licence.pdf',
    permittedSchedules: ['OTC', 'RX', 'CONTROLLED'],
    qualifiedPersonRegistration: 'TEST-QP',
    qualifiedPersonValidFrom: validFrom,
    qualifiedPersonValidTo: validTo,
    qualifiedPersonCoverageRosterRef: '/api/files/test-roster.pdf',
    fiscalStatus: 'UNCONFIRMED',
    retentionPolicy: {},
  };
  return { rules, profile };
}

type RunIn = <T>(run: (tx: ScopedDb) => Promise<T>) => Promise<T>;

/**
 * Persists a valid rule set (platform transaction) and branch profile (tenant
 * transaction) so DB suites pass the regulatory sale gate. Returns the rule-set id
 * for `retirePharmacyRegulatoryRules`.
 */
export async function seedPharmacyRegulatoryProfile(
  platform: RunIn,
  tenant: RunIn,
  branchId: string
): Promise<string> {
  const { rules, profile } = pharmacyRegulatoryFixture(branchId);
  await platform((tx) => tx.jurisdictionRuleSet.create({ data: rules }));
  await tenant((tx) => tx.branchRegulatoryProfile.create({ data: profile }));
  return rules.id;
}

/**
 * Rule sets are global and append-only, so a suite cannot delete its synthetic
 * `TEST-*` rules. Closing them keeps them out of the published-jurisdiction list
 * other suites (onboarding) read.
 */
export async function retirePharmacyRegulatoryRules(
  platform: RunIn,
  ruleSetIds: string[]
): Promise<void> {
  if (ruleSetIds.length === 0) return;
  await platform((tx) =>
    tx.jurisdictionRuleSet.updateMany({
      where: { id: { in: ruleSetIds }, effectiveTo: null },
      data: { effectiveTo: new Date() },
    })
  );
}
