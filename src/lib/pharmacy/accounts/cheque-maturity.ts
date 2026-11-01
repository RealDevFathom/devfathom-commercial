import { formulaSafeCell } from '@/lib/pharmacy/reference-connectors';

export const CHEQUE_MATURITY_LIMIT = 50;
export const CHEQUE_MATURITY_COVERAGE =
  'Recent capped live read (50); full branch coverage unknown. This is not a historical snapshot or a complete cheque ledger.';

export type ChequeMaturityState = 'PDC' | 'CLEARED' | 'BOUNCED' | 'REVERSED' | 'UNKNOWN';

export type ChequeMaturityRow = {
  id: string;
  reference: string;
  chequeNumber: string | null;
  counterpartyName: string | null;
  amountMinor: number | null;
  recordedCurrency: string | null;
  dueDate: string | null;
  state: ChequeMaturityState;
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const safeText = (value: unknown, max = 200) =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
const utcDate = (value: unknown) => {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
};

/** Treat the workspace response as an untrusted DTO and retain cheque evidence only. */
export function chequeMaturityEvidence(value: unknown): ChequeMaturityRow[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, CHEQUE_MATURITY_LIMIT).flatMap((candidate) => {
    const row = object(candidate);
    if (!row || row.kind !== 'CHEQUE') return [];
    const id = safeText(row.id, 128);
    const reference = safeText(row.reference, 160);
    if (!id || !reference) return [];
    const reversed = row.status === 'REVERSED' || utcDate(row.reversedAt) !== null;
    const state: ChequeMaturityState = reversed
      ? 'REVERSED'
      : row.chequeStatus === 'PDC' ||
          row.chequeStatus === 'CLEARED' ||
          row.chequeStatus === 'BOUNCED'
        ? row.chequeStatus
        : 'UNKNOWN';
    return [
      {
        id,
        reference,
        chequeNumber: safeText(row.chequeNumber, 80),
        counterpartyName: safeText(row.counterpartyName),
        amountMinor: Number.isSafeInteger(row.amountMinor) ? (row.amountMinor as number) : null,
        recordedCurrency: safeText(row.currency, 16),
        dueDate: utcDate(row.chequeDueAt),
        state,
      },
    ];
  });
}

export function chequeMaturityMonths(rows: ChequeMaturityRow[]) {
  const months = new Map<string, ChequeMaturityRow[]>();
  for (const row of rows
    .filter((item) => item.dueDate)
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))) {
    const month = row.dueDate!.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), row]);
  }
  return [...months].map(([month, entries]) => ({ month, entries }));
}

function csvCell(value: unknown) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trimStart();
  return `"${formulaSafeCell(normalized).replaceAll('"', '""')}"`;
}

export function chequeMaturityCsv(rows: ChequeMaturityRow[], observedAt: string) {
  const header = [
    'evidence_scope',
    'observed_at',
    'reference',
    'cheque_number',
    'counterparty',
    'due_date_utc',
    'recorded_state',
    'amount_minor',
    'recorded_currency',
  ];
  return [
    header,
    ...rows.map((row) => [
      CHEQUE_MATURITY_COVERAGE,
      observedAt,
      row.reference,
      row.chequeNumber,
      row.counterpartyName,
      row.dueDate,
      row.state,
      row.amountMinor,
      row.recordedCurrency,
    ]),
  ]
    .map((line) => line.map(csvCell).join(','))
    .join('\r\n');
}

/** Minor-unit scales for currencies the platform records (Prisma `Currency`: USD, PKR). */
const MINOR_UNIT_DIGITS: ReadonlyMap<string, number> = new Map([
  ['PKR', 2],
  ['USD', 2],
]);

/**
 * Display a recorded minor-unit amount in major units using the recorded currency's
 * minor-unit scale. Unrecognised currencies are labelled as raw minor units rather than
 * guessing a scale.
 */
export function formatChequeAmount(amountMinor: number | null, currency: string | null) {
  if (amountMinor === null) return 'Unknown';
  const digits = currency ? MINOR_UNIT_DIGITS.get(currency) : undefined;
  if (currency && digits !== undefined) {
    const scale = 10 ** digits;
    const absolute = Math.abs(amountMinor);
    const major = Math.floor(absolute / scale)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const fraction = digits ? `.${String(absolute % scale).padStart(digits, '0')}` : '';
    return `${amountMinor < 0 ? '-' : ''}${currency} ${major}${fraction}`;
  }
  return `${amountMinor} minor units ${currency ?? '(currency not recorded)'}`;
}
