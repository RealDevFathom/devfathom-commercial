import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  FISCAL_EXCEPTION_STATUSES,
  MAX_FISCAL_EXCEPTION_PAGE,
  MAX_FISCAL_EXCEPTION_PAGE_SIZE,
  MAX_FISCAL_EXCEPTION_WINDOW_DAYS,
  projectFiscalExceptionRegister,
} from './fiscal-exceptions';

export type FiscalExceptionReadInput = Readonly<{
  branchId: string;
  from: Date;
  to: Date;
  page?: number;
  pageSize?: number;
}>;

export function validateFiscalExceptionRead(input: FiscalExceptionReadInput) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 50;
  const duration = input.to.getTime() - input.from.getTime();
  if (!input.branchId.trim()) throw new Error('Choose an active branch.');
  if (!Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime()))
    throw new Error('Choose valid UTC dates.');
  if (duration <= 0 || duration > MAX_FISCAL_EXCEPTION_WINDOW_DAYS * 86_400_000)
    throw new Error('Choose a half-open report window of no more than 92 days.');
  if (!Number.isInteger(page) || page < 1 || page > MAX_FISCAL_EXCEPTION_PAGE)
    throw new Error('The requested report page is outside the supported range.');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_FISCAL_EXCEPTION_PAGE_SIZE)
    throw new Error('The requested page size is outside the supported range.');
  return { page, pageSize };
}

/**
 * Current-state, tenant-scoped detail read. Authorization must happen before this function;
 * active-branch validation still happens here before any fiscal document is read.
 */
export async function readFiscalExceptions(
  db: ScopedDb,
  scope: Readonly<{ organizationId: string }>,
  input: FiscalExceptionReadInput,
  observedAt = new Date()
) {
  const { page, pageSize } = validateFiscalExceptionRead(input);
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: input.branchId, organizationId: scope.organizationId, active: true },
    select: { id: true, name: true },
  });
  if (!branch) throw new Error('The requested branch is not an active branch in this workspace.');

  const records = await db.pharmacyFiscalDocument.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: branch.id,
      status: { in: [...FISCAL_EXCEPTION_STATUSES] },
      createdAt: { gte: input.from, lt: input.to },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    select: {
      id: true,
      localReference: true,
      kind: true,
      integratorMode: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      nextAttemptAt: true,
      submittedAt: true,
      rejectedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return projectFiscalExceptionRegister({
    branch,
    from: input.from,
    to: input.to,
    observedAt,
    page,
    pageSize,
    hasMore: records.length > pageSize,
    rows: records.slice(0, pageSize),
  });
}
