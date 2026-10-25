import type { Metadata } from 'next';

import { buttonVariants, Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
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
  fiscalExceptionCsv,
  type FiscalExceptionRegister,
} from '@/lib/pharmacy/accounts/fiscal-exceptions';
import { readFiscalExceptions } from '@/lib/pharmacy/accounts/fiscal-exceptions.reader';
import { tenantContext } from '@/app/(app)/pharmacy/purchasing/_lib/console';

export const metadata: Metadata = { title: 'Fiscal exception evidence · Pharmacy accounts' };
const ROUTE = '/pharmacy/accounts/fiscal-exceptions';
type Query = Partial<Record<'branch' | 'from' | 'to' | 'page', string | string[]>>;
const scalar = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

function utcDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

async function authorize() {
  const ctx = await tenantContext();
  if (
    !ctx?.session?.user?.id ||
    ctx.session.user.role !== 'ADMIN' ||
    !ctx.entitlements.organizationId ||
    ctx.organization?.id !== ctx.entitlements.organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-reports')
  )
    return null;
  const user = ctx.session.user;
  if (user.role !== 'ADMIN') {
    const subject = subjectFromSession({ ...user, id: user.id });
    if (
      !(await can(subject, 'reports:operational', undefined, {
        db: ctx.db,
        source: 'TRPC',
        ip: ctx.requestMeta.ip,
      })) ||
      !(await can(subject, 'reports:financial', undefined, {
        db: ctx.db,
        source: 'TRPC',
        ip: ctx.requestMeta.ip,
      }))
    )
      return null;
  }
  return ctx;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SectionCard title={title} titleLevel={2}>
      <p role="alert" className="text-sm text-text-muted">
        {children}
      </p>
    </SectionCard>
  );
}

