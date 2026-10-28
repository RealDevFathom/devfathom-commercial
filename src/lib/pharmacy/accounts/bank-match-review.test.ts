import { describe, expect, it } from 'vitest';
import {
  BANK_MATCH_REVIEW_FILENAME,
  BANK_MATCH_REVIEW_LIMITATIONS,
  exportBankMatchReviewCsv,
  reviewSuppliedBankMatches,
  type BankMatchReviewInput,
  type SuppliedBankLine,
} from './bank-match-review';

const scope = Object.freeze({ organizationId: 'org-1', branchId: 'branch-1' });
function line(overrides: Partial<SuppliedBankLine> = {}): SuppliedBankLine {
  return {
    id: 'line-1',
    parentTransactionId: 'txn-1',
    scope,
    provenance: { kind: 'SUPPLIED', sourceId: 'fixture' },
    amountMinor: -10_000,
    status: 'REVERSED',
    postedAt: '2026-10-25T08:00:00.000Z',
    matches: [
      {
        id: 'match-1',
        bankLineId: 'line-1',
        scope,
        provenance: { kind: 'SUPPLIED', sourceId: 'fixture' },
        amountMinor: 4_000,
        matchedAt: '2026-10-25T09:00:00Z',
        reversedAt: null,
        parentReference: { referenceId: 'ref-1', parentTransactionId: 'txn-1', verified: true },
      },
      {
        id: 'match-2',
        bankLineId: 'line-1',
        scope,
        provenance: { kind: 'SUPPLIED', sourceId: 'fixture' },
        amountMinor: 6_000,
        matchedAt: '2026-10-25T10:00:00Z',
        reversedAt: '2026-10-25T11:00:00Z',
        parentReference: { referenceId: 'ref-2', parentTransactionId: 'txn-1', verified: true },
      },
    ],
    ...overrides,
  };
}
const input = (lines: readonly SuppliedBankLine[] = [line()]): BankMatchReviewInput => ({
  scope,
  lines,
});

describe('reviewSuppliedBankMatches', () => {
  it('uses exact bigint reductions, retains reversals, and preserves the recorded status', () => {
    const result = reviewSuppliedBankMatches(input());
    expect(result.lines[0]).toMatchObject({
      signedAmountMinor: -10_000n,
      activeMatchedMinor: 4_000n,
      reversedMatchedMinor: 6_000n,
      residualMinor: 6_000n,
      originalStatus: 'REVERSED',
      matchCount: 2,
    });
    expect(result.limitations).toContain('unsupplied transactions do not exist');
  });

  it('accepts signed credit, debit, and consistent zero lines', () => {
    const lines = [
      line({ id: 'debit', matches: [] }),
      line({ id: 'credit', amountMinor: 10_000, matches: [] }),
      line({ id: 'zero', amountMinor: 0, matches: [], status: 'UNMATCHED' }),
    ];
    expect(reviewSuppliedBankMatches(input(lines)).lines.map((x) => x.residualMinor)).toEqual([
      10_000n,
      10_000n,
      0n,
    ]);
  });

  it('handles individually safe values whose aggregate is beyond Number precision', () => {
    const amount = Number.MAX_SAFE_INTEGER;
    const matches = [1, 2].map((n) => ({
      ...line().matches[0],
      id: `m${n}`,
      amountMinor: amount,
      parentReference: { ...line().matches[0].parentReference, referenceId: `r${n}` },
    }));
    const result = reviewSuppliedBankMatches(input([line({ amountMinor: -amount, matches })]))
      .lines[0];
    expect(result.activeMatchedMinor).toBe(BigInt(amount) * 2n);
    expect(result.overallocated).toBe(true);
    expect(result.residualMinor).toBeNull();
    expect(() =>
      exportBankMatchReviewCsv(input([line({ amountMinor: -amount, matches })]))
    ).toThrow('verified evidence');
  });

  it('enforces 0/50/51 line and 0/200/201 nested cardinalities before reduction', () => {
    expect(reviewSuppliedBankMatches(input([])).lines).toEqual([]);
    const lines = Array.from({ length: 50 }, (_, n) => line({ id: `l${n}`, matches: [] }));
    expect(reviewSuppliedBankMatches(input(lines)).lines).toHaveLength(50);
    expect(() =>
      reviewSuppliedBankMatches(input([...lines, line({ id: 'overflow', matches: [] })]))
    ).toThrow('50 lines');
    const matches = Array.from({ length: 201 }, (_, n) => ({
      ...line().matches[0],
      id: `m${n}`,
      parentReference: { ...line().matches[0].parentReference, referenceId: `r${n}` },
      get amountMinor(): number {
        if (n === 200) throw new Error('reduced');
        return 1;
      },
    }));
    expect(() => reviewSuppliedBankMatches(input([line({ matches })]))).toThrow('200 matches');
  });

  it.each([
    ['foreign organization', () => line({ scope: { ...scope, organizationId: 'other' } })],
    ['foreign branch', () => line({ scope: { ...scope, branchId: 'other' } })],
    [
      'foreign match parent',
      () => line({ matches: [{ ...line().matches[0], bankLineId: 'other' }] }),
    ],
    [
      'foreign reference',
      () =>
        line({
          matches: [
            {
              ...line().matches[0],
              parentReference: {
                ...line().matches[0].parentReference,
                parentTransactionId: 'other',
              },
            },
          ],
        }),
    ],
    ['unknown status', () => line({ status: 'PARTIAL' as never })],
    ['malformed timestamp', () => line({ postedAt: 'yesterday' })],
    ['unsafe amount', () => line({ amountMinor: Number.MAX_SAFE_INTEGER + 1 })],
    ['noninteger amount', () => line({ amountMinor: 1.5 })],
    ['nonpositive match', () => line({ matches: [{ ...line().matches[0], amountMinor: 0 }] })],
  ])('rejects %s', (_name, make) =>
    expect(() => reviewSuppliedBankMatches(input([make()]))).toThrow(TypeError)
  );

  it('rejects duplicate line, match, and reference identities', () => {
    expect(() => reviewSuppliedBankMatches(input([line(), line()]))).toThrow('duplicate line');
    expect(() =>
      reviewSuppliedBankMatches(input([line({ matches: [line().matches[0], line().matches[0]] })]))
    ).toThrow('duplicate match');
    const second = {
      ...line().matches[1],
      parentReference: { ...line().matches[1].parentReference, referenceId: 'ref-1' },
    };
    expect(() =>
      reviewSuppliedBankMatches(input([line({ matches: [line().matches[0], second] })]))
    ).toThrow('duplicate reference');
  });

  it('marks missing or explicitly unverified reference evidence unexportable', () => {
    for (const parentReference of [
      undefined,
      { referenceId: 'r', parentTransactionId: 'txn-1', verified: false },
    ]) {
      const supplied = input([
        line({ matches: [{ ...line().matches[0], parentReference } as never] }),
      ]);
      expect(reviewSuppliedBankMatches(supplied).lines[0]).toMatchObject({
        evidenceVerified: false,
        residualMinor: null,
      });
      expect(() => exportBankMatchReviewCsv(supplied)).toThrow('verified evidence');
    }
  });
});

