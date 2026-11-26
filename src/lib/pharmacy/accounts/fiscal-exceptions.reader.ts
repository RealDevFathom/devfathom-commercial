import 'server-only';

import { TRPCError } from '@trpc/server';
import { can, subjectFromSession } from '@/lib/abac';
import { evaluateSessionUser, temporaryPasswordBlocks } from '@/lib/auth/session-state';
import { requireFinanceBranchAssignment } from '@/lib/pharmacy/finance-access';
import { hasModule } from '@/lib/entitlements';
import { pharmacyBusinessDayRange } from '@/lib/pharmacy/business-day';
import type { TRPCContext } from '@/server/trpc';
import {
  fiscalExceptionDocument,
  fiscalExceptionInput,
  FISCAL_EXCEPTION_LIMITS,
  FISCAL_EXCEPTION_STATUSES,
  type FiscalExceptionRegister,
} from './fiscal-exceptions';

export type FiscalExceptionContext = Pick<
  TRPCContext,
  'db' | 'session' | 'organization' | 'entitlements' | 'requestMeta'
>;

const documentSelect = {
  id: true,
  localReference: true,
  kind: true,
  integratorMode: true,
  status: true,
  attempts: true,
  maxAttempts: true,
  nextAttemptAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const denied = () =>
  new TRPCError({
    code: 'FORBIDDEN',
    message:
      'An active pharmacy workspace, Reports access, branch admission and both report capabilities are required.',
  });

/** Stem-local detail reader. All access checks precede fiscal/configuration reads. */
export async function readFiscalExceptions(
  ctx: FiscalExceptionContext,
  input: unknown
): Promise<FiscalExceptionRegister> {
  const user = ctx.session?.user;
  if (!user?.id) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
  if (!evaluateSessionUser(user).ok || temporaryPasswordBlocks(user, 'fiscalExceptions.read'))
    throw denied();
  const organizationId = user.organizationId;
  if (
    !organizationId ||
    ctx.organization?.id !== organizationId ||
    ctx.organization.status !== 'ACTIVE' ||
    ctx.organization.vertical !== 'PHARMACY' ||
    ctx.entitlements.organizationId !== organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-reports')
  )
    throw denied();

  const subject = subjectFromSession(user);
  for (const capability of ['reports:operational', 'reports:financial'] as const) {
    if (
      !(await can(subject, capability, undefined, {
        db: ctx.db,
        source: 'TRPC',
        ip: ctx.requestMeta.ip,
      }))
    )
      throw denied();
  }
  const parsed = fiscalExceptionInput.safeParse(input);
  if (!parsed.success)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Choose an active branch, real calendar dates at most 92 days apart (the end date is not included), and a bounded page.',
    });
  const filters = parsed.data;
  await requireFinanceBranchAssignment(ctx, filters.branchId);
  const organization = await ctx.db.organization.findFirst({
    where: { id: organizationId, status: 'ACTIVE', vertical: 'PHARMACY' },
    select: { id: true },
  });
  if (!organization) throw denied();
  const branchRow = await ctx.db.pharmacyBranch.findFirst({
    where: { organizationId, id: filters.branchId, active: true },
    select: { id: true, name: true, businessDayEndsAtHistory: true },
  });
  const branch = branchRow ? { id: branchRow.id, name: branchRow.name } : null;
  if (!branch)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Branch is outside your active report scope.',
    });

  const config = await ctx.db.pharmacyFiscalConfiguration.findFirst({
    where: { organizationId },
    select: { integratorMode: true },
  });
  const configuredMode = config?.integratorMode ?? 'OFF';
  if (configuredMode !== 'OFF' && configuredMode !== 'SANDBOX') throw denied();
  const readAt = new Date().toISOString();
  // The picked days are the organisation's days: shop midnight to shop midnight. For a UTC
  // organisation (or none) these are the same UTC midnights as before. DEV-958A: each day ends
  // at the branch's "day ends at" hour (midnight by default).
  const timeZone = ctx.organization?.timezone ?? null;
  const clock = { timeZone, dayEnd: branchRow?.businessDayEndsAtHistory };
  const window = {
    from: pharmacyBusinessDayRange(filters.from, filters.from, clock).from,
    to: pharmacyBusinessDayRange(filters.to, filters.to, clock).from,
  };
  const documents = await ctx.db.pharmacyFiscalDocument.findMany({
    where: {
      organizationId,
      branchId: branch.id,
      status: { in: [...FISCAL_EXCEPTION_STATUSES] },
      createdAt: { gte: window.from, lt: window.to },
    },
    select: documentSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip: filters.page * filters.pageSize,
    take: filters.pageSize + 1,
  });
  const hasMoreAtRead = documents.length > filters.pageSize;
  const pageCapReached = hasMoreAtRead && filters.page === FISCAL_EXCEPTION_LIMITS.pages - 1;
  const rows = documents.slice(0, filters.pageSize).map((document) => {
    const safe = fiscalExceptionDocument.parse(document);
    return {
      ...safe,
      nextAttemptAt: safe.nextAttemptAt?.toISOString() ?? null,
      createdAt: safe.createdAt.toISOString(),
      updatedAt: safe.updatedAt.toISOString(),
    };
  });
  return {
    organizationId,
    branch,
    filters,
    configuredMode,
    readAt,
    coverage: 'UNKNOWN',
    timeZone,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    hasMoreAtRead,
    pageCapReached,
    nextPage: hasMoreAtRead && !pageCapReached ? filters.page + 1 : null,
    rows,
  };
}
