import { describe, expect, it } from 'vitest';
import {
  compareRecordedTaxProfiles,
  prepareTaxProfileReview,
  taxProfileReviewCsv,
  TaxProfileReviewError,
  type RecordedTaxProfile,
} from './tax-profile-review';

const scope = { organizationId: 'org-1', branchId: 'branch-1' } as const;
const rule = (id: string, profileVersionId: string, overrides = {}) => ({
  id,
  organizationId: scope.organizationId,
  profileVersionId,
  productClass: 'MEDICINE',
  pctHsCode: '3004.10',
  sroReference: null,
  sroProvisional: true,
  exemptionCode: null,
  priceMode: 'INCLUSIVE',
  rate: '0.123456',
  roundingScale: 2,
  ...overrides,
});
const profile = (
  id: string,
  versionNumber: number,
  rules: ReturnType<typeof rule>[],
  overrides: Partial<RecordedTaxProfile> = {}
): RecordedTaxProfile => ({
  id,
  organizationId: scope.organizationId,
  branchId: scope.branchId,
  versionNumber,
  name: `Version ${versionNumber}`,
  status: 'PUBLISHED',
  effectiveFrom: `2026-0${versionNumber}-01T00:00:00.000Z`,
  effectiveTo: null,
  approvalReference: `approval-${versionNumber}`,
  approvedAt: `2026-0${versionNumber}-01T00:00:00.000Z`,
  rules,
  ...overrides,
});

describe('recorded tax-profile review', () => {
  it('projects added, removed and changed composite keys without losing exact decimals', () => {
    const before = profile('p1', 1, [
      rule('r1', 'p1'),
      rule('r2', 'p1', { productClass: 'FRONT_SHOP', pctHsCode: 'old', rate: '0' }),
      rule('r3', 'p1', { productClass: 'MEDICINE', pctHsCode: 'same' }),
    ]);
    const after = profile('p2', 2, [
      rule('r4', 'p2', { rate: '0' }),
      rule('r5', 'p2', { productClass: 'FRONT_SHOP', pctHsCode: 'new' }),
      rule('r6', 'p2', { productClass: 'MEDICINE', pctHsCode: 'same' }),
    ]);
    const result = compareRecordedTaxProfiles({
      scope,
      profiles: [before, after],
      beforeProfileId: 'p1',
      afterProfileId: 'p2',
    });

    expect(result.rows.map(({ key, change }) => [key, change])).toEqual([
      ['FRONT_SHOP:new', 'ADDED'],
      ['FRONT_SHOP:old', 'REMOVED'],
      ['MEDICINE:3004.10', 'CHANGED'],
    ]);
    expect(result.rows[2]?.before?.rate).toBe('0.123456');
    expect(result.rows[2]?.after?.rate).toBe('0');
    expect(result.coverage).toBe('supplied_two_versions_only_not_complete');
    expect(Object.isFrozen(result.before)).toBe(true);
    expect(Object.isFrozen(result.before.rules)).toBe(true);
    expect(Object.isFrozen(result.before.rules[0])).toBe(true);
  });

  it('reports nullable approval, window and rule evidence changes without approving statuses', () => {
    const before = profile('p1', 1, [rule('r1', 'p1')], {
      status: 'DRAFT',
      approvalReference: null,
      approvedAt: null,
      effectiveTo: null,
    });
    const after = profile(
      'p2',
      2,
      [
        rule('r2', 'p2', {
          sroProvisional: false,
          exemptionCode: 'EX-1',
          sroReference: null,
        }),
      ],
      { status: 'RETIRED', effectiveTo: '2026-03-01T00:00:00.000Z' }
    );
    const result = compareRecordedTaxProfiles({
      scope,
      profiles: [before, after],
      beforeProfileId: 'p1',
      afterProfileId: 'p2',
    });
    expect(result.profileChanges).toEqual({ approval: true, effectiveWindow: true, status: true });
    expect(result.rows[0]?.change).toBe('CHANGED');
    expect(result.before.status).toBe('DRAFT');
    expect(result.after.status).toBe('RETIRED');
  });

  it.each([
    ['foreign profile', [profile('p1', 1, [], { organizationId: 'other' }), profile('p2', 2, [])]],
    [
      'foreign rule',
      [profile('p1', 1, [rule('r1', 'p1', { organizationId: 'other' })]), profile('p2', 2, [])],
    ],
    ['wrong profile link', [profile('p1', 1, [rule('r1', 'p2')]), profile('p2', 2, [])]],
    ['duplicate profile', [profile('p1', 1, []), profile('p1', 2, [])]],
  ])('refuses %s', (_label, profiles) => {
    expect(() =>
      compareRecordedTaxProfiles({ scope, profiles, beforeProfileId: 'p1', afterProfileId: 'p2' })
    ).toThrow(TaxProfileReviewError);
  });

  it('refuses duplicate composite rule keys', () => {
    const before = profile('p1', 1, [rule('r1', 'p1'), rule('r2', 'p1')]);
    expect(() =>
      compareRecordedTaxProfiles({
        scope,
        profiles: [before, profile('p2', 2, [])],
        beforeProfileId: 'p1',
        afterProfileId: 'p2',
      })
    ).toThrowError(new TaxProfileReviewError('DUPLICATE_RULE'));
  });

  it('quotes CSV and neutralizes formulas and control characters', () => {
    const before = profile('p1', 1, [
      rule('r1', 'p1', { pctHsCode: '=cmd\nnext', sroReference: '@provider' }),
    ]);
    const after = profile('p2', 2, []);
    const csv = taxProfileReviewCsv(
      compareRecordedTaxProfiles({
        scope,
        profiles: [before, after],
        beforeProfileId: 'p1',
        afterProfileId: 'p2',
      })
    );
    expect(csv).toContain('"\'=cmd next"');
    expect(csv).toContain('"\'@provider"');
    expect(csv).toContain('"approval-1"');
    expect(csv).toContain('"2026-01-01T00:00:00.000Z"');
    expect(csv.split('\r\n')).toHaveLength(4);
  });
});

