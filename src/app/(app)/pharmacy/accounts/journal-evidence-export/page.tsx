import { SHOP_SCREEN_COPY as screenCopy } from '@/lib/pharmacy/plain-language';
import { ReportDetails } from '@/components/pharmacy/report-details';
import type { Metadata } from 'next';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  journalEvidenceCoverage,
  type JournalEvidencePage,
} from '@/lib/pharmacy/accounts/journal-evidence-export';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext, type TRPCContext } from '@/server/trpc';
import { workspaceZoneLabel } from '@/lib/timezone';
import { pharmacyCalendarDayRange } from '@/lib/pharmacy/business-day';
import { JournalEvidenceExportButton } from './export-button';

export const metadata: Metadata = {
  title: screenCopy.journalExport.journalEvidenceExportPharmacyAccounts,
};
const ROUTE = '/pharmacy/accounts/journal-evidence-export';
type Query = Partial<Record<'branch' | 'from' | 'to' | 'page', string | string[]>>;

const value = (input: string | string[] | undefined) =>
  typeof input === 'string' ? input : undefined;
const dateOnly = (input: string | undefined) => {
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const date = new Date(`${input}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === input ? date : null;
};

function State({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SectionCard title={title}>
      <p role="status" className="text-sm text-text-muted">
        {children}
      </p>
    </SectionCard>
  );
}

export default async function JournalEvidenceExportPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const actor = await resolveTenantActor();
  let ctx: TRPCContext | null = null;
  try {
    if (actor?.session.user) {
      ctx = await createTRPCContext({
        session: actor.session,
        organization: actor.organization,
        support: actor.support,
      });
    }
  } catch {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow={screenCopy.journalExport.pharmacyAccounts}
          heading={screenCopy.journalExport.journalEvidenceExport}
          description={screenCopy.journalExport.downloadTheEntriesOnOnePageForThe}
        />
        <State title={screenCopy.journalExport.evidenceCouldNotBeRead}>
          {screenCopy.journalExport.accessCouldNotBeVerifiedNoCsvIs}
        </State>
      </div>
    );
  }
  const authzOptions = ctx ? { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip } : {};
  const subject = ctx?.session?.user ? subjectFromSession(ctx.session.user) : null;
  const allowed =
    ctx &&
    subject &&
    hasModule(ctx.entitlements, 'pharmacy-reports') &&
    (
      await Promise.all(
        (['admin:access', 'reports:operational', 'reports:financial'] as const).map((action) =>
          can(subject, action, undefined, authzOptions)
        )
      )
    ).every(Boolean);
  if (!allowed || !ctx) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow={screenCopy.journalExport.pharmacyAccounts}
          heading={screenCopy.journalExport.journalEvidenceExport}
          description={screenCopy.journalExport.downloadTheEntriesOnOnePageForThe}
        />
        <State title={screenCopy.journalExport.permissionRequired}>
          {screenCopy.journalExport.ownerFinancialReportPermissionAndPharmacyReportsAccess}
        </State>
      </div>
    );
  }

  let branches: Array<{ id: string; name: string }> = [];
  let readFailed = false;
  try {
    ({ branches } = await pharmacyReportsRouter.createCaller(ctx).branches());
  } catch {
    readFailed = true;
  }

  const query = await searchParams;
  const branchId = value(query.branch)?.trim();
  const fromText = value(query.from);
  const toText = value(query.to);
  const from = dateOnly(fromText);
  const to = dateOnly(toText);
  // Picked days run midnight to midnight in the organisation's zone, like cash flow and margin comparison.
  const timeZone = ctx.organization?.timezone;
  const zone = workspaceZoneLabel(timeZone);
  const pageText = value(query.page) ?? '1';
  const page = /^\d+$/.test(pageText) ? Number(pageText) : 0;
  const fromInstant = from ? pharmacyCalendarDayRange(fromText!, fromText!, timeZone).from : null;
  const toInstant = to ? pharmacyCalendarDayRange(toText!, toText!, timeZone).from : null;
  const valid =
    !!branchId &&
    branchId.length <= 128 &&
    branches.some((branch) => branch.id === branchId) &&
    !!from &&
    !!to &&
    !!fromInstant &&
    !!toInstant &&
    to > from &&
    // The server limit applies to the converted instants, which a daylight-saving change can stretch.
    toInstant.getTime() - fromInstant.getTime() <= 92 * 86_400_000 &&
    Number.isSafeInteger(page) &&
    page >= 1 &&
    page <= 10_000;

  let evidence: JournalEvidencePage | null = null;
  if (valid && !readFailed) {
    try {
      const result = await pharmacyFinanceRouter.createCaller(ctx).financialStatements({
        branchId,
        from: fromInstant.toISOString(),
        to: toInstant.toISOString(),
        page,
      });
      // Prisma Int journal amounts are exact; serialize them without currency conversion.
      // Pass only the authorized page DTO to the client, excluding statement aggregates.
      evidence = {
        from: result.from,
        to: result.to,
        page: result.page,
        journalCount: result.journalCount,
        journal: result.journal.map((entry) => ({
          ...entry,
          lines: entry.lines.map((line) => ({ ...line, amountMinor: String(line.amountMinor) })),
        })),
      };
    } catch {
      readFailed = true;
    }
  }

  const coverage = evidence ? journalEvidenceCoverage(evidence) : null;
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow={screenCopy.journalExport.pharmacyAccounts}
        heading={screenCopy.journalExport.journalEvidenceExport}
        description={screenCopy.journalExport.downloadTheEntriesOnThisPageOtherEntries}
      />
      <SectionCard title={screenCopy.journalExport.evidenceWindow}>
        <form action={ROUTE} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="grid gap-2 text-sm">
            {screenCopy.journalExport.branch}
            <select
              name="branch"
              defaultValue={branches.some((branch) => branch.id === branchId) ? branchId : ''}
              className="min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              required
              disabled={!branches.length}
            >
              <option value="">{screenCopy.journalExport.chooseABranch}</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            {screenCopy.journalExport.fromMidnight}
            {zone}
            {screenCopy.journalExport.closeZone}
            <Input type="date" name="from" defaultValue={fromText} required className="min-h-11" />
          </label>
          <label className="grid gap-2 text-sm">
            {screenCopy.journalExport.untilMidnight}
            {zone}
            {screenCopy.journalExport.closeZoneNotIncluded}
            <Input type="date" name="to" defaultValue={toText} required className="min-h-11" />
          </label>
          <label className="grid gap-2 text-sm">
            {screenCopy.journalExport.page}
            <Input
              type="number"
              min="1"
              max="10000"
              name="page"
              defaultValue={pageText}
              required
              className="min-h-11"
            />
          </label>
          <Button
            type="submit"
            disabled={!branches.length}
            className="min-h-11 sm:col-span-2 lg:col-span-4 lg:justify-self-start"
          >
            {screenCopy.journalExport.readAuthorizedPage}
          </Button>
        </form>
      </SectionCard>
      {!valid && !readFailed ? (
        <State title={screenCopy.journalExport.chooseAValidEvidenceWindow}>
          {screenCopy.journalExport.chooseAnAuthorizedBranchAUtcDateWindow}
        </State>
      ) : null}
      {readFailed ? (
        <State title={screenCopy.journalExport.evidenceCouldNotBeRead}>
          {screenCopy.journalExport.accessMayBeDeniedOrTheReadFailed}
        </State>
      ) : null}
      {evidence && coverage ? (
        <SectionCard title={screenCopy.journalExport.entriesOnThisPage}>
          <div className="space-y-3 text-sm">
            <p role="status" className="font-semibold text-text-strong">
              {coverage.pageCoverage === 'partial' ? 'Some entries are missing' : 'Page ready'}{' '}
              {screenCopy.journalExport.otherActivityMayNotBeIncluded}
            </p>
            <ReportDetails>
              <p className="text-text-muted">
                {screenCopy.journalExport.page2}
                {coverage.page} · {coverage.rowsOnPage}
                {screenCopy.journalExport.entriesReturnedPageCap} {coverage.pageCap} ·{' '}
                {coverage.totalEntryCount}
                {screenCopy.journalExport.entriesCountedInTheWindow}
              </p>
              <p className="text-text-muted">
                {screenCopy.journalExport.theCsvContainsOnlyThisPageDtoIt}
              </p>
            </ReportDetails>
            <JournalEvidenceExportButton evidence={evidence} />
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