describe('exportBankMatchReviewCsv', () => {
  it('emits deterministic LINE then MATCH bytes, including zero-match coverage', () => {
    const empty = exportBankMatchReviewCsv(input([])).text;
    expect(empty).toContain('COVERAGE,org-1,branch-1');
    expect(empty).toContain(BANK_MATCH_REVIEW_LIMITATIONS);
    const supplied = input([line({ matches: [] })]);
    const before = JSON.stringify(supplied);
    const first = exportBankMatchReviewCsv(supplied),
      second = exportBankMatchReviewCsv(supplied);
    expect(first.filename).toBe(BANK_MATCH_REVIEW_FILENAME);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.text.split('\n')[1]).toContain('LINE,org-1,branch-1,line-1');
    expect(first.text).toContain(`,0,true,"${BANK_MATCH_REVIEW_LIMITATIONS}"`);
    expect(JSON.stringify(supplied)).toBe(before);
  });

  it('escapes quotes/newlines and neutralizes formula prefixes hidden by controls/BOM/invisibles', () => {
    const starters = ['=x', ' \t+x', '\u0001-x', '\uFEFF@x', '\u200B=x'];
    for (const sourceId of starters) {
      const supplied = input([line({ parentTransactionId: sourceId, matches: [] })]);
      const csv = exportBankMatchReviewCsv(supplied).text;
      expect(csv).toContain(`'${sourceId}`);
    }
    expect(
      exportBankMatchReviewCsv(input([line({ parentTransactionId: 'a,"b\nc', matches: [] })])).text
    ).toContain('"a,""b\nc"');
    expect(exportBankMatchReviewCsv(input()).text).toContain(',-10000,4000,6000,6000,');
  });

  it('enforces the text byte cap and rejects over-cap artifacts without partial output', () => {
    expect(() => reviewSuppliedBankMatches(input([line({ id: 'é'.repeat(129) })]))).toThrow(
      '256 UTF-8 bytes'
    );
    const wide = 'x'.repeat(256);
    const lines = Array.from({ length: 50 }, (_, l) =>
      line({
        id: `l${l}`,
        amountMinor: -Number.MAX_SAFE_INTEGER,
        parentTransactionId: `${l}${wide.slice(3)}`,
        provenance: { kind: 'SUPPLIED', sourceId: wide },
        matches: Array.from({ length: 200 }, (_, m) => ({
          ...line().matches[0],
          id: `${l}-${m}-${wide.slice(10)}`,
          bankLineId: `l${l}`,
          provenance: { kind: 'SUPPLIED', sourceId: wide },
          parentReference: {
            referenceId: `${l}-${m}-r${wide.slice(12)}`,
            parentTransactionId: `${l}${wide.slice(3)}`,
            verified: true as const,
          },
        })),
      })
    );
    expect(() => exportBankMatchReviewCsv(input(lines))).toThrow('8 MiB');
  });
});