export default async function FiscalExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const heading = (
    <PageHeader
      eyebrow="Pharmacy accounts"
      heading="Fiscal exception evidence"
      description="Current queued, rejected and dead fiscal document lifecycle evidence for one active branch."
    />
  );
  let ctx: Awaited<ReturnType<typeof authorize>> = null;
  try {
    ctx = await authorize();
  } catch {
    return (
      <main className="min-w-0 space-y-6">
        {heading}
        <Notice title="Report access unavailable">
          Your session, report permissions and tenant scope could not be verified. Reload to retry.
        </Notice>
      </main>
    );
  }
  if (!ctx)
    return (
      <main className="min-w-0 space-y-6">
        {heading}
        <Notice title="Report access required">
          Administrator access or both operational and financial Reports capabilities, plus Pharmacy
          Reports access, are required.
        </Notice>
      </main>
    );

  let branches: { id: string; name: string }[] = [];
  let branchReadFailed = false;
  try {
    branches = await ctx.db.pharmacyBranch.findMany({
      where: { organizationId: ctx.entitlements.organizationId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  } catch {
    branchReadFailed = true;
  }
  const today = new Date();
  const defaultTo = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1)
  );
  const defaultFrom = new Date(defaultTo.getTime() - 30 * 86_400_000);
  const fromText = scalar(query.from) ?? defaultFrom.toISOString().slice(0, 10);
  const toText = scalar(query.to) ?? defaultTo.toISOString().slice(0, 10);
  const branchId = scalar(query.branch) ?? '';
  const branch = branches.find((item) => item.id === branchId);
  const from = utcDate(fromText);
  const to = utcDate(toText);
  const pageText = scalar(query.page) ?? '1';
  const page = /^\d+$/.test(pageText) ? Number(pageText) : Number.NaN;
  const duplicateQuery = Object.values(query).some(Array.isArray);
  const validWindow = from && to && to > from && to.getTime() - from.getTime() <= 92 * 86_400_000;
  const validPage = Number.isInteger(page) && page >= 1 && page <= 100;
  let report: FiscalExceptionRegister | null = null;
  let readFailed = false;
  if (!branchReadFailed && branch && validWindow && validPage && !duplicateQuery) {
    try {
      report = await readFiscalExceptions(
        ctx.db,
        { organizationId: ctx.entitlements.organizationId },
        { branchId: branch.id, from, to, page }
      );
    } catch {
      readFailed = true;
    }
  }
  const hrefForPage = (value: number) =>
    `${ROUTE}?${new URLSearchParams({ branch: branchId, from: fromText, to: toText, page: String(value) })}`;

  return (
    <main className="min-w-0 space-y-6">
      {heading}
      <SectionCard title="Report scope" titleLevel={2}>
        <p id="fiscal-window-help" className="mb-4 text-sm text-text-muted">
          Dates form a half-open UTC window [from, to), limited to 92 days. A branch is always
          explicit; an invalid branch is never replaced.
        </p>
        <form action={ROUTE} method="get" className="grid gap-4 md:grid-cols-4">
          <label className="text-sm text-text-body">
            Active branch
            <select
              name="branch"
              required
              defaultValue={branch?.id ?? branchId}
              aria-invalid={Boolean(branchId && !branch)}
              className="mt-1 min-h-11 w-full rounded-sm border border-border bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <option value="">Choose a branch</option>
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-text-body">
            From (UTC)
            <Input
              className="mt-1 min-h-11"
              type="date"
              name="from"
              required
              defaultValue={fromText}
              aria-describedby="fiscal-window-help"
            />
          </label>
          <label className="text-sm text-text-body">
            To, exclusive (UTC)
            <Input
              className="mt-1 min-h-11"
              type="date"
              name="to"
              required
              defaultValue={toText}
              aria-describedby="fiscal-window-help"
            />
          </label>
          <Button
            type="submit"
            className="min-h-11 self-end"
            disabled={branchReadFailed || branches.length === 0}
          >
            Read evidence
          </Button>
        </form>
      </SectionCard>
      {branchReadFailed ? (
        <Notice title="Branch scope unavailable">
          The active branch scope could not be verified. No fiscal evidence was read.
        </Notice>
      ) : duplicateQuery || !validWindow || !validPage ? (
        <Notice title="Invalid report request">
          Choose one active branch, one valid page, and a half-open UTC window no longer than 92
          days.
        </Notice>
      ) : branchId && !branch ? (
        <Notice title="Branch not available">
          The explicitly requested branch is not an active branch in this report scope. No fiscal
          evidence was read.
        </Notice>
      ) : readFailed ? (
        <Notice title="Evidence unavailable">
          The current-state evidence read failed. No partial result or sensitive provider detail is
          shown.
        </Notice>
      ) : null}
      {report ? (
        <SectionCard title="Exception register" titleLevel={2}>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <p role="status" className="max-w-3xl text-sm text-text-muted">
              {report.coverage === 'PARTIAL'
                ? 'Partial coverage: this capped page is not complete ledger coverage.'
                : 'All matching current rows in this date and branch scope were returned by this read.'}{' '}
              Observed {report.observedAt}. Separate reads are not an authorized snapshot.
            </p>
            <a
              download={`fiscal-exceptions-${report.branch.id}-${fromText}-${toText}.csv`}
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(fiscalExceptionCsv(report))}`}
              className={buttonVariants({ variant: 'outline' })}
            >
              Download safe CSV
            </a>
          </div>
          {report.rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Local reference</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead numeric>Attempts</TableHead>
                  <TableHead>Next attempt</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono">{row.localReference}</TableCell>
                    <TableCell>{row.kind.replaceAll('_', ' ')}</TableCell>
                    <TableCell>
                      <StatusPill status={row.mode} tone="neutral" />
                    </TableCell>
                    <TableCell>
                      <StatusPill
                        status={row.status}
                        tone={row.status === 'QUEUED' ? 'warning' : 'danger'}
                      />
                    </TableCell>
                    <TableCell numeric>
                      {row.attempts} / {row.maxAttempts}
                    </TableCell>
                    <TableCell>{row.nextAttemptAt ?? 'Not scheduled'}</TableCell>
                    <TableCell>{row.updatedAt}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-text-muted">
              No queued, rejected or dead fiscal documents were recorded in this scope.
            </p>
          )}
          <div className="mt-4 flex gap-3">
            {report.page > 1 ? (
              <a
                className={buttonVariants({ variant: 'outline' })}
                href={hrefForPage(report.page - 1)}
              >
                Previous page
              </a>
            ) : null}
            {report.hasMore ? (
              <a
                className={buttonVariants({ variant: 'outline' })}
                href={hrefForPage(report.page + 1)}
              >
                Next page
              </a>
            ) : null}
          </div>
          <p className="mt-4 text-sm text-text-muted">
            OFF means no integrator was selected. SANDBOX outcomes are operational test evidence
            only, never fiscal registration, acceptance by a tax authority, or compliance. Unknown
            provider detail, currency and completeness remain unknown.
          </p>
        </SectionCard>
      ) : null}
    </main>
  );
}