describe('pure bounded supplied DTO contract', () => {
  const input = (profiles: readonly RecordedTaxProfile[]) => ({
    scope,
    profiles,
    beforeProfileId: 'p1',
    afterProfileId: 'p2',
  });
  const rules = (id: string, n: number) =>
    Array.from({ length: n }, (_, i) => rule(`${id}-r${i}`, id, { pctHsCode: `code-${i}` }));
  it('accepts exactly100+100 rules without truncation and exports deterministic bytes', () => {
    const data = input([
      profile('p1', 1, rules('p1', 100)),
      profile(
        'p2',
        2,
        rules('p2', 100).map((r) => ({ ...r, rate: '0' }))
      ),
    ]);
    const result = prepareTaxProfileReview(data);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('not ready');
    expect(result.review.rows).toHaveLength(100);
    expect(prepareTaxProfileReview(data)).toEqual(result);
    expect(result.csv).toContain('unverified_dto_provenance_not_authorization_or_snapshot');
    expect(result.csv).toContain('"p1-r0"');
  });
  it.each([0, 1, 3])('rejects version count%s before comparison/export', (count) => {
    const profiles = Array.from({ length: count }, (_, i) => profile(`p${i + 1}`, i + 1, []));
    expect(prepareTaxProfileReview(input(profiles))).toEqual({ kind: 'error', csv: null });
  });
  it.each([0, 1])('refuses101 rules on side%s with no CSV', (side) => {
    const p = [profile('p1', 1, []), profile('p2', 2, [])];
    p[side] = profile(`p${side + 1}`, side + 1, rules(`p${side + 1}`, 101));
    expect(prepareTaxProfileReview(input(p))).toEqual({ kind: 'error', csv: null });
  });
  it('keeps null unknown distinct from explicitzero; semantic decimals normalize only for comparison', () => {
    const unknown = compareRecordedTaxProfiles(
      input([
        profile('p1', 1, [rule('r1', 'p1', { rate: null })]),
        profile('p2', 2, [rule('r2', 'p2', { rate: '0' })]),
      ])
    );
    expect(unknown.rows[0]?.before?.rate).toBeNull();
    expect(taxProfileReviewCsv(unknown)).toContain('"UNKNOWN","KNOWN"');
    const equal = compareRecordedTaxProfiles(
      input([
        profile('p1', 1, [rule('r1', 'p1', { rate: '0.100000' })]),
        profile('p2', 2, [rule('r2', 'p2', { rate: '0.1' })]),
      ])
    );
    expect(equal.rows).toHaveLength(0);
    expect(equal.before.rules[0]?.rate).toBe('0.100000');
  });
  it.each([
    { priceMode: 'UNKNOWN' },
    { productClass: 'OTHER' },
    { sroProvisional: 'true' },
    { sroReference: undefined },
    { rate: undefined },
    { rate: 0 },
    { rate: '1e-2' },
    { rate: 'NaN' },
    { pctHsCode: 'x'.repeat(2049) },
  ])('rejects malformed supplied rule%j without export', (bad) => {
    expect(
      prepareTaxProfileReview(
        input([profile('p1', 1, [rule('r1', 'p1', bad as never)]), profile('p2', 2, [])])
      ).kind
    ).toBe('error');
  });
  it('whitelists provenance metadata instead of spreading raw DTO fields', () => {
    const a = {
      ...profile('p1', 1, [{ ...rule('r1', 'p1'), rawPayload: 'MUST_NOT_LEAK' }]),
      rawPayload: 'MUST_NOT_LEAK',
    };
    const result = prepareTaxProfileReview(input([a, profile('p2', 2, [])]));
    expect(JSON.stringify(result)).not.toContain('MUST_NOT_LEAK');
  });
  it.each(['\u200b=cmd', '\ufeff@cmd', '\u202e+cmd', ' \t-cmd'])(
    'escapes Unicode-prefix formula%s',
    (attack) => {
      const result = prepareTaxProfileReview(
        input([profile('p1', 1, [rule('r1', 'p1', { pctHsCode: attack })]), profile('p2', 2, [])])
      );
      expect(result.kind).toBe('ready');
      if (result.kind === 'ready') expect(result.csv).toMatch(/"' +[=+@-]cmd"/);
    }
  );
  it('rejects forged export evidence and oversized metadata before artifact construction', () => {
    const review = compareRecordedTaxProfiles(input([profile('p1', 1, []), profile('p2', 2, [])]));
    expect(() => taxProfileReviewCsv({ ...review, coverage: 'COMPLETE' } as never)).toThrow(
      TaxProfileReviewError
    );
    expect(
      prepareTaxProfileReview(
        input([profile('p1', 1, [], { name: 'x'.repeat(2049) }), profile('p2', 2, [])])
      ).kind
    ).toBe('error');
  });
});

