import { describe, expect, it } from 'vitest';
import { journalEvidenceCsv, projectJournalEvidence } from './journal-evidence-export';

const entry = (
  id: string,
  occurredAt: string,
  lineId: string,
  amountMinor: bigint | string | number
) => ({
  id,
  occurredAt: new Date(occurredAt),
  sourceKind: 'SALE',
  sourceId: `source-${id}`,
  description: `Description ${id}`,
  currency: id === 'b' ? 'USD' : 'PKR',
  reversesEntryId: id === 'b' ? 'original-1' : null,
  lines: [
    { id: `${lineId}-2`, accountCode: 'SALES', side: 'CREDIT', amountMinor, lotId: null },
    { id: `${lineId}-1`, accountCode: 'CASH', side: 'DEBIT', amountMinor, lotId: 'lot-1' },
  ],
});

describe('journal evidence projection', () => {
  it('labels a 25-entry page from 26 matching entries as partial', () => {
    const journal = Array.from({ length: 25 }, (_, index) =>
      entry(
        String(index).padStart(2, '0'),
        `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
        `l${index}`,
        BigInt(1)
      )
    );
    const result = projectJournalEvidence({
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-11-01T00:00:00Z'),
      page: 1,
      journalCount: 26,
      journal,
    });
    expect(result).toMatchObject({
      journalCount: 26,
      pageEntryCount: 25,
      pageLimit: 25,
      coverage: 'page_bounded_partial',
    });
  });

  it('orders entries and lines stably while preserving currencies, IDs, dates, and exact minor strings', () => {
    const huge = BigInt('9007199254740993123');
    const result = projectJournalEvidence({
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-31T00:00:00Z',
      page: 1,
      journalCount: 2,
      journal: [
        entry('a', '2026-10-01T00:00:00Z', 'first', BigInt(2)),
        entry('b', '2026-10-02T00:00:00Z', 'second', huge),
      ],
    });
    expect(result.rows.map((row) => `${row.entryId}:${row.accountCode}`)).toEqual([
      'b:CASH',
      'b:SALES',
      'a:CASH',
      'a:SALES',
    ]);
    expect(result.rows[0]).toMatchObject({
      sourceId: 'source-b',
      reversesEntryId: 'original-1',
      currency: 'USD',
      occurredAt: '2026-10-02T00:00:00.000Z',
      amountMinor: huge.toString(),
      signedMinor: huge.toString(),
    });
    expect(result.rows[1]!.signedMinor).toBe(`-${huge}`);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true);
  });

  it('quotes CSV and neutralizes formulas and control characters', () => {
    const source = entry('=cmd', '2026-10-01T00:00:00Z', 'line', BigInt(123));
    const result = projectJournalEvidence({
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-02T00:00:00Z',
      page: 1,
      journalCount: 1,
      journal: [{ ...source, description: '+SUM(1,2)\nprivate', sourceId: '@source"quoted' }],
    });
    const csv = journalEvidenceCsv(result);
    expect(csv).toContain('"coverage","entire_matching_window"');
    expect(csv).toContain('"pageLimit","25"');
    expect(csv).toContain('"\'=cmd"');
    expect(csv).toContain('"\'+SUM(1,2) private"');
    expect(csv).toContain('"\'@source""quoted"');
    expect(csv).not.toContain('\nprivate');
  });
});

describe('real journal reader number contract', () => {
  const project = (amountMinor: number | string | bigint) =>
    projectJournalEvidence({
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-02T00:00:00Z',
      page: 1,
      journalCount: 1,
      journal: [entry('numeric', '2026-10-01T00:00:00Z', 'number-line', amountMinor)],
    });
  it.each([0, 12345, 2147483647])('exports Prisma Int %s as exact strings', (amount) => {
    const report = project(amount);
    expect(report.rows[0]!.amountMinor).toBe(String(amount));
    expect(report.rows[0]!.signedMinor).toBe(String(amount));
    expect(report.rows[1]!.signedMinor).toBe(`-${amount}`);
    expect(journalEvidenceCsv(report)).toContain(`"${amount}"`);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects inexact or invalid numeric amount %s',
    (amount) => {
      expect(() => project(amount)).toThrow('invalid minor-unit');
    }
  );
  it('preserves strings beyond safe-number range without conversion', () => {
    expect(project('900719925474099312345').rows[0]!.amountMinor).toBe('900719925474099312345');
  });
});
