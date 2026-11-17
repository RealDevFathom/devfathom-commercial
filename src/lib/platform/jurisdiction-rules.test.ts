import { describe, expect, it } from 'vitest';
import { allRulesConfirmed, jurisdictionRulesSchema, RULE_FIELDS } from './jurisdiction-rules';

import { testOnlyRules } from '@/lib/test-support/jurisdiction-rules';

describe('jurisdiction rule storage contract (TEST_ONLY values, not legal rules)', () => {
  it('validates all seven fields without inventing legal defaults', () => {
    expect(jurisdictionRulesSchema.parse(testOnlyRules)).toEqual(testOnlyRules);
  });
  it.each(RULE_FIELDS)('requires explicit provenance and rejects unknown keys for %s', (field) => {
    expect(
      jurisdictionRulesSchema.safeParse({ ...testOnlyRules, [field]: { values: [] } }).success
    ).toBe(false);
    expect(
      jurisdictionRulesSchema.safeParse({
        ...testOnlyRules,
        [field]: { ...testOnlyRules[field], bypass: true },
      }).success
    ).toBe(false);
  });
  it.each([
    ['licenceCategories', ['*']],
    ['licenceCategories', ['TEST_ONLY', 'TEST_ONLY']],
    ['permittedSchedules', ['UNSUPPORTED']],
    ['permittedSchedules', ['RX', 'RX']],
    ['prescriptionOnlyClasses', ['*']],
    ['prescriptionRetentionDays', { TEST_ONLY: -1 }],
    ['prescriptionRetentionDays', 0.5],
    ['controlledRegisterFlags', { recordEverySale: 'yes' }],
    ['controlledRegisterFlags', { emergencySupply: { maxUnits: 0, repeatWindowHours: 10 } }],
    [
      'controlledRegisterFlags',
      { emergencySupply: { maxUnits: 1, repeatWindowHours: 10, source: 'DEFAULT_POLICY' } },
    ],
    ['pharmacistCoverageRule', { presenceHours: { timeZone: 'Mars/Olympus', windows: [] } }],
    [
      'pharmacistCoverageRule',
      { presenceHours: { windows: [{ days: [7], start: '08:00', end: '09:00' }] } },
    ],
    [
      'pharmacistCoverageRule',
      { presenceHours: { windows: [{ days: [1], start: '18:00', end: '09:00' }] } },
    ],
    ['recordRetentionByClass', { UNSUPPORTED: 10 }],
    ['recordRetentionByClass', { FISCAL: 36526 }],
  ])('rejects invalid %s values %j', (field, values) => {
    expect(
      jurisdictionRulesSchema.safeParse({
        ...testOnlyRules,
        [field as string]: { values, provisional: false },
      }).success
    ).toBe(false);
  });
});

it.each(RULE_FIELDS)(
  'never announces a fully confirmed successor when %s is provisional',
  (field) => {
    expect(allRulesConfirmed(testOnlyRules)).toBe(true);
    expect(
      allRulesConfirmed({
        ...testOnlyRules,
        [field]: { ...testOnlyRules[field], provisional: true },
      })
    ).toBe(false);
  }
);
