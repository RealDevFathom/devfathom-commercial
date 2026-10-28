import { describe, expect, it } from 'vitest';
import {
  journalEvidenceCoverage,
  journalEvidenceCsv,
  type JournalEvidencePage,
} from './journal-evidence-export';

function page(): JournalEvidencePage {
  return {
    from: new Date('2026-10-01T00:00:00Z'),
    to: new Date('2026-10-26T00:00:00Z'),
    page: 1,
    journalCount: 26,
    journal: [
      {
        id: 'entry-1',
        occurredAt: new Date('2026-10-25T12:00:00Z'),
        sourceKind: 'SALE',
        sourceId: '=source\nnext',
        description: 'Quoted "description", with comma',
        currency: 'PKR',
        reversesEntryId: 'entry-original',
        lines: [
          {
            id: 'line-b',
            accountCode: '+CASH',
            side: 'DEBIT',
            amountMinor: '900719925474099301',
            lotId: null,
          },
          { id: 'line-a', accountCode: 'SALES', side: 'CREDIT', amountMinor: 10n, lotId: '@lot' },
        ],
      },
    ],
  };
}

describe('journal evidence page CSV', () => {
  it('marks count 26 with a bounded page as partial and coverage unknown', () => {
    const input = page();
    input.journal = Array.from({ length: 25 }, (_, index) => ({
      ...input.journal[0]!,
      id: `entry-${index}`,
      lines: [],
    }));
    expect(journalEvidenceCoverage(input)).toMatchObject({
      pageCap: 25,
      rowsOnPage: 25,
      totalEntryCount: 26,
      pageCoverage: 'partial',
      ledgerCoverage: 'coverage-unknown',
    });
  });

  it('preserves identifiers, currency and exact minor-unit strings in deterministic line order', () => {
    const csv = journalEvidenceCsv(page());
    expect(csv).toContain('"PKR","entry-original","line-a","1","SALES","CREDIT","10","\'@lot"');
    expect(csv).toContain('"line-b","2","\'+CASH","DEBIT","900719925474099301"');
    expect(csv).toContain('"\'=source next"');
    expect(csv).toContain('"Quoted ""description"", with comma"');
    expect(csv.indexOf('line-a')).toBeLessThan(csv.indexOf('line-b'));
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(4);
  });
});
