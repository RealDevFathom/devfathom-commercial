import { formatMinor } from '@/lib/pharmacy/counter-receipt';

/**
 * CSV export for the pharmacy Reports screens. Builders are pure: the caller supplies the same
 * report payload the screen renders, so the file carries exactly what the current filters show.
 * Totals are computed by the helpers below, which the screens also use for their totals rows.
 */

export const PHARMACY_REPORT_EXPORTS = ['period-summary', 'branch-comparison', 'expiry'] as const;
export type PharmacyReportExport = (typeof PHARMACY_REPORT_EXPORTS)[number];

/** Money cell: integer minor units, or null when the source is unavailable. */
export type CsvMoney = { readonly minor: number | null | undefined };
export type CsvValue = string | number | boolean | null | undefined | CsvMoney;

const isMoney = (value: CsvValue): value is CsvMoney =>
  typeof value === 'object' && value !== null && 'minor' in value;

/**
 * Spreadsheet formula guard: text that a spreadsheet could evaluate (leading = + - @, or a
 * leading tab/carriage return) is prefixed with an apostrophe so it stays literal text.
 */
export function neutralizeCsvFormula(text: string): string {
  return /^[\t\r]|^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * One CSV field. Free text is formula-neutralised and quoted when needed. Numbers and money are
 * emitted only from safe integers, so a negative amount such as -12.50 stays numeric.
 */
export function csvField(value: CsvValue): string {
  if (value == null) return '';
  if (isMoney(value)) {
    return value.minor != null && Number.isSafeInteger(value.minor) ? formatMinor(value.minor) : '';
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return quote(neutralizeCsvFormula(value));
}

export function csvLine(values: readonly CsvValue[]): string {
  return values.map(csvField).join(',');
}

/** Strict money total: unavailable (null) if any input is unavailable or the sum is unsafe. */
export function sumMinorStrict(values: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value == null || !Number.isSafeInteger(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/** Sum of recorded values only; null when nothing was recorded (the lost-demand estimate rule). */
export function sumMinorRecorded(values: readonly (number | null | undefined)[]): number | null {
  const recorded = values.filter((value): value is number => value != null);
  return recorded.length ? sumMinorStrict(recorded) : null;
}

export type ReportCsvContext = {
  currency: string | null;
  from: string;
  to: string;
  branchScope: string;
  generatedAt: Date;
};

export const currencyLabel = (currency: string | null) => currency ?? 'currency unknown';

function reportDocument(
  title: string,
  context: ReportCsvContext,
  notes: readonly string[],
  header: readonly string[],
  rows: readonly (readonly CsvValue[])[],
  totals: readonly CsvValue[] | null
) {
  const lines = [
    csvLine(['Report', title]),
    csvLine([
      'Currency',
      context.currency
        ? `${context.currency} (current organization setting; historical transaction currency is not verified)`
        : 'Currency unknown (no authoritative organization currency is available)',
    ]),
    csvLine(['Date range', `${context.from} to ${context.to} (inclusive business dates)`]),
    csvLine(['Branch scope', context.branchScope]),
    csvLine(['Generated at', context.generatedAt.toISOString()]),
    csvLine([
      'Amounts',
      'Minor-unit values shown to two decimal places. Blank means unavailable, not zero.',
    ]),
    ...notes.map((note) => csvLine(['Note', note])),
    '',
    csvLine(header),
    ...rows.map(csvLine),
    ...(totals ? [csvLine(totals)] : []),
  ];
  // BOM keeps non-Latin medicine and branch names readable in spreadsheet apps.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Period summary ("Selected period at a glance")
// ---------------------------------------------------------------------------

export type PeriodSummaryMetrics = {
  salesMinor: number | null;
  marginMinor: number | null;
  cashMinor: number | null;
  cashVarianceMinor: number | null;
  refundsMinor: number | null;
  openStockSignals: number;
  recommendedOrders: number;
  expiryValueMinor30: number | null;
  expiryValueMinor90: number | null;
  safetyQueue: number;
};

export type PeriodSummaryRow = {
  label: string;
  kind: 'money' | 'count';
  value: number | null;
  basis: string;
};

/** The figures shown on the "Selected period at a glance" card, in screen order. */
export function periodSummaryRows(
  metrics: PeriodSummaryMetrics,
  branchSelected: boolean
): PeriodSummaryRow[] {
  const basis = branchSelected
    ? 'Selected branch · ledger source'
    : 'All available branches · ledger source';
  const money = (label: string, value: number | null): PeriodSummaryRow => ({
    label,
    kind: 'money',
    value,
    basis,
  });
  const count = (label: string, value: number): PeriodSummaryRow => ({
    label,
    kind: 'count',
    value,
    basis,
  });
  return [
    money('Sales', metrics.salesMinor),
    money('Gross margin', metrics.marginMinor),
    money('Cash', metrics.cashMinor),
    money('Cash variance', metrics.cashVarianceMinor),
    money('Refunds', metrics.refundsMinor),
    count('Open stock signals', metrics.openStockSignals),
    count('Recommended orders', metrics.recommendedOrders),
    money('Expiry ≤30d', metrics.expiryValueMinor30),
    money('Expiry ≤90d', metrics.expiryValueMinor90),
  ];
}

export function periodSummaryCsv(
  metrics: PeriodSummaryMetrics,
  context: ReportCsvContext & { branchSelected: boolean }
) {
  const rows = [
    ...periodSummaryRows(metrics, context.branchSelected),
    {
      label: 'Organization-wide safety queue',
      kind: 'count' as const,
      value: metrics.safetyQueue,
      basis: 'Current snapshot · organization-wide',
    },
  ];
  return reportDocument(
    'Pharmacy period summary',
    context,
    [
      'Each figure is a period or snapshot total, matching the Selected period at a glance card.',
      'Sales, gross margin, cash, cash variance and refunds cover the selected period. Stock signals, recommended orders and expiry exposure are current snapshots; expiry exposure is not realized loss.',
    ],
    ['Metric', `Value (${currencyLabel(context.currency)} for amounts)`, 'Basis'],
    rows.map((row) => [
      row.label,
      row.kind === 'money' ? { minor: row.value } : row.value,
      row.basis,
    ]),
    null
  );
}

// ---------------------------------------------------------------------------
// Branch comparison
// ---------------------------------------------------------------------------

export type BranchComparisonRow = {
  branchId: string;
  branchName: string;
  salesMinor: number | null;
  marginMinor: number | null;
  lostDemandEstimateMinor: number | null;
  lostDemandRecordedEvents: number;
  expiryAtRiskMinor: number | null;
  khataAgingMinor: number | null;
};

export function branchComparisonTotals(rows: readonly BranchComparisonRow[]) {
  return {
    salesMinor: sumMinorStrict(rows.map((row) => row.salesMinor)),
    marginMinor: sumMinorStrict(rows.map((row) => row.marginMinor)),
    lostDemandEstimateMinor: sumMinorRecorded(rows.map((row) => row.lostDemandEstimateMinor)),
    lostDemandRecordedEvents: rows.reduce((sum, row) => sum + row.lostDemandRecordedEvents, 0),
    expiryAtRiskMinor: sumMinorStrict(rows.map((row) => row.expiryAtRiskMinor)),
    khataAgingMinor: sumMinorStrict(rows.map((row) => row.khataAgingMinor)),
  };
}

export function branchComparisonCsv(
  comparison: { rows: readonly BranchComparisonRow[]; estimateMethod: string },
  context: ReportCsvContext
) {
  const unit = currencyLabel(context.currency);
  const totals = branchComparisonTotals(comparison.rows);
  return reportDocument(
    'Pharmacy branch comparison',
    context,
    [
      'Expiry at risk is available stock expiring in 30 days and is not realized loss.',
      `Lost demand is an estimate: ${comparison.estimateMethod}`,
    ],
    [
      'Branch',
      `Sales (${unit})`,
      `Margin (${unit})`,
      `Lost demand estimate (${unit})`,
      'Lost demand events',
      `Expiry at risk (${unit})`,
      `Khata overdue (${unit})`,
    ],
    comparison.rows.map((row) => [
      row.branchName,
      { minor: row.salesMinor },
      { minor: row.marginMinor },
      { minor: row.lostDemandEstimateMinor },
      row.lostDemandRecordedEvents,
      { minor: row.expiryAtRiskMinor },
      { minor: row.khataAgingMinor },
    ]),
    [
      'Total',
      { minor: totals.salesMinor },
      { minor: totals.marginMinor },
      { minor: totals.lostDemandEstimateMinor },
      totals.lostDemandRecordedEvents,
      { minor: totals.expiryAtRiskMinor },
      { minor: totals.khataAgingMinor },
    ]
  );
}

// ---------------------------------------------------------------------------
// Expiry and supplier-return advisor
// ---------------------------------------------------------------------------

export type ExpiryCsvRow = {
  branchId: string;
  medicineName: string;
  batchNumber: string;
  supplierName: string;
  classification: string;
  coldChain: boolean;
  onHandUnits: number;
  valueAtRiskMinor: number;
  expiresAt: Date;
};

export function expiryAdviceTotals(rows: readonly ExpiryCsvRow[]) {
  return {
    onHandUnits: rows.reduce((sum, row) => sum + row.onHandUnits, 0),
    valueAtRiskMinor: sumMinorStrict(rows.map((row) => row.valueAtRiskMinor)),
  };
}

export function expiryAdviceCsv(
  rows: readonly ExpiryCsvRow[],
  branches: readonly { id: string; name: string }[],
  context: ReportCsvContext
) {
  const unit = currencyLabel(context.currency);
  const branchName = (id: string) => branches.find((branch) => branch.id === id)?.name ?? id;
  const totals = expiryAdviceTotals(rows);
  return reportDocument(
    'Pharmacy expiry and supplier-return advisor',
    context,
    [
      'Current snapshot of future-expiry lots with available stock in the branch scope; the date range does not filter lots.',
      'Advisory only: value at risk is projected stock value left at expiry, not realized loss.',
    ],
    [
      'Medicine',
      'Batch',
      'Branch',
      'Supplier',
      'Classification',
      'Cold chain',
      'Expires on',
      'On hand (units)',
      `Value at risk (${unit})`,
    ],
    rows.map((row) => [
      row.medicineName,
      row.batchNumber,
      branchName(row.branchId),
      row.supplierName,
      row.classification.replaceAll('_', ' '),
      row.coldChain,
      row.expiresAt.toISOString().slice(0, 10),
      row.onHandUnits,
      { minor: row.valueAtRiskMinor },
    ]),
    ['Total', '', '', '', '', '', '', totals.onHandUnits, { minor: totals.valueAtRiskMinor }]
  );
}
