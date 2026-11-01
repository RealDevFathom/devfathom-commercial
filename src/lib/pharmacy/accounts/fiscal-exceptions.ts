import { z } from 'zod';

export const FISCAL_EXCEPTION_LIMITS = { days: 92, pageSize: 50, maxPageSize: 100, pages: 20 } as const;
export const FISCAL_EXCEPTION_STATUSES = ['QUEUED', 'REJECTED', 'DEAD'] as const;
export const FISCAL_EXCEPTION_NOTICE =
  'Current-state local evidence only. OFF disables integration; SANDBOX is non-production. No FBR dispatch, retry, tax calculation or compliance assurance is provided.';
export const FISCAL_EXCEPTION_COVERAGE =
  'Coverage unknown. This is one bounded page of currently queued, rejected or dead documents by creation date, not a lifecycle history or a complete fiscal population. Separate reads may change; no frozen snapshot is promised.';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Use a valid UTC calendar date.');

export const fiscalExceptionInput = z.object({
  branchId: z.string().trim().min(1).max(128),
  from: day,
  to: day,
  page: z.number().int().min(0).max(FISCAL_EXCEPTION_LIMITS.pages - 1).default(0),
  pageSize: z.number().int().min(1).max(FISCAL_EXCEPTION_LIMITS.maxPageSize)
    .default(FISCAL_EXCEPTION_LIMITS.pageSize),
}).strict().refine(({ from, to }) => {
  const duration = Date.parse(to) - Date.parse(from);
  return duration > 0 && duration <= FISCAL_EXCEPTION_LIMITS.days * 86_400_000;
}, 'Choose a nonempty [from, to) UTC window of at most 92 days.');

export type FiscalExceptionInput = z.input<typeof fiscalExceptionInput>;
export type FiscalExceptionFilters = z.output<typeof fiscalExceptionInput>;

/** An allowlist: even an over-broad mock/adapter result cannot reach the UI or CSV. */
export const fiscalExceptionDocument = z.object({
  id: z.string(),
  localReference: z.string(),
  kind: z.enum(['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE']),
  integratorMode: z.enum(['OFF', 'SANDBOX']),
  status: z.enum(FISCAL_EXCEPTION_STATUSES),
  attempts: z.number().int().min(0).max(10),
  maxAttempts: z.number().int().min(1).max(10),
  nextAttemptAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
}).strip().refine((row) => row.attempts <= row.maxAttempts, 'Invalid recorded attempt budget.');

export type FiscalExceptionRow = Omit<z.output<typeof fiscalExceptionDocument>,
  'nextAttemptAt' | 'createdAt' | 'updatedAt'> & {
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FiscalExceptionRegister = {
  organizationId: string;
  branch: { id: string; name: string };
  filters: FiscalExceptionFilters;
  configuredMode: 'OFF' | 'SANDBOX';
  readAt: string;
  coverage: 'UNKNOWN';
  hasMoreAtRead: boolean;
  pageCapReached: boolean;
  nextPage: number | null;
  rows: FiscalExceptionRow[];
};

/** Quote every cell, flatten control characters, and neutralize spreadsheet formulas. */
function csvCell(value: string | number | boolean | null): string {
  const clean = Array.from(String(value ?? ''), (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
      ? ' ' : character;
  }).join('');
  const safe = /^[\s\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]*[=+\-@]/u.test(clean)
    ? `'${clean}` : clean;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Page-only export. A coverage record is present even when there are no document rows. */
export function fiscalExceptionsCsv(register: FiscalExceptionRegister): string {
  const headers = [
    'record_type', 'organization_id', 'branch_id', 'from_inclusive_utc', 'to_exclusive_utc',
    'read_at_utc', 'configured_mode', 'coverage', 'page_1_based', 'page_size', 'returned_rows',
    'has_more_at_read', 'page_cap_reached', 'notice', 'document_id', 'local_reference',
    'kind', 'document_mode', 'status', 'attempts', 'max_attempts', 'next_attempt_utc',
    'created_utc', 'updated_utc',
  ];
  const metadata = [
    register.organizationId, register.branch.id, register.filters.from, register.filters.to,
    register.readAt, register.configuredMode, register.coverage, register.filters.page + 1,
    register.filters.pageSize, register.rows.length, register.hasMoreAtRead, register.pageCapReached,
    `${FISCAL_EXCEPTION_COVERAGE} ${FISCAL_EXCEPTION_NOTICE}`,
  ];
  const records = [
    headers,
    ['COVERAGE', ...metadata, ...Array<string>(10).fill('')],
    ...register.rows.map((row) => [
      'DOCUMENT', ...metadata, row.id, row.localReference, row.kind, row.integratorMode,
      row.status, row.attempts, row.maxAttempts, row.nextAttemptAt, row.createdAt, row.updatedAt,
    ]),
  ];
  return records.map((record) => record.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
