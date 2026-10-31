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
