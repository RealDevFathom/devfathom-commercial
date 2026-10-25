import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import {
  journalEvidenceCsv,
  projectJournalEvidence,
  type JournalEvidenceExport,
} from '@/lib/pharmacy/accounts/journal-evidence-export';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Journal evidence export · Pharmacy accounts' };
const route = '/pharmacy/accounts/journal-evidence-export';
const scalar = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

function validWindow(from: string, to: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return false;
  for (const date of [from, to]) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  }
  const duration = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return duration > 0 && duration <= 92 * 86_400_000;
}

function coverageText(report: JournalEvidenceExport): string {
  if (!report.pageEntryCount) {
    return `Page ${report.page} contains 0 entries; ${report.journalCount} entries match the window.`;
  }
  const first = (report.page - 1) * report.pageLimit + 1;
  const last = first + report.pageEntryCount - 1;
  return report.coverage === 'page_bounded_partial'
    ? `Partial evidence: showing entries ${first}–${last} of ${report.journalCount}; this export is not a complete ledger.`
    : `Showing all ${report.journalCount} matching entries on this page; broader ledger completeness remains unknown.`;
}

export default async function JournalEvidenceExportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const now = new Date();
  const from =
    query.from === undefined
      ? new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
      : (scalar(query.from) ?? '');
  const to =
    query.to === undefined
      ? new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)
      : (scalar(query.to) ?? '');
  const branchId = scalar(query.branch)?.trim() ?? '';
  const requestedPage = query.page === undefined ? '1' : (scalar(query.page) ?? '');
  const page = /^\d+$/.test(requestedPage) ? Number(requestedPage) : 0;
  let report: JournalEvidenceExport | null = null;
  let error: string | null = null;

  if (!branchId) {
    error =
      'Select an explicit authorized active branch. No default branch is used for this report.';
  } else if (!validWindow(from, to) || !Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    error =
      'Choose valid UTC dates with an exclusive end after the start, no more than 92 days apart, and a valid page.';
  } else {
    try {
      const caller = pharmacyFinanceRouter.createCaller(await createTRPCContext());
      const result = await caller.financialStatements({
        branchId,
        from: `${from}T00:00:00Z`,
        to: `${to}T00:00:00Z`,
        page,
      });
      report = projectJournalEvidence(result);
    } catch (cause) {
      error =
        cause instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(cause.code)
          ? 'Owner financial-report permission, Pharmacy Reports access, and an authorized active branch are required.'
          : cause instanceof TRPCError && cause.code === 'BAD_REQUEST'
            ? 'The branch, dates, or page are invalid. No journal evidence was exported.'
            : 'Journal evidence could not be read. No journal evidence was exported; retry the request.';
    }
  }

  const csv = report ? journalEvidenceCsv(report) : null;
  const pageHref = (nextPage: number) =>
    `${route}?${new URLSearchParams({ branch: branchId, from, to, page: String(nextPage) })}`;

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Journal evidence export"
        description="Inspect and export only the selected authorized 25-entry journal page."
      />
      <SectionCard title="Evidence window" titleLevel={2}>
        <form className="grid gap-4 md:grid-cols-2" action={route}>
          <label className="text-sm text-text-body md:col-span-2">
            Active branch ID
            <Input className="mt-1 min-h-11" name="branch" defaultValue={branchId} required />
          </label>
          <label className="text-sm text-text-body">
            From (UTC)
            <Input className="mt-1 min-h-11" type="date" name="from" defaultValue={from} required />
          </label>
          <label className="text-sm text-text-body">
            To, exclusive (UTC)
            <Input className="mt-1 min-h-11" type="date" name="to" defaultValue={to} required />
          </label>
          <input type="hidden" name="page" value="1" />
          <button
            type="submit"
            className="min-h-11 rounded-[3px] bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-ring md:w-fit"
          >
            Read authorized page
          </button>
        </form>
      </SectionCard>
      {error ? (
        <SectionCard title="Evidence unavailable" titleLevel={2}>
          <p role="alert" className="text-sm text-text-muted">
            {error}
          </p>
        </SectionCard>
      ) : null}
      {report && csv !== null ? (
        <SectionCard title="Page-bounded journal evidence" titleLevel={2}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-sm font-semibold text-text-strong">
                {report.journalCount} matching entries · page {report.page} · {report.pageLimit}
                -entry page limit
              </p>
              <p className="mt-2 text-sm text-text-muted">{coverageText(report)}</p>
              <p className="mt-1 text-sm text-text-muted">
                Posted journal evidence only for [{report.from}, {report.to}). Currency and minor
                units remain separate; maturity and overall completeness are unknown.
              </p>
            </div>
            <a
              download={`journal-evidence-${from}-${to}-page-${report.page}.csv`}
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}
              className="inline-flex min-h-11 items-center rounded-[3px] bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-ring"
            >
              Download this page CSV
            </a>
          </div>
          <div className="mt-5 overflow-x-auto rounded-[var(--radius-sm)] border border-border-subtle">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-surface-sunken font-mono text-xs uppercase">
                <tr>
                  {[
                    'Date / entry',
                    'Source / reversal',
                    'Account / side',
                    'Currency',
                    'Signed minor',
                  ].map((heading) => (
                    <th key={heading} className="p-3 text-left">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr
                    key={row.lineId}
                    className="border-t border-border-subtle hover:bg-surface-sunken"
                  >
                    <td className="p-3">
                      <span className="block">{row.occurredAt}</span>
                      <span className="break-all text-xs text-text-muted">{row.entryId}</span>
                    </td>
                    <td className="p-3">
                      <span className="block">{row.sourceKind}</span>
                      <span className="break-all text-xs text-text-muted">
                        {row.sourceId}
                        {row.reversesEntryId ? ` · reverses ${row.reversesEntryId}` : ''}
                      </span>
                    </td>
                    <td className="p-3">
                      {row.accountCode} · {row.side}
                    </td>
                    <td className="p-3 font-mono">{row.currency}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{row.signedMinor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!report.rows.length ? (
            <p className="mt-4 text-sm text-text-muted">
              No journal lines are present on this page. This does not prove that no activity
              occurred.
            </p>
          ) : null}
          <nav aria-label="Journal evidence pages" className="mt-5 flex gap-4 text-sm">
            {report.page > 1 ? (
              <a
                className="min-h-11 underline focus-visible:outline-2 focus-visible:outline-ring"
                href={pageHref(report.page - 1)}
              >
                Previous page
              </a>
            ) : null}
            {report.page * report.pageLimit < report.journalCount ? (
              <a
                className="min-h-11 underline focus-visible:outline-2 focus-visible:outline-ring"
                href={pageHref(report.page + 1)}
              >
                Next page
              </a>
            ) : null}
          </nav>
        </SectionCard>
      ) : null}
    </main>
  );
}
