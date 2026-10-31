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
import { JournalEvidenceExportButton } from './export-button';

export const metadata: Metadata = { title: 'Journal evidence export · Pharmacy accounts' };
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
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy / accounts"
          heading="Journal evidence export"
          description="Export only one authorized journal page with explicit coverage limits."
        />
        <State title="Evidence could not be read">
          Access could not be verified. No CSV is available; retry or ask your workspace
          administrator.
        </State>
      </main>
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
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy / accounts"
          heading="Journal evidence export"
          description="Export only one authorized journal page with explicit coverage limits."
        />
        <State title="Permission required">
          Owner financial-report permission and Pharmacy Reports access are required. No CSV is
          available.
        </State>
      </main>
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
  const pageText = value(query.page) ?? '1';
  const page = /^\d+$/.test(pageText) ? Number(pageText) : 0;
  const valid =
    !!branchId &&
    branchId.length <= 128 &&
    branches.some((branch) => branch.id === branchId) &&
    !!from &&
    !!to &&
    to > from &&
    to.getTime() - from.getTime() <= 92 * 86_400_000 &&
    Number.isSafeInteger(page) &&
    page >= 1 &&
    page <= 10_000;

  let evidence: JournalEvidencePage | null = null;
  if (valid && !readFailed) {
    try {
      const result = await pharmacyFinanceRouter.createCaller(ctx).financialStatements({
        branchId,
        from: from.toISOString(),
        to: to.toISOString(),
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
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy / accounts"
        heading="Journal evidence export"
        description="Export only the authorized journal entries on this page—not a replacement statement or complete ledger."
      />
      <SectionCard title="Evidence window">
        <form action={ROUTE} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="grid gap-2 text-sm">
            Branch
            <select
              name="branch"
              defaultValue={branches.some((branch) => branch.id === branchId) ? branchId : ''}
              className="min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              required
              disabled={!branches.length}
            >
              <option value="">Choose a branch</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            From (UTC)
            <Input type="date" name="from" defaultValue={fromText} required />
          </label>
          <label className="grid gap-2 text-sm">
            To, exclusive (UTC)
            <Input type="date" name="to" defaultValue={toText} required />
          </label>
          <label className="grid gap-2 text-sm">
            Page
            <Input type="number" min="1" max="10000" name="page" defaultValue={pageText} required />
          </label>
          <Button
            type="submit"
            disabled={!branches.length}
            className="min-h-11 sm:col-span-2 lg:col-span-4 lg:justify-self-start"
          >
            Read authorized page
          </Button>
        </form>
      </SectionCard>
      {!valid && !readFailed ? (
        <State title="Choose a valid evidence window">
          Choose an authorized branch, a UTC date window of at most 92 days, and a page from 1 to
          10,000. Invalid input is not read or exported.
        </State>
      ) : null}
      {readFailed ? (
        <State title="Evidence could not be read">
          Access may be denied or the read failed. No CSV is available; retry or ask your workspace
          administrator.
        </State>
      ) : null}
      {evidence && coverage ? (
        <SectionCard title="Page-bounded evidence">
          <div className="space-y-3 text-sm">
            <p role="status" className="font-semibold text-text-strong">
              {coverage.pageCoverage === 'partial'
                ? 'Partial page coverage'
                : 'Requested page returned'}{' '}
              · Coverage unknown beyond posted journal evidence
            </p>
            <p className="text-text-muted">
              Page {coverage.page} · {coverage.rowsOnPage} entries returned · page cap{' '}
              {coverage.pageCap} · {coverage.totalEntryCount} entries counted in the window.
            </p>
            <p className="text-text-muted">
              The CSV contains only this page DTO. It is not a complete-ledger export, is not an
              atomic snapshot, and cannot establish unposted activity. Entry currency, source and
              reversal IDs, and exact integer minor-unit strings are retained.
            </p>
            <JournalEvidenceExportButton evidence={evidence} />
          </div>
        </SectionCard>
      ) : null}
    </main>
  );
}
