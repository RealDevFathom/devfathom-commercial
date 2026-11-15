import { describe, expect, it } from 'vitest';
import {
  BANK_MATCH_LINE_SOURCE,
  BANK_MATCH_MATCH_SOURCE,
  BANK_MATCH_REVIEW_CSV_FILENAME,
  BANK_MATCH_REVIEW_LIMITATIONS,
  BANK_MATCH_REVIEW_LIMITS,
  reviewSuppliedBankMatches,
  suppliedBankMatchReviewCsv,
  type BankMatchDto,
  type BankMatchLineDto,
  type BankMatchReview,
  type BankMatchReviewInput,
} from './bank-match-review';

const match = (
  id: string,
  lineId: string,
  overrides: Partial<BankMatchDto> = {}
): BankMatchDto => ({
  source: BANK_MATCH_MATCH_SOURCE,
  id,
  organizationId: 'org',
  statementLineId: lineId,
  transactionId: `tx-${id}`,
  settlementBatchId: null,
  amountMinor: 100,
  reversedAt: null,
  parent: {
    status: 'RESOLVED',
    kind: 'TRANSACTION',
    id: `tx-${id}`,
    organizationId: 'org',
    branchId: 'branch',
    reference: `REF-${id}`,
  },
  ...overrides,
});

const line = (id: string, overrides: Partial<BankMatchLineDto> = {}): BankMatchLineDto => ({
  source: BANK_MATCH_LINE_SOURCE,
  id,
  organizationId: 'org',
  branchId: 'branch',
  statementRef: 'STMT-1',
  lineReference: `L-${id}`,
  amountMinor: -10000,
  status: 'UNMATCHED',
  matches: [],
  ...overrides,
});

const review = (lines: BankMatchLineDto[]) =>
  reviewSuppliedBankMatches({ organizationId: 'org', branchId: 'branch', lines });

const manyMatches = (lineId: string, count: number, overrides: Partial<BankMatchDto> = {}) =>
  Array.from({ length: count }, (_, index) => match(`${lineId}-m${index}`, lineId, overrides));

