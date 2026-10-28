import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  journalEvidenceCoverage,
  type JournalEvidencePage,
} from '@/lib/pharmacy/accounts/journal-evidence-export';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';
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
  if (!actor?.session.user || actor.session.user.role !== 'ADMIN') {
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
    !!from &&
    !!to &&
    to > from &&
    to.getTime() - from.getTime() <= 92 * 86_400_000 &&
    Number.isSafeInteger(page) &&
    page >= 1 &&
    page <= 10_000;

  let evidence: JournalEvidencePage | null = null;
  let readFailed = false;
  if (valid) {
    try {
      const ctx = await createTRPCContext({
        session: actor.session,
        organization: actor.organization,
        support: actor.support,
      });
      evidence = await pharmacyFinanceRouter.createCaller(ctx).financialStatements({
        branchId,
        from: from.toISOString(),
        to: to.toISOString(),
        page,
      });
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
            Branch ID
            <Input name="branch" defaultValue={branchId} required />
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
          <Button className="min-h-11 sm:col-span-2 lg:col-span-4 lg:justify-self-start">
            Read authorized page
          </Button>
        </form>
      </SectionCard>
      {!valid ? (
        <State title="Choose a valid evidence window">
          Provide an authorized branch, a UTC date window of at most 92 days, and a page from 1 to
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
