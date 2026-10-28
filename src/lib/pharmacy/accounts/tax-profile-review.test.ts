import { describe, expect, it } from 'vitest';
import {
  compareRecordedTaxProfiles,
  recordedTaxProfileReviewCsv,
  type TaxProfileReviewDto,
} from './tax-profile-review';

const profile = (
  id: string,
  rate: string,
  overrides: Partial<TaxProfileReviewDto> = {}
): TaxProfileReviewDto => ({
  id,
  organizationId: 'org',
  branchId: 'branch',
  versionNumber: id === 'v1' ? 1 : 2,
  name: `Profile ${id}`,
  status: 'PUBLISHED',
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: null,
  approvalReference: 'APPROVED',
  approvedAt: '2026-01-01T00:00:00Z',
  rules: [
    {
      id: `r-${id}`,
      organizationId: 'org',
      profileVersionId: id,
      productClass: 'MEDICINE',
      pctHsCode: '3004',
      rate,
      priceMode: 'INCLUSIVE',
      roundingScale: 2,
      sroReference: null,
      sroProvisional: true,
      exemptionCode: null,
    },
  ],
  ...overrides,
});

const compare = (profiles: TaxProfileReviewDto[]) =>
  compareRecordedTaxProfiles({
    organizationId: 'org',
    branchId: 'branch',
    selectedVersionIds: ['v1', 'v2'],
    profiles,
  });

describe('recorded tax profile review', () => {
  it('compares exact decimal strings and preserves zero plus nullable evidence', () => {
    const review = compare([profile('v1', '0'), profile('v2', '0.123456')]);
    expect(review.changes).toMatchObject([
      { kind: 'CHANGED', before: { rate: '0', exemptionCode: null }, after: { rate: '0.123456' } },
    ]);
    expect(review.before.effectiveTo).toBeNull();
  });

  it.each([
    [profile('v1', '0', { status: 'DRAFT' }), profile('v2', '0.1')],
    [profile('v1', '0'), profile('v2', '0.1', { organizationId: 'foreign' })],
    [profile('v1', '0'), profile('v2', '0.1', { approvedAt: null })],
  ])('refuses unapproved or foreign selected DTOs', (one, two) => {
    expect(() => compare([one, two])).toThrow(/approved|scope/);
  });

  it('refuses duplicate and foreign rule DTOs', () => {
    const second = profile('v2', '0.1');
    second.rules.push({ ...second.rules[0], id: 'duplicate' });
    expect(() => compare([profile('v1', '0'), second])).toThrow(/duplicate/);
    second.rules = [{ ...second.rules[0], organizationId: 'foreign' }];
    expect(() => compare([profile('v1', '0'), second])).toThrow(/foreign/);
  });

  it('emits deterministic, formula-safe CSV without unsafe controls', () => {
    const first = profile('v1', '0');
    const second = profile('v2', '0.123456', { approvalReference: '=HYPERLINK("bad")\u0007' });
    second.rules[0].exemptionCode = '+cmd';
    const csv = recordedTaxProfileReviewCsv(compare([first, second]));
    expect(csv).toContain('"0.123456"');
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).toContain('"\'+cmd"');
    expect(csv).not.toContain('\u0007');
    expect(csv).toBe(recordedTaxProfileReviewCsv(compare([first, second])));
  });
});
