export const JOURNAL_EVIDENCE_PAGE_LIMIT = 25 as const;

type JournalLine = {
  readonly id: string;
  readonly accountCode: string;
  readonly side: string;
  readonly amountMinor: bigint | string | number;
  readonly lotId: string | null;
};

type JournalEntry = {
  readonly id: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly description: string;
  readonly currency: string;
  readonly occurredAt: Date | string;
  readonly reversesEntryId: string | null;
  readonly lines: readonly JournalLine[];
};

export type JournalEvidenceSource = {
  readonly from: Date | string;
  readonly to: Date | string;
  readonly page: number;
  readonly journalCount: number;
  readonly journal: readonly JournalEntry[];
};

export type JournalEvidenceRow = Readonly<{
  entryId: string;
  occurredAt: string;
  sourceKind: string;
  sourceId: string;
  reversesEntryId: string;
  description: string;
  lineId: string;
  accountCode: string;
  side: string;
  currency: string;
  amountMinor: string;
  signedMinor: string;
  lotId: string;
}>;

export type JournalEvidenceExport = Readonly<{
  from: string;
  to: string;
  page: number;
  journalCount: number;
  pageEntryCount: number;
  pageLimit: typeof JOURNAL_EVIDENCE_PAGE_LIMIT;
  coverage: 'page_bounded_partial' | 'entire_matching_window';
  rows: readonly JournalEvidenceRow[];
}>;

function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new TypeError('Journal evidence contains an invalid date.');
  return parsed.toISOString();
}

function exactMinor(value: bigint | string | number): string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('Journal evidence contains an invalid minor-unit value.');
  }
  const text = typeof value === 'string' ? value : value.toString();
  if (!/^\d+$/.test(text))
    throw new TypeError('Journal evidence contains an invalid minor-unit value.');
  return text;
}

/** Pure projection of the one authorized journal page; it never infers ledger completeness. */
export function projectJournalEvidence(source: JournalEvidenceSource): JournalEvidenceExport {
  const entries = [...source.journal].sort((left, right) => {
    const dateOrder = instant(right.occurredAt).localeCompare(instant(left.occurredAt));
    return dateOrder || right.id.localeCompare(left.id);
  });
  const rows = entries.flatMap((entry) =>
    [...entry.lines]
      .sort(
        (left, right) =>
          left.accountCode.localeCompare(right.accountCode) ||
          left.side.localeCompare(right.side) ||
          left.id.localeCompare(right.id)
      )
      .map((line) => {
        const amountMinor = exactMinor(line.amountMinor);
        return Object.freeze({
          entryId: entry.id,
          occurredAt: instant(entry.occurredAt),
          sourceKind: entry.sourceKind,
          sourceId: entry.sourceId,
          reversesEntryId: entry.reversesEntryId ?? '',
          description: entry.description,
          lineId: line.id,
          accountCode: line.accountCode,
          side: line.side,
          currency: entry.currency,
          amountMinor,
          signedMinor: line.side === 'CREDIT' ? `-${amountMinor}` : amountMinor,
          lotId: line.lotId ?? '',
        });
      })
  );
  return Object.freeze({
    from: instant(source.from),
    to: instant(source.to),
    page: source.page,
    journalCount: source.journalCount,
    pageEntryCount: entries.length,
    pageLimit: JOURNAL_EVIDENCE_PAGE_LIMIT,
    coverage:
      source.journalCount > entries.length || source.page > 1
        ? 'page_bounded_partial'
        : 'entire_matching_window',
    rows: Object.freeze(rows),
  });
}

const columns = [
  'entryId',
  'occurredAt',
  'sourceKind',
  'sourceId',
  'reversesEntryId',
  'description',
  'lineId',
  'accountCode',
  'side',
  'currency',
  'amountMinor',
  'signedMinor',
  'lotId',
] as const satisfies readonly (keyof JournalEvidenceRow)[];

function csvCell(value: string): string {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  const protectedValue = /^\s*[=+\-@]/.test(withoutControls)
    ? `'${withoutControls}`
    : withoutControls;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

/** RFC-style quoted CSV with spreadsheet formula and control-character hardening. */
export function journalEvidenceCsv(report: JournalEvidenceExport): string {
  return [
    [csvCell('coverage'), csvCell(report.coverage)].join(','),
    [csvCell('journalCount'), csvCell(String(report.journalCount))].join(','),
    [csvCell('page'), csvCell(String(report.page))].join(','),
    [csvCell('pageEntryCount'), csvCell(String(report.pageEntryCount))].join(','),
    [csvCell('pageLimit'), csvCell(String(report.pageLimit))].join(','),
    [csvCell('from'), csvCell(report.from)].join(','),
    [csvCell('toExclusive'), csvCell(report.to)].join(','),
    '',
    columns.map(csvCell).join(','),
    ...report.rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
  ].join('\r\n');
}
