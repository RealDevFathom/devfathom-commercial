export const FISCAL_EXCEPTION_STATUSES = ['QUEUED', 'REJECTED', 'DEAD'] as const;
export const FISCAL_EXCEPTION_MODES = ['OFF', 'SANDBOX'] as const;
export const MAX_FISCAL_EXCEPTION_WINDOW_DAYS = 92;
export const MAX_FISCAL_EXCEPTION_PAGE_SIZE = 100;
export const MAX_FISCAL_EXCEPTION_PAGE = 100;

export type FiscalExceptionStatus = (typeof FISCAL_EXCEPTION_STATUSES)[number];
export type FiscalExceptionMode = (typeof FISCAL_EXCEPTION_MODES)[number];

export type FiscalExceptionSourceRow = Readonly<{
  id: string;
  localReference: string;
  kind: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
  integratorMode: FiscalExceptionMode;
  status: FiscalExceptionStatus | 'SUBMITTING' | 'ACCEPTED';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  submittedAt: Date | null;
  rejectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type FiscalExceptionRow = Readonly<{
  id: string;
  localReference: string;
  kind: FiscalExceptionSourceRow['kind'];
  mode: FiscalExceptionMode;
  status: FiscalExceptionStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  submittedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type FiscalExceptionRegister = Readonly<{
  branch: Readonly<{ id: string; name: string }>;
  from: string;
  to: string;
  observedAt: string;
  page: number;
  pageSize: number;
  coverage: 'CURRENT_READ_COMPLETE' | 'PARTIAL';
  hasMore: boolean;
  rows: readonly FiscalExceptionRow[];
}>;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** Pure projection. It deliberately has no payload, QR, provider error or external reference. */
export function projectFiscalExceptionRegister(input: {
  branch: { id: string; name: string };
  from: Date;
  to: Date;
  observedAt: Date;
  page: number;
  pageSize: number;
  hasMore: boolean;
  rows: readonly FiscalExceptionSourceRow[];
}): FiscalExceptionRegister {
  const rows = input.rows.map((row) => {
    if (!FISCAL_EXCEPTION_STATUSES.includes(row.status as FiscalExceptionStatus))
      throw new Error('Only fiscal exception statuses can be projected.');
    const status = row.status as FiscalExceptionStatus;
    return Object.freeze({
      id: row.id,
      localReference: row.localReference,
      kind: row.kind,
      mode: row.integratorMode,
      status,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      nextAttemptAt: iso(row.nextAttemptAt),
      submittedAt: iso(row.submittedAt),
      rejectedAt: iso(row.rejectedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  });
  return Object.freeze({
    branch: Object.freeze({ ...input.branch }),
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    observedAt: input.observedAt.toISOString(),
    page: input.page,
    pageSize: input.pageSize,
    coverage: input.page === 1 && !input.hasMore ? 'CURRENT_READ_COMPLETE' : 'PARTIAL',
    hasMore: input.hasMore,
    rows: Object.freeze(rows),
  });
}

function safeCsvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  // Controls are not useful evidence in these fields and can alter spreadsheet/terminal behaviour.
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** CSV exports exactly the displayed, non-sensitive projection. */
export function fiscalExceptionCsv(report: FiscalExceptionRegister): string {
  const header = [
    'Local reference',
    'Kind',
    'Mode',
    'Status',
    'Attempts',
    'Max attempts',
    'Next attempt at',
    'Submitted at',
    'Rejected at',
    'Created at',
    'Updated at',
  ];
  const lines = report.rows.map((row) =>
    [
      row.localReference,
      row.kind,
      row.mode,
      row.status,
      row.attempts,
      row.maxAttempts,
      row.nextAttemptAt,
      row.submittedAt,
      row.rejectedAt,
      row.createdAt,
      row.updatedAt,
    ]
      .map(safeCsvCell)
      .join(',')
  );
  return `${[header.map(safeCsvCell).join(','), ...lines].join('\r\n')}\r\n`;
}
