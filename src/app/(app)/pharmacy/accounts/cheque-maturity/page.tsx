import type { Metadata } from 'next';
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
  CHEQUE_MATURITY_COVERAGE,
  chequeMaturityCsv,
  chequeMaturityEvidence,
  chequeMaturityMonths,
} from '@/lib/pharmacy/accounts/cheque-maturity';
import { tenantContext } from '../../purchasing/_lib/console';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { ExportCsv } from './export-csv';

export const metadata: Metadata = { title: 'Recorded cheque maturity · Pharmacy accounts' };
type Query = { branch?: string | string[] };

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SectionCard title={title} titleLevel={2}>
      <p role="status" className="text-sm text-text-muted">
        {children}
      </p>
    </SectionCard>
  );
}

async function financialReportAllowed(ctx: NonNullable<Awaited<ReturnType<typeof tenantContext>>>) {
  try {
    return await can(subjectFromSession(ctx.session.user), 'reports:financial', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    });
  } catch {
    return false;
  }
}

export default async function ChequeMaturityPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const requested = (await searchParams).branch;
  let ctx: Awaited<ReturnType<typeof tenantContext>>;
  try {
    ctx = await tenantContext();
  } catch {
    ctx = null;
  }
  const user = ctx?.session?.user;
  if (
    !ctx ||
    !user?.id ||
    user.role !== 'ADMIN' ||
    ctx.organization?.id !== ctx.entitlements.organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-finance') ||
    !hasModule(ctx.entitlements, 'pharmacy-reports') ||
    !(await financialReportAllowed(ctx))
  ) {
    return (
      <main className="space-y-6">
        <PageHeader
          eyebrow="Pharmacy accounts"
          heading="Recorded cheque maturity"
          description="Current-state evidence from recorded cheque due dates and statuses."
        />
        <Notice title="Financial report access required">
          Owner financial-report capability, Pharmacy Reports, and existing Finance workspace
          authorization are required. No cheque evidence was read.
        </Notice>
      </main>
    );
  }

  const branches = await ctx.db.pharmacyBranch.findMany({
    where: { organizationId: ctx.entitlements.organizationId, active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  const branchId =
    typeof requested === 'string'
      ? requested
      : requested === undefined && branches.length === 1
        ? branches[0]?.id
        : undefined;
  const branch = branches.find((item) => item.id === branchId);
  let rows = [] as ReturnType<typeof chequeMaturityEvidence>;
  let observedAt = '';
  let failed = false;
  if (branch) {
    try {
      const workspace = await pharmacyFinanceRouter
        .createCaller(ctx)
        .workspace({ branchId: branch.id });
      rows = chequeMaturityEvidence(workspace.transactions);
      observedAt = new Date().toISOString();
    } catch {
      failed = true;
    }
  }
  const unknownDate = rows.filter((row) => !row.dueDate);
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Recorded cheque maturity"
        description="A current-state evidence calendar using only actual recorded due dates and statuses."
        actions={rows.length ? <ExportCsv csv={chequeMaturityCsv(rows, observedAt)} /> : undefined}
      />
      <SectionCard title="Branch" titleLevel={2}>
        <form action="/pharmacy/accounts/cheque-maturity">
          <label className="text-sm text-text-body">
            Authorized active branch
            <select
              name="branch"
              defaultValue={branch?.id ?? ''}
              className="mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3"
              required
            >
              <option value="">Select a branch</option>
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="mt-4 min-h-11 rounded-[3px] bg-primary px-3 text-sm font-semibold text-primary-foreground"
            type="submit"
          >
            Load evidence
          </button>
        </form>
      </SectionCard>
      {!branch && requested ? (
        <Notice title="Branch unavailable">
          Select an authorized active branch. No out-of-scope evidence was read.
        </Notice>
      ) : null}
      {!branch && !requested ? (
        <Notice title="Choose a branch">
          This isolated read never combines branch cheque records.
        </Notice>
      ) : null}
      {failed ? (
        <Notice title="Cheque evidence unavailable">
          The live Finance workspace read failed. No cached data is shown and no financial record
          was changed.
        </Notice>
      ) : null}
      {branch && !failed ? (
        <>
          <SectionCard title="Evidence limits" titleLevel={2}>
            <p role="status" className="text-sm font-medium text-text-strong">
              {CHEQUE_MATURITY_COVERAGE}
            </p>
            <p className="mt-2 text-sm text-text-muted">
              {rows.length} recorded cheques retained from the latest workspace response. Empty does
              not prove no cheques; exactly 50 means the read cap was reached. Dates use UTC. This
              does not infer contractual AP maturity, perform BANK deductions, repair postings, or
              establish historical currency.
            </p>
          </SectionCard>
          {rows.length === 0 ? (
            <Notice title="No recorded cheques in this read">
              The recent capped live response contained no safe cheque evidence. Full branch
              coverage remains unknown.
            </Notice>
          ) : null}
          {chequeMaturityMonths(rows).map(({ month, entries }) => (
            <SectionCard
              key={month}
              title={new Intl.DateTimeFormat('en', {
                month: 'long',
                year: 'numeric',
                timeZone: 'UTC',
              }).format(new Date(`${month}-01T00:00:00Z`))}
              titleLevel={2}
            >
              <EvidenceTable rows={entries} />
            </SectionCard>
          ))}
          {unknownDate.length ? (
            <SectionCard title="Unknown recorded due date" titleLevel={2}>
              <p className="mb-3 text-sm text-text-muted">
                These cheque records have no usable recorded maturity date; no date was inferred.
              </p>
              <EvidenceTable rows={unknownDate} />
            </SectionCard>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

function EvidenceTable({ rows }: { rows: ReturnType<typeof chequeMaturityEvidence> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Due date (UTC)</TableHead>
          <TableHead>Reference</TableHead>
          <TableHead>Cheque</TableHead>
          <TableHead>Status</TableHead>
          <TableHead numeric>Recorded amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.dueDate ?? 'Unknown'}</TableCell>
            <TableCell>{row.reference}</TableCell>
            <TableCell>{row.chequeNumber ?? 'Not recorded'}</TableCell>
            <TableCell>
              <StatusPill
                status={row.state}
                tone={
                  row.state === 'CLEARED'
                    ? 'success'
                    : row.state === 'BOUNCED' || row.state === 'REVERSED'
                      ? 'danger'
                      : 'neutral'
                }
              />
            </TableCell>
            <TableCell numeric>
              {row.amountMinor ?? 'Unknown'} {row.recordedCurrency ?? '(currency not recorded)'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
