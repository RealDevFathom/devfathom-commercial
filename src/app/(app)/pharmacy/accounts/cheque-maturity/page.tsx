import { TRPCError } from '@trpc/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import {
  chequeMaturityCsv,
  chequeMaturityPeriod,
  projectChequeMaturity,
} from '@/lib/pharmacy/accounts/cheque-maturity';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { adminProcedure, createTRPCContext, router } from '@/server/trpc';
import { DownloadCsv } from './download-csv';

export const metadata: Metadata = { title: 'Cheque maturity evidence · Pharmacy reports' };
const ROUTE = '/pharmacy/accounts/cheque-maturity';
type Query = Partial<Record<'branch' | 'from' | 'to', string | string[]>>;
const value = (input: string | string[] | undefined) =>
  typeof input === 'string' ? input : undefined;

async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

// Branch discovery is a sensitive read too. Reuse the same session, admin:access,
// and audit envelope as the finance workspace; do not replace it with a role check.
const reportAccessRouter = router({
  chequeMaturityBranches: adminProcedure.query(async ({ ctx }) => {
    // Standalone callers have no root module prefix, so keep both explicit module gates.
    if (
      !ctx.session.user.id ||
      ctx.session.user.role !== 'ADMIN' ||
      !ctx.entitlements.organizationId ||
      ctx.entitlements.organizationId !== ctx.organization?.id ||
      !hasModule(ctx.entitlements, 'pharmacy-reports') ||
      !hasModule(ctx.entitlements, 'pharmacy-finance')
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Financial report access is required.' });
    }
    for (const capability of ['reports:operational', 'reports:financial'] as const) {
      if (
        !(await can(subjectFromSession(ctx.session.user), capability, undefined, {
          db: ctx.db,
          source: 'TRPC',
          ip: ctx.requestMeta.ip,
        }))
      ) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Financial report access is required.' });
      }
    }
    return ctx.db.pharmacyBranch.findMany({
      where: { organizationId: ctx.entitlements.organizationId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }),
});

async function reportAccess() {
  const ctx = await tenantContext();
  if (!ctx) return { kind: 'denied' as const };
  try {
    const branches = await reportAccessRouter.createCaller(ctx).chequeMaturityBranches();
    return { kind: 'allowed' as const, ctx, branches };
  } catch (error) {
    if (
      error instanceof TRPCError &&
      (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN')
    )
      return { kind: 'denied' as const };
    throw error;
  }
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SectionCard title={title}>
      <p role="status" className="text-sm text-text-muted">
        {children}
      </p>
    </SectionCard>
  );
}

function money(minor: string, currency: string) {
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${negative ? '-' : ''}${whole}.${padded.slice(-2)}`;
}

const tone: Record<string, StatusTone> = {
  CLEARED: 'success',
  PDC: 'warning',
  BOUNCED: 'danger',
  REVERSED: 'neutral',
  POSTED: 'info',
  PENDING: 'warning',
};

export default async function ChequeMaturityPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const heading = (
    <PageHeader
      eyebrow="Pharmacy reports"
      heading="Cheque maturity evidence"
      description="Review recorded cheque due dates and export the same bounded current-state evidence."
    />
  );
  let access: Awaited<ReturnType<typeof reportAccess>> | null = null;
  try {
    access = await reportAccess();
  } catch {
    // Fail closed without exposing provider or database errors.
  }
  if (!access || access.kind === 'denied') {
    return (
      <main className="min-w-0 space-y-6">
        {heading}
        <Notice title={access ? 'Financial report access required' : 'Report access unavailable'}>
          {access
            ? 'Administrator access, both Reports capabilities, and Pharmacy reports and finance access are required.'
            : 'Your session, permissions, or branch scope could not be verified. Reload to retry.'}
        </Notice>
      </main>
    );
  }

  const { ctx, branches } = access;
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const to = value(query.to) ?? tomorrow.toISOString().slice(0, 10);
  const start = new Date(`${to}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - 30);
  const from =
    value(query.from) ?? (Number.isFinite(start.getTime()) ? start.toISOString().slice(0, 10) : '');
  const requestedBranch = value(query.branch);
  const branchId = requestedBranch ?? (branches.length === 1 ? branches[0]!.id : '');
  const branch = branches.find((candidate) => candidate.id === branchId);
  const duplicateQuery = Object.values(query).some(Array.isArray);
  let invalidPeriod = false;
  try {
    chequeMaturityPeriod(from, to);
  } catch {
    invalidPeriod = true;
  }
  let report: ReturnType<typeof projectChequeMaturity> | null = null;
  let readFailed = false;
  if (branch && !duplicateQuery && !invalidPeriod) {
    try {
      const workspace = await pharmacyFinanceRouter
        .createCaller(ctx)
        .workspace({ branchId: branch.id });
      report = projectChequeMaturity(
        workspace.transactions,
        { organizationId: ctx.entitlements.organizationId, branchId: branch.id },
        { from, to }
      );
    } catch {
      readFailed = true;
    }
  }

  return (
    <main className="min-w-0 space-y-6">
      {heading}
      <SectionCard title="Report scope">
        <form
          method="get"
          action={ROUTE}
          className="grid gap-4 md:grid-cols-[minmax(12rem,1fr)_repeat(2,minmax(10rem,0.6fr))_auto] md:items-end"
        >
          <label className="text-sm font-medium text-text-strong">
            Branch
            <select
              name="branch"
              defaultValue={branchId}
              className="mt-1 min-h-11 w-full rounded-sm border border-border-default bg-surface-raised px-3"
              required
            >
              <option value="" disabled>
                Choose a branch
              </option>
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-text-strong">
            From (UTC)
            <Input className="mt-1" type="date" name="from" defaultValue={from} required />
          </label>
          <label className="text-sm font-medium text-text-strong">
            To, exclusive (UTC)
            <Input className="mt-1" type="date" name="to" defaultValue={to} required />
          </label>
          <Button type="submit" disabled={!branches.length}>
            Prepare report
          </Button>
        </form>
        <p className="mt-4 text-xs leading-relaxed text-text-muted">
          The due-date window is half-open [from,to), uses UTC, and is limited to 92 days. Cheques
          with an unknown recorded due date remain visible.
        </p>
      </SectionCard>

      {duplicateQuery || invalidPeriod ? (
        <Notice title="Invalid report period">
          Choose one branch and a positive UTC date window of no more than 92 days.
        </Notice>
      ) : null}
      {!branch && !duplicateQuery ? (
        <Notice title={requestedBranch ? 'Branch outside report scope' : 'Choose a branch'}>
          {requestedBranch
            ? 'The requested active branch is outside your authorized tenant scope. No financial evidence was read.'
            : 'Choose one active branch to prepare its cheque evidence.'}
        </Notice>
      ) : null}
      {readFailed ? (
        <Notice title="Cheque evidence unavailable">
          The authorized current-state read could not be prepared. No financial data was changed.
        </Notice>
      ) : null}
      {report ? (
        <SectionCard
          title="Recorded cheque calendar"
          actions={
            <DownloadCsv
              csv={chequeMaturityCsv(report)}
              fileName={`cheque-maturity-${branch!.id}-${from}-${to}.csv`}
            />
          }
        >
          <div className="mb-4 rounded-sm border border-border-subtle bg-surface-sunken p-3 text-sm text-text-muted">
            <strong className="text-text-strong">Coverage unknown.</strong> {report.coverage} This
            is not a complete ledger, AP aging report, historical snapshot, reconciliation, or
            forecast.
          </div>
          {report.rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Due date (UTC)</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Cheque</TableHead>
                  <TableHead>Counterparty</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead numeric>Recorded amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row) => (
                  <TableRow key={`${row.reference}:${row.chequeNumber ?? ''}`}>
                    <TableCell>{row.dueDate ?? 'Unknown'}</TableCell>
                    <TableCell>{row.reference}</TableCell>
                    <TableCell>{row.chequeNumber ?? 'Not recorded'}</TableCell>
                    <TableCell>{row.counterpartyName ?? 'Not recorded'}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <StatusPill status={row.evidenceState} tone={tone[row.evidenceState]} />
                        <span className="text-xs text-text-muted">
                          Transaction: {row.transactionStatus}; cheque: {row.chequeStatus}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell numeric>{money(row.amountMinor, row.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-text-muted">
              No recorded cheques in the bounded recent read matched this due-date window. This does
              not prove there were none.
            </p>
          )}
        </SectionCard>
      ) : null}
    </main>
  );
}
