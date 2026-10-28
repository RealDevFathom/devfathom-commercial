export const JOURNAL_EVIDENCE_PAGE_CAP = 25;

export type JournalEvidenceEntry = {
  id: string;
  sourceKind: string;
  sourceId: string;
  description: string;
  currency: string;
  occurredAt: Date | string;
  reversesEntryId: string | null;
  lines: Array<{
    id: string;
    accountCode: string;
    side: string;
    amountMinor: bigint | string;
    lotId: string | null;
  }>;
};

export type JournalEvidencePage = {
  from: Date | string;
  to: Date | string;
  page: number;
  journalCount: number;
  journal: JournalEvidenceEntry[];
};

export type JournalEvidenceCoverage = {
  page: number;
  pageCap: number;
  rowsOnPage: number;
  totalEntryCount: number;
  pageCoverage: 'partial' | 'page-complete';
  ledgerCoverage: 'coverage-unknown';
};

export function journalEvidenceCoverage(input: JournalEvidencePage): JournalEvidenceCoverage {
  return {
    page: input.page,
    pageCap: JOURNAL_EVIDENCE_PAGE_CAP,
    rowsOnPage: input.journal.length,
    totalEntryCount: input.journalCount,
    pageCoverage:
      input.page > 1 || input.journalCount > input.journal.length ? 'partial' : 'page-complete',
    // The existing reader describes posted entries, not complete real-world ledger activity.
    ledgerCoverage: 'coverage-unknown',
  };
}

function iso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

/** Quote every field, remove record-breaking controls, and neutralize spreadsheet formulas. */
function csvCell(value: unknown) {
  const normalized = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  const safe = /^\s*[=+\-@]/u.test(normalized) ? `'${normalized}` : normalized;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function journalEvidenceCsv(input: JournalEvidencePage) {
  const coverage = journalEvidenceCoverage(input);
  const header = [
    'page',
    'page_cap',
    'entries_on_page',
    'total_entry_count',
    'page_coverage',
    'ledger_coverage',
    'from_inclusive_utc',
    'to_exclusive_utc',
    'entry_id',
    'occurred_at_utc',
    'source_kind',
    'source_id',
    'description',
    'currency',
    'reverses_entry_id',
    'line_id',
    'line_order',
    'account_code',
    'side',
    'amount_minor',
    'lot_id',
  ];
  const metadata = [
    coverage.page,
    coverage.pageCap,
    coverage.rowsOnPage,
    coverage.totalEntryCount,
    coverage.pageCoverage,
    coverage.ledgerCoverage,
    iso(input.from),
    iso(input.to),
  ];
  const entries = [...input.journal].sort(
    (a, b) => iso(b.occurredAt).localeCompare(iso(a.occurredAt)) || b.id.localeCompare(a.id)
  );
  const rows = entries.flatMap((entry) => {
    const lines = [...entry.lines].sort((a, b) => a.id.localeCompare(b.id));
    const entryFields = [
      entry.id,
      iso(entry.occurredAt),
      entry.sourceKind,
      entry.sourceId,
      entry.description,
      entry.currency,
      entry.reversesEntryId ?? '',
    ];
    if (!lines.length) return [[...metadata, ...entryFields, '', '', '', '', '', '']];
    return lines.map((line, index) => [
      ...metadata,
      ...entryFields,
      line.id,
      index + 1,
      line.accountCode,
      line.side,
      String(line.amountMinor),
      line.lotId ?? '',
    ]);
  });
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
