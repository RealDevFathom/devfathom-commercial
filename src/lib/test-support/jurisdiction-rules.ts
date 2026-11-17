// TEST_ONLY fixture: made-up values, never legal defaults.
export const testOnlyRules = {
  licenceCategories: { values: ['TEST_ONLY_LICENCE'], provisional: false },
  permittedSchedules: { values: ['RX'], provisional: false },
  prescriptionOnlyClasses: { values: ['TEST_ONLY_CLASS'], provisional: false },
  prescriptionRetentionDays: { values: { TEST_ONLY_CLASS: 123 }, provisional: false },
  controlledRegisterFlags: { values: { recordEverySale: true }, provisional: false },
  pharmacistCoverageRule: { values: { dispenseGrantRequired: true }, provisional: false },
  recordRetentionByClass: { values: { PRESCRIPTION: 321 }, provisional: false },
};
