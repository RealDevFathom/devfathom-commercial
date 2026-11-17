import { describe, expect, it } from 'vitest';
import {
  allRulesConfirmed,
  jurisdictionRulesSchema,
  RULE_FIELDS,
  ruleFieldConfirmed,
} from './jurisdiction-rules';
import { pharmacistPresentAt } from '@/lib/pharmacy/regulatory';

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
    ['permittedSchedules', ['*']],
    ['permittedSchedules', ['RX*']],
    ['permittedSchedules', ['S'.repeat(61)]],
    ['permittedSchedules', Array.from({ length: 41 }, (_, index) => `S${index}`)],
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
    [
      'pharmacistCoverageRule',
      { presenceHours: { windows: [{ days: [1], start: '24:00', end: '24:00' }] } },
    ],
    [
      'pharmacistCoverageRule',
      { presenceHours: { windows: [{ days: [1], start: '20:00', end: '24:01' }] } },
    ],
    [
      'pharmacistCoverageRule',
      { presenceHours: { windows: [{ days: [1], start: '09:00', end: '09:00' }] } },
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

describe('presence windows ending at midnight (TEST_ONLY values)', () => {
  it.each([
    [[{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }]],
    [
      [
        { days: [1], start: '20:00', end: '24:00' },
        { days: [2], start: '00:00', end: '08:00' },
      ],
    ],
  ])('accepts %j, as the pharmacist-presence gate does', (windows) => {
    const values = { presenceHours: { timeZone: 'Asia/Karachi', windows } };
    const field = { values, provisional: false };
    expect(
      jurisdictionRulesSchema.safeParse({ ...testOnlyRules, pharmacistCoverageRule: field }).success
    ).toBe(true);
    // The gate covers 23:59 local time, so the published window leaves no gap.
    expect(pharmacistPresentAt(field, new Date('2026-11-16T18:59:00Z'))).toBe(true);
  });
});

describe('published schedule names (TEST_ONLY values)', () => {
  it('accepts schedule names branch profiles already record', () => {
    const permittedSchedules = { values: ['G', 'OTC', 'TEST_ONLY_SCHEDULE'], provisional: false };
    expect(jurisdictionRulesSchema.parse({ ...testOnlyRules, permittedSchedules })).toMatchObject({
      permittedSchedules,
    });
  });
});

describe('confirmation contract (TEST_ONLY values)', () => {
  const emptyValues: Record<(typeof RULE_FIELDS)[number], unknown> = {
    licenceCategories: [],
    permittedSchedules: [],
    prescriptionOnlyClasses: [],
    prescriptionRetentionDays: {},
    controlledRegisterFlags: {},
    pharmacistCoverageRule: {},
    recordRetentionByClass: {},
  };

  it.each(RULE_FIELDS)('refuses %s confirmed while review is outstanding', (field) => {
    const pending = { ...testOnlyRules[field], toConfirm: 'TEST_ONLY outstanding review' };
    expect(jurisdictionRulesSchema.safeParse({ ...testOnlyRules, [field]: pending }).success).toBe(
      false
    );
    expect(allRulesConfirmed({ ...testOnlyRules, [field]: pending })).toBe(false);
    expect(ruleFieldConfirmed(pending)).toBe(false);
  });

  it.each(RULE_FIELDS)('refuses %s confirmed with an empty section', (field) => {
    const empty = { values: emptyValues[field], provisional: false };
    expect(jurisdictionRulesSchema.safeParse({ ...testOnlyRules, [field]: empty }).success).toBe(
      false
    );
    expect(allRulesConfirmed({ ...testOnlyRules, [field]: empty })).toBe(false);
  });

  it('refuses the reported all-empty, outstanding-review payload marked confirmed', () => {
    const payload = Object.fromEntries(
      RULE_FIELDS.map((field) => [
        field,
        {
          values: emptyValues[field],
          toConfirm: 'TEST_ONLY outstanding counsel review',
          provisional: false,
        },
      ])
    );
    expect(jurisdictionRulesSchema.safeParse(payload).success).toBe(false);
    expect(allRulesConfirmed(payload as Record<(typeof RULE_FIELDS)[number], unknown>)).toBe(false);
  });

  it('still allows an empty, outstanding field to be published as provisional', () => {
    const payload = Object.fromEntries(
      RULE_FIELDS.map((field) => [
        field,
        {
          values: emptyValues[field],
          toConfirm: 'TEST_ONLY outstanding review',
          provisional: true,
        },
      ])
    );
    expect(jurisdictionRulesSchema.safeParse(payload).success).toBe(true);
    expect(allRulesConfirmed(payload as Record<(typeof RULE_FIELDS)[number], unknown>)).toBe(false);
  });

  it('treats a missing or non-object field as unconfirmed', () => {
    expect(ruleFieldConfirmed(undefined)).toBe(false);
    expect(ruleFieldConfirmed(null)).toBe(false);
    expect(ruleFieldConfirmed({ values: ['TEST_ONLY'] })).toBe(false);
    expect(ruleFieldConfirmed({ values: ['TEST_ONLY'], provisional: false })).toBe(true);
  });
});