const parseCsv = (csv: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && csv[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += char;
  }
  return rows;
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

describe('supplied bank match review', () => {
  it('keeps a reversed match visible but out of the active sum and preserves REVERSED status', () => {
    const result = review([
      line('a', {
        status: 'REVERSED',
        matches: [
          match('m1', 'a', { amountMinor: 4000 }),
          match('m2', 'a', { amountMinor: 6000, reversedAt: '2026-10-01T00:00:00Z' }),
        ],
      }),
    ]);
    expect(result.lines[0]).toMatchObject({
      status: 'REVERSED',
      amountMinor: '-10000',
      activeMatchedMinor: '4000',
      reversedMatchedMinor: '6000',
      residualAbsMinor: '6000',
      diagnostic: 'RESIDUAL',
    });
    expect(result.lines[0].matches.map((m) => m.state)).toEqual(['ACTIVE', 'REVERSED']);
    const rows = parseCsv(suppliedBankMatchReviewCsv(result).content);
    expect(rows[0]).toContain('residualAbsMinor');
    expect(rows.slice(1).map((r) => r[0])).toEqual(['LINE', 'MATCH', 'MATCH']);
    expect(rows[1].slice(6, 12)).toEqual([
      'REVERSED',
      '-10000',
      '4000',
      '6000',
      '6000',
      'RESIDUAL',
    ]);
    expect(rows[3].slice(12, 15)).toEqual(['m2', 'REVERSED', '6000']);
  });

  it('keeps zero-amount and zero-match lines, and marks balanced lines', () => {
    const result = review([
      line('z', { amountMinor: 0 }),
      line('b', {
        amountMinor: 500,
        status: 'MATCHED',
        matches: [match('m', 'b', { amountMinor: 500 })],
      }),
    ]);
    const byId = Object.fromEntries(result.lines.map((l) => [l.id, l]));
    expect(byId.z).toMatchObject({ diagnostic: 'NO_MATCHES', residualAbsMinor: '0' });
    expect(byId.b).toMatchObject({ diagnostic: 'BALANCED', residualAbsMinor: '0' });
    const rows = parseCsv(suppliedBankMatchReviewCsv(result).content);
    expect(rows.filter((r) => r[0] === 'LINE')).toHaveLength(2);
  });

  it('accepts 0, 50 lines and 200 matches, and rejects 51 lines or 201 matches before reduction', () => {
    const empty = review([]);
    const csv = suppliedBankMatchReviewCsv(empty);
    expect(csv.filename).toBe(BANK_MATCH_REVIEW_CSV_FILENAME);
    const rows = parseCsv(csv.content);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe('COVERAGE');
    expect(rows[1].at(-1)).toBe(BANK_MATCH_REVIEW_LIMITATIONS);

    const fifty = Array.from({ length: 50 }, (_, i) => line(`l${i}`));
    expect(review(fifty).lines).toHaveLength(50);
    // The 51st line is invalid too; the cap must be reported, not the content error.
    expect(() => review([...fifty, line('x', { status: 'BOGUS' })])).toThrow(
      /more than 50 bank lines/
    );

    const full = line('f', { amountMinor: -1_000_000, matches: manyMatches('f', 200) });
    expect(review([full]).lines[0].matches).toHaveLength(200);
    const over = line('o', {
      matches: [...manyMatches('o', 200), match('bad', 'other', { amountMinor: -1 })],
    });
    expect(() => review([over])).toThrow(/more than 200 matches/);
  });

  it('rejects unsafe, non-integral and sign-invalid amounts', () => {
    expect(() => review([line('a', { amountMinor: Number.MAX_SAFE_INTEGER + 1 })])).toThrow(
      /safe integer/
    );
    expect(() => review([line('a', { amountMinor: 1.5 })])).toThrow(/safe integer/);
    expect(() => review([line('a', { amountMinor: Number.NaN })])).toThrow(/safe integer/);
    for (const amountMinor of [0, -5, 2.5, 2 ** 60]) {
      expect(() => review([line('a', { matches: [match('m', 'a', { amountMinor })] })])).toThrow();
    }
  });

  it('sums exactly beyond Number precision with individually safe values', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const result = review([
      line('a', {
        amountMinor: -max,
        matches: [
          match('m1', 'a', { amountMinor: max }),
          match('m2', 'a', { amountMinor: max, reversedAt: new Date('2026-01-01T00:00:00Z') }),
          match('m3', 'a', { amountMinor: max, reversedAt: '2026-01-02T00:00:00Z' }),
        ],
      }),
    ]);
    expect(result.lines[0].reversedMatchedMinor).toBe((BigInt(max) * BigInt(2)).toString());
    expect(result.lines[0].residualAbsMinor).toBe('0');
  });

  it('flags over-allocation as diagnostic only and refuses evidence export', () => {
    const result = review([
      line('a', { amountMinor: -100, matches: [match('m', 'a', { amountMinor: 101 })] }),
    ]);
    expect(result.lines[0]).toMatchObject({ diagnostic: 'OVERALLOCATED', residualAbsMinor: null });
    expect(() => suppliedBankMatchReviewCsv(result)).toThrow(/no evidence export/);
  });

  it('reports an unsampled parent as unknown and refuses evidence export', () => {
    const result = review([
      line('a', { matches: [match('m', 'a', { parent: { status: 'NOT_SAMPLED' } })] }),
    ]);
    expect(result.lines[0].matches[0]).toMatchObject({
      parentEvidence: 'UNKNOWN',
      parentReference: null,
    });
    expect(() => suppliedBankMatchReviewCsv(result)).toThrow(/no evidence export/);
  });

  it('rejects scope, provenance, parent and reference mismatches', () => {
    const bad: Array<Partial<BankMatchLineDto> | ((l: BankMatchLineDto) => BankMatchLineDto)> = [
      { organizationId: 'other' },
      { branchId: 'other' },
      { source: 'somewhere' as never },
      { status: 'PARTIAL' },
      { statementRef: '' },
    ];
    for (const overrides of bad) expect(() => review([line('a', overrides as never)])).toThrow();
    const badMatches: Partial<BankMatchDto>[] = [
      { organizationId: 'other' },
      { statementLineId: 'other' },
      { source: 'x' as never },
      { transactionId: null },
      { settlementBatchId: 'batch' },
      { reversedAt: 'not-a-date' },
      { parent: undefined as never },
      { parent: { status: 'MAYBE' } as never },
      { parent: { ...(match('m', 'a').parent as object), organizationId: 'other' } as never },
      { parent: { ...(match('m', 'a').parent as object), branchId: 'other' } as never },
      { parent: { ...(match('m', 'a').parent as object), id: 'tx-other' } as never },
      { parent: { ...(match('m', 'a').parent as object), kind: 'SETTLEMENT_BATCH' } as never },
      { parent: { ...(match('m', 'a').parent as object), reference: '' } as never },
    ];
    for (const overrides of badMatches)
      expect(() => review([line('a', { matches: [match('m', 'a', overrides)] })])).toThrow();
    expect(() =>
      reviewSuppliedBankMatches({ organizationId: '', branchId: 'branch', lines: [] })
    ).toThrow();
  });

  it('accepts settlement-batch parents', () => {
    const result = review([
      line('a', {
        matches: [
          match('m', 'a', {
            transactionId: null,
            settlementBatchId: 'sb',
            parent: {
              status: 'RESOLVED',
              kind: 'SETTLEMENT_BATCH',
              id: 'sb',
              organizationId: 'org',
              branchId: 'branch',
              reference: 'SB-1',
            },
          }),
        ],
      }),
    ]);
    expect(result.lines[0].matches[0]).toMatchObject({
      parentKind: 'SETTLEMENT_BATCH',
      parentReference: 'SB-1',
    });
  });

  it('rejects duplicate line, statement and match identities', () => {
    expect(() => review([line('a'), line('a', { lineReference: 'other' })])).toThrow(/duplicate/);
    expect(() => review([line('a'), line('b', { lineReference: 'L-a' })])).toThrow(/duplicate/);
    expect(() =>
      review([
        line('a', { matches: [match('m', 'a'), match('m', 'a', { transactionId: 'tx-2' })] }),
      ])
    ).toThrow(/duplicate/);
    expect(() =>
      review([line('a', { matches: [match('m', 'a')] }), line('b', { matches: [match('m', 'b')] })])
    ).toThrow(/duplicate/);
    const twin = match('n', 'a', { transactionId: 'tx-m', parent: match('m', 'a').parent });
    expect(() => review([line('a', { matches: [match('m', 'a'), twin] })])).toThrow(/duplicate/);
  });

  it('enforces the 256-byte text field limit in UTF-8 bytes', () => {
    expect(review([line('a', { statementRef: 'x'.repeat(256) })]).lines).toHaveLength(1);
    expect(() => review([line('a', { statementRef: 'x'.repeat(257) })])).toThrow(/256 UTF-8 bytes/);
    // 86 × 3-byte characters = 258 bytes but only 86 UTF-16 units.
    expect(() => review([line('a', { statementRef: '\u20AC'.repeat(86) })])).toThrow(
      /256 UTF-8 bytes/
    );
  });

  it('neutralises formula, control, BOM and Unicode-prefix injection and escapes quotes/commas/newlines', () => {
    const refs = [
      '=HYPERLINK("x")',
      '\uFEFF+1',
      ' @cmd',
      '\u202E-2',
      '\uFF1Dfull',
      'a,"b"\nc',
      'ok\u0007',
    ];
    const result = review(refs.map((statementRef, i) => line(`l${i}`, { statementRef })));
    const { content } = suppliedBankMatchReviewCsv(result);
    expect(content).not.toMatch(/[\uFEFF\u202E\u0007]/);
    const cells = parseCsv(content)
      .slice(1)
      .map((r) => r[4]);
    expect(cells).toEqual(
      expect.arrayContaining([
        `'=HYPERLINK("x")`,
        `'+1`,
        `' @cmd`,
        `'-2`,
        `'\uFF1Dfull`,
        'a,"b"\nc',
        'ok',
      ])
    );
    // Signed amounts are generated decimals and stay numeric.
    expect(parseCsv(content)[1][7]).toBe('-10000');
  });

  it('rejects an artifact above the byte cap and row counts above the cap with no partial output', () => {
    const long = (prefix: string) => prefix + 'x'.repeat(256 - prefix.length);
    const lines = Array.from({ length: 50 }, (_, i) => {
      const id = long(`line-${i}-`);
      return line(id, {
        statementRef: long(`s-${i}-`),
        lineReference: long(`r-${i}-`),
        amountMinor: -1_000_000,
        matches: Array.from({ length: 200 }, (_, j) => {
          const mid = long(`m-${i}-${j}-`);
          const tx = long(`t-${i}-${j}-`);
          return match(mid, id, {
            transactionId: tx,
            amountMinor: 1,
            parent: {
              status: 'RESOLVED',
              kind: 'TRANSACTION',
              id: tx,
              organizationId: 'org',
              branchId: 'branch',
              reference: long('R'),
            },
          });
        }),
      });
    });
    const big = review(lines);
    expect(big.lines).toHaveLength(50);
    expect(() => suppliedBankMatchReviewCsv(big)).toThrow(/artifact byte cap/);

    const normal = review([line('a', { matches: manyMatches('a', 200, { amountMinor: 1 }) })]);
    const { content } = suppliedBankMatchReviewCsv(normal);
    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(
      BANK_MATCH_REVIEW_LIMITS.maxArtifactBytes
    );

    const forged: BankMatchReview = {
      ...normal,
      lines: Array.from({ length: 51 }, (_, i) => ({ ...normal.lines[0], id: `f${i}` })),
    };
    // 51 × 201 rows > 10 050.
    expect(() => suppliedBankMatchReviewCsv(forged)).toThrow(/row cap/);
    expect(() => suppliedBankMatchReviewCsv({ ...normal, limitations: '' })).toThrow(/limitations/);
  });

  it('is deterministic, never mutates frozen inputs, and exports no descriptions or actors', () => {
    const input: BankMatchReviewInput = deepFreeze({
      organizationId: 'org',
      branchId: 'branch',
      lines: [
        line('b', { statementRef: 'S2', matches: [match('z', 'b'), match('y', 'b')] }),
        line('a', { statementRef: 'S1' }),
      ],
    });
    const snapshot = JSON.stringify(input);
    const first = suppliedBankMatchReviewCsv(reviewSuppliedBankMatches(input)).content;
    const second = suppliedBankMatchReviewCsv(
      reviewSuppliedBankMatches({ ...input, lines: [...input.lines].reverse() })
    ).content;
    expect(first).toBe(second);
    expect(JSON.stringify(input)).toBe(snapshot);
    const rows = parseCsv(first);
    expect(rows.slice(1).map((r) => `${r[0]}:${r[3]}:${r[12]}`)).toEqual([
      'LINE:a:',
      'LINE:b:',
      'MATCH:b:y',
      'MATCH:b:z',
    ]);
    expect(rows[0].join(',')).not.toMatch(/description|customer|matchedBy|actor|reason/i);
  });

  it('imports no database, network, router or session modules', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      `${process.cwd()}/src/lib/pharmacy/accounts/bank-match-review.ts`,
      'utf8'
    );
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfetch\(|prisma|require\(/);
  });
});