describe('artifact shape and bounded CSV', () => {
  const input = (profiles: readonly RecordedTaxProfile[]) => ({
    scope,
    profiles,
    beforeProfileId: 'p1',
    afterProfileId: 'p2',
  });
  it('CSV identity/metadata/rule rows have the same32 columns and explicit scope', () => {
    const review = compareRecordedTaxProfiles(
      input([profile('p1', 1, []), profile('p2', 2, [rule('r2', 'p2')])])
    );
    const csv = taxProfileReviewCsv(review);
    for (const line of csv.split('\r\n')) expect(line.split(',')).toHaveLength(32);
    expect(csv).toContain('"organization_id","branch_id"');
    expect(csv).toContain('"org-1","branch-1"');
    expect(new TextEncoder().encode(csv).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
  it('recomputes rows from validated profiles and never serializes injected raw payload', () => {
    const review = compareRecordedTaxProfiles(input([profile('p1', 1, []), profile('p2', 2, [])]));
    const forged = { ...review, rows: [{ rawPayload: 'NO_LEAK' }] } as unknown as typeof review;
    expect(taxProfileReviewCsv(forged)).not.toContain('NO_LEAK');
  });
  it('refuses conservative CSV allocation budget before serialization', () => {
    const large = (id: string) =>
      profile(
        id,
        id === 'p1' ? 1 : 2,
        Array.from({ length: 100 }, (_, i) =>
          rule(`${id}-${i}`, id, {
            pctHsCode: `${id}-${i}-` + 'x'.repeat(2000),
            sroReference: 'y'.repeat(2000),
            exemptionCode: 'z'.repeat(2000),
          })
        )
      );
    const longScope = { organizationId: 'o'.repeat(2048), branchId: 'b'.repeat(2048) };
    const profiles = [large('p1'), large('p2')].map((p) => ({
      ...p,
      ...longScope,
      rules: p.rules.map((r) => ({ ...r, organizationId: longScope.organizationId })),
    }));
    expect(prepareTaxProfileReview({ ...input(profiles), scope: longScope })).toEqual({
      kind: 'error',
      csv: null,
    });
  });
});
