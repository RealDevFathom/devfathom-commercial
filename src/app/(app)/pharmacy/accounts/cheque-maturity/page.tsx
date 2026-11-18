import { PHARMACY_COPY } from '@/lib/pharmacy/plain-language';
import { SHOP_SCREEN_COPY as screenCopy } from '@/lib/pharmacy/screen-copy';
import { ReportDetails } from '@/components/pharmacy/report-details';
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
  formatChequeAmount,
  hasChequeAmountScale,
} from '@/lib/pharmacy/accounts/cheque-maturity';
import { tenantContext } from '../../purchasing/_lib/console';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { ExportCsv } from './export-csv';

export const metadata: Metadata = {
  title: screenCopy.cheques.recordedChequeMaturityPharmacyAccounts,
};
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

type TenantContext = NonNullable<Awaited<ReturnType<typeof tenantContext>>>;

async function financialReportAllowed(
  ctx: TenantContext,
  user: NonNullable<TenantContext['session']>['user']
) {
  try {
    return await can(subjectFromSession(user), 'reports:financial', undefined, {
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
    !(await financialReportAllowed(ctx, user))
  ) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow={screenCopy.cheques.pharmacyAccounts}
          heading={screenCopy.cheques.recordedChequeMaturity}
          description={screenCopy.cheques.seeWhenYourRecordedChequesAreDue}
        />
        <Notice title={screenCopy.cheques.financialReportAccessRequired}>
          {screenCopy.cheques.ownerFinancialReportCapabilityPharmacyReportsAndExisting}
        </Notice>
      </div>
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
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow={screenCopy.cheques.pharmacyAccounts}
        heading={screenCopy.cheques.recordedChequeMaturity}
        description={screenCopy.cheques.seeWhenYourRecordedChequesAreDue}
        actions={rows.length ? <ExportCsv csv={chequeMaturityCsv(rows, observedAt)} /> : undefined}
      />
      <SectionCard title={screenCopy.cheques.branch} titleLevel={2}>
        <form action="/pharmacy/accounts/cheque-maturity">
          <label className="text-sm text-text-body">
            {screenCopy.cheques.authorizedActiveBranch}
            <select
              name="branch"
              defaultValue={branch?.id ?? ''}
              className="mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3"
              required
            >
              <option value="">{screenCopy.cheques.selectABranch}</option>
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="mt-4 min-h-11 rounded-control bg-primary px-3 text-sm font-semibold text-primary-foreground"
            type="submit"
          >
            {screenCopy.cheques.showCheques}
          </button>
        </form>
      </SectionCard>
      {!branch && requested ? (
        <Notice title={screenCopy.cheques.branchUnavailable}>
          {screenCopy.cheques.selectAnAuthorizedActiveBranchNoOutOf}
        </Notice>
      ) : null}
      {!branch && !requested ? (
        <Notice title={screenCopy.cheques.chooseABranch}>
          {screenCopy.cheques.thisIsolatedReadNeverCombinesBranchChequeRecords}
        </Notice>
      ) : null}
      {failed ? (
        <Notice title={screenCopy.cheques.chequeEvidenceUnavailable}>
          {screenCopy.cheques.theLiveFinanceWorkspaceReadFailedNoCached}
        </Notice>
      ) : null}
      {branch && !failed ? (
        <>
          <SectionCard title={screenCopy.cheques.aboutThisList} titleLevel={2}>
            <p className="text-sm text-text-muted">
              {screenCopy.cheques.latestRecordedChequesTheListMayBeIncomplete}
            </p>
            <ReportDetails>
              <p role="status" className="text-sm font-medium text-text-strong">
                {CHEQUE_MATURITY_COVERAGE}
              </p>
              <p className="mt-2 text-sm text-text-muted">
                {rows.length}
                {screenCopy.cheques.recordedChequesRetainedFromTheLatestWorkspaceResponse}
              </p>
            </ReportDetails>
          </SectionCard>
          {rows.length === 0 ? (
            <Notice title={screenCopy.cheques.noRecordedChequesInThisRead}>
              {screenCopy.cheques.theRecentCappedLiveResponseContainedNoSafe}
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
            <SectionCard title={screenCopy.cheques.unknownRecordedDueDate} titleLevel={2}>
              <p className="mb-3 text-sm text-text-muted">
                {screenCopy.cheques.theseChequeRecordsHaveNoUsableRecordedMaturity}
              </p>
              <EvidenceTable rows={unknownDate} />
            </SectionCard>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function EvidenceTable({ rows }: { rows: ReturnType<typeof chequeMaturityEvidence> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{screenCopy.cheques.dueDateUtc}</TableHead>
          <TableHead>{screenCopy.cheques.reference}</TableHead>
          <TableHead>{screenCopy.cheques.cheque}</TableHead>
          <TableHead>{screenCopy.cheques.status}</TableHead>
          <TableHead numeric>{screenCopy.cheques.recordedAmount}</TableHead>
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
                label={PHARMACY_COPY.account.chequeStates[row.state]}
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
              {row.amountMinor !== null && !hasChequeAmountScale(row.recordedCurrency) ? (
                <>
                  <span>{PHARMACY_COPY.account.amountUnconfirmed}</span>
                  <ReportDetails>
                    <p>{formatChequeAmount(row.amountMinor, row.recordedCurrency)}</p>
                  </ReportDetails>
                </>
              ) : (
                formatChequeAmount(row.amountMinor, row.recordedCurrency)
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
