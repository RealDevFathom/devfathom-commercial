export const CHEQUE_MATURITY_COVERAGE =
  'Recent capped current-state read (up to 50 transactions); full coverage is unknown.' as const;

const KINDS = new Set([
  'SUPPLIER_PAYMENT',
  'CUSTOMER_RECEIPT',
  'EXPENSE',
  'PETTY_CASH',
  'BANK_DEPOSIT',
  'SETTLEMENT',
  'VOUCHER',
  'CHEQUE',
]);
const TRANSACTION_STATUSES = new Set(['PENDING', 'POSTED', 'REVERSED']);
const CHEQUE_STATUSES = new Set(['NONE', 'PDC', 'CLEARED', 'BOUNCED']);
const CURRENCIES = new Set(['PKR', 'USD']);

export type ChequeMaturityRow = Readonly<{
  reference: string;
  counterpartyName: string | null;
  chequeNumber: string | null;
  dueDate: string | null;
  amountMinor: string;
  currency: string;
  transactionStatus: 'PENDING' | 'POSTED' | 'REVERSED';
  chequeStatus: 'NONE' | 'PDC' | 'CLEARED' | 'BOUNCED';
  evidenceState: 'PENDING' | 'POSTED' | 'REVERSED' | 'PDC' | 'CLEARED' | 'BOUNCED';
}>;

export type ChequeMaturityReport = Readonly<{
  period: Readonly<{ from: string; to: string; bounds: '[from,to)'; timezone: 'UTC' }>;
  rows: readonly ChequeMaturityRow[];
  sourceCount: number;
  sourceCap: 50;
  coverage: typeof CHEQUE_MATURITY_COVERAGE;
}>;

type Scope = Readonly<{ organizationId: string; branchId: string }>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Unsafe transaction evidence.');
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) {
    throw new TypeError('Unsafe transaction evidence.');
  }
  return value;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 160) {
    throw new TypeError('Unsafe transaction evidence.');
  }
  return value;
}

function instant(value: unknown, optional = false): Date | null {
  if (optional && (value === null || value === undefined)) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : null;
  if (!date || !Number.isFinite(date.getTime()))
    throw new TypeError('Unsafe transaction evidence.');
  return date;
}

function dateOnly(value: string, name: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError(`Invalid ${name} date.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Invalid ${name} date.`);
  }
  return date;
}

export function chequeMaturityPeriod(from: string, to: string) {
  const start = dateOnly(from, 'from');
  const end = dateOnly(to, 'to');
  const duration = end.getTime() - start.getTime();
  if (duration <= 0 || duration > 92 * 86_400_000) {
    throw new RangeError('Choose a positive UTC period of at most 92 days.');
  }
  return Object.freeze({ from, to, start, end });
}

export function projectChequeMaturity(
  input: unknown,
  scope: Scope,
  periodInput: Readonly<{ from: string; to: string }>
): ChequeMaturityReport {
  if (!Array.isArray(input) || input.length > 50)
    throw new TypeError('Unsafe transaction evidence.');
  const period = chequeMaturityPeriod(periodInput.from, periodInput.to);
  const rows: ChequeMaturityRow[] = [];

  for (const value of input) {
    const item = record(value);
    if (
      item.organizationId !== scope.organizationId ||
      item.branchId !== scope.branchId ||
      !KINDS.has(String(item.kind)) ||
      !TRANSACTION_STATUSES.has(String(item.status)) ||
      !CHEQUE_STATUSES.has(String(item.chequeStatus)) ||
      !CURRENCIES.has(String(item.currency)) ||
      !Number.isSafeInteger(item.amountMinor) ||
      (item.amountMinor as number) < 0
    ) {
      throw new TypeError('Unsafe transaction evidence.');
    }
    // The workspace is intentionally a mixed, capped transaction read. Validate every DTO's
    // tenant and shape first, then project only recorded cheques without treating other kinds as
    // cheque evidence.
    if (item.kind !== 'CHEQUE') continue;
    const due = instant(item.chequeDueAt, true);
    const reversed = instant(item.reversedAt, true);
    instant(item.occurredAt);
    if (due && (due < period.start || due >= period.end)) continue;

    const transactionStatus = item.status as ChequeMaturityRow['transactionStatus'];
    const chequeStatus = item.chequeStatus as ChequeMaturityRow['chequeStatus'];
    const evidenceState =
      transactionStatus === 'REVERSED' || reversed
        ? 'REVERSED'
        : chequeStatus === 'NONE'
          ? transactionStatus
          : chequeStatus;
    rows.push(
      Object.freeze({
        reference: requiredText(item.reference),
        counterpartyName: optionalText(item.counterpartyName),
        chequeNumber: optionalText(item.chequeNumber),
        dueDate: due ? due.toISOString().slice(0, 10) : null,
        amountMinor: String(item.amountMinor),
        currency: String(item.currency),
        transactionStatus,
        chequeStatus,
        evidenceState,
      })
    );
  }

  rows.sort((left, right) => {
    if (left.dueDate === null)
      return right.dueDate === null ? left.reference.localeCompare(right.reference) : 1;
    if (right.dueDate === null) return -1;
    return (
      left.dueDate.localeCompare(right.dueDate) || left.reference.localeCompare(right.reference)
    );
  });
  return Object.freeze({
    period: Object.freeze({
      from: period.from,
      to: period.to,
      bounds: '[from,to)',
      timezone: 'UTC',
    }),
    rows: Object.freeze(rows),
    sourceCount: input.length,
    sourceCap: 50,
    coverage: CHEQUE_MATURITY_COVERAGE,
  });
}

function csvCell(value: string | null): string {
  let safe = (value ?? 'UNKNOWN').replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (/^\s*[=+\-@]/.test(safe)) safe = `'${safe}`;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function chequeMaturityCsv(report: ChequeMaturityReport): string {
  const header = [
    'Due date (UTC)',
    'Reference',
    'Cheque number',
    'Counterparty',
    'Amount minor',
    'Currency',
    'Transaction status',
    'Cheque status',
    'Evidence state',
    'Coverage',
  ];
  const lines = report.rows.map((row) =>
    [
      row.dueDate,
      row.reference,
      row.chequeNumber,
      row.counterpartyName,
      row.amountMinor,
      row.currency,
      row.transactionStatus,
      row.chequeStatus,
      row.evidenceState,
      report.coverage,
    ]
      .map(csvCell)
      .join(',')
  );
  // Non-record metadata must survive empty and filtered-empty downloads.
  // It is not a fabricated cheque row and never asserts complete coverage.
  const metadata = [
    ['metadata', 'coverage', report.coverage],
    ['metadata', 'sourceCount', String(report.sourceCount)],
    ['metadata', 'sourceCap', String(report.sourceCap)],
    ['metadata', 'fromInclusiveUTC', report.period.from],
    ['metadata', 'toExclusiveUTC', report.period.to],
    ['metadata', 'scope', 'RECENT_CAPPED_CURRENT_STATE_NOT_AP_AGING'],
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
  return `${metadata}\r\n\r\n${header.map(csvCell).join(',')}\r\n${lines.join('\r\n')}${lines.length ? '\r\n' : ''}`;
}
