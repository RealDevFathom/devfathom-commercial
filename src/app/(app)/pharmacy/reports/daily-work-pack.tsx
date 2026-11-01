import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import {
  coverageLabel,
  formatReportAge,
  formatReportDateTime,
  formatReportPeriod,
  formatReportWindow,
} from './report-format';

type Reader = ReturnType<typeof pharmacyReportsRouter.createCaller>['dailyWorkPack'];
type WorkPack = Awaited<ReturnType<Reader>>;
export type DailyWorkPackProps = {
  read: Reader;
  filters: Omit<Parameters<Reader>[0], 'asOf'>;
  branches: { id: string; name: string }[];
  refreshFields: Record<string, string>;
  /** Workspace IANA zone for displayed times; UTC when missing. */
  timeZone?: string | null;
};

const sourceAnchor = (id: string) => `work-pack-source-${id}`;
const fieldLabel = (key: string) =>
  key
    .replace(/Minor$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
const linkClass =
  'inline-flex min-h-11 items-center break-all text-sm underline focus-visible:outline-2 focus-visible:outline-ring';
const plainWords = (value: string) => {
  const words = value.replace(/[_-]/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
type EvidenceKind =
  WorkPack['groups'][number]['tasks'][number]['evidence'][number]['reference']['kind'];
const referenceNames: Record<EvidenceKind, string> = {
  'stock-kind': 'Stock alert type',
  'stock-signal': 'Stock alert',
  anomaly: 'Flagged activity',
  lot: 'Batch',
  'debit-note': 'Debit note',
  return: 'Supplier return',
};
const sourceNames: Record<WorkPack['sources'][number]['kind'], string> = {
  'stock-dashboard': 'Stock dashboard',
  'stock-digest': 'Your stock digest',
  anomalies: 'Recorded anomalies',
  expiry: 'Expiry advice',
  'supplier-credit': 'Supplier credit',
};

function Refresh({ fields, retry = false }: { fields: Record<string, string>; retry?: boolean }) {
  return (
    <form action="/pharmacy/reports#daily-work-pack" method="get">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button variant="outline" className="min-h-11" type="submit">
        {retry ? 'Retry daily work pack' : 'Refresh daily work pack'}
      </Button>
    </form>
  );
}

export function DailyWorkPackLoading() {
  return (
    <SectionCard id="daily-work-pack" title="Daily work pack" titleLevel={2} aria-busy="true">
      <p role="status" className="mb-4 text-sm text-text-muted">
        Loading the daily work pack. Other reports are still available.
      </p>
      <Button variant="outline" className="min-h-11" disabled>
        Refresh daily work pack
      </Button>
    </SectionCard>
  );
}

/** Server component: reuse the authenticated caller and stream separately from report figures. */
export async function DailyWorkPack({
  read,
  filters,
  branches,
  refreshFields,
  timeZone,
}: DailyWorkPackProps) {
  let pack: WorkPack | null = null;
  try {
    // Generate as-of on every server read, including GET refresh; never trust a URL timestamp.
    pack = await read({ ...filters, asOf: new Date().toISOString() });
  } catch {
    // A failed/denied read must not expose server errors or erase successful sibling reports.
  }
  if (!pack) {
    return (
      <SectionCard id="daily-work-pack" title="Daily work pack" titleLevel={2}>
        <p role="alert" className="mb-4 text-sm text-text-muted">
          The daily work pack could not load. Try again, or ask the pharmacy owner to check your
          access. No data was changed.
        </p>
        <Refresh fields={refreshFields} retry />
      </SectionCard>
    );
  }
  const branchName = (id: string) => branches.find((branch) => branch.id === id)?.name ?? id;
  const tasks = pack.groups.flatMap((group) => group.tasks).filter((task) => task.evidence.length);
  return (
    <SectionCard
      id="daily-work-pack"
      eyebrow="Things to check"
      title="Daily work pack"
      titleLevel={2}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusPill status={coverageLabel(pack.completeness.status)} tone="warning" />
        <Refresh fields={refreshFields} />
      </div>
      <div className="space-y-2 text-sm text-text-muted">
        <p>
          {formatReportPeriod(pack.period.from, pack.period.to)} ·{' '}
          {pack.scope.branchIds.map(branchName).join(', ')} · Updated{' '}
          {formatReportDateTime(pack.readAt, timeZone)}
        </p>
        <p>{pack.completeness.definition}</p>
        <p>
          Refreshing reloads this list; it does not change any data. Supplier, ingredient and batch
          filters do not apply here. A dash (—) means no data, not zero.
        </p>
        {!pack.permissions.financial ? (
          <p>Stock items only. Money-related checks need finance access.</p>
        ) : null}
      </div>
      {tasks.length ? (
        <ol className="mt-5 divide-y divide-border-subtle">
          {tasks.map((task) => (
            <li key={task.id} className="py-4">
              <h3 className="font-semibold text-text-strong">
                {task.title} · {branchName(task.branchId)}
              </h3>
              <div className="flex flex-wrap gap-x-4">
                {task.nextActions.map((action) => (
                  <Link key={action.href} href={action.href} prefetch={false} className={linkClass}>
                    {action.label}
                  </Link>
                ))}
              </div>
              <details className="mt-2">
                <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
                  Details
                </summary>
                <ul className="space-y-4 text-sm text-text-body">
                  {task.evidence.map((evidence) => (
                    <li
                      key={evidence.id}
                      className="min-w-0 space-y-2 border-l border-border-subtle pl-4"
                    >
                      <p className="break-all">
                        {referenceNames[evidence.reference.kind]}:{' '}
                        {evidence.reference.kind === 'stock-kind'
                          ? plainWords(evidence.reference.id)
                          : evidence.reference.id}
                      </p>
                      <StatusPill status={plainWords(evidence.state)} tone="neutral" />
                      <div>
                        <a
                          href={`#${encodeURIComponent(sourceAnchor(evidence.sourceId))}`}
                          className={linkClass}
                        >
                          From:{' '}
                          {
                            sourceNames[
                              pack.sources.find((source) => source.id === evidence.sourceId)!.kind
                            ]
                          }
                        </a>
                      </div>
                      <dl className="space-y-2">
                        {Object.entries(evidence.counts).map(([key, count]) => (
                          <div key={key} className="flex flex-wrap gap-2">
                            <dt className="break-all">{fieldLabel(key)}</dt>
                            <dd className="font-mono tabular-nums">{count}</dd>
                          </div>
                        ))}
                        {evidence.amounts?.map((amount) => (
                          <div key={amount.key}>
                            <dt className="break-all">{fieldLabel(amount.key)}</dt>
                            <dd className="break-words font-mono tabular-nums">
                              {Number.isSafeInteger(amount.value)
                                ? `${formatMinor(amount.value)} (currency unknown)`
                                : '—'}
                            </dd>
                            <dd className="text-text-muted">{amount.definition}</dd>
                          </div>
                        ))}
                      </dl>
                      {evidence.observedAt ||
                      evidence.computedAt ||
                      evidence.freshnessSeconds !== null ||
                      evidence.dueAt ? (
                        <p className="break-words text-text-muted">
                          {[
                            evidence.observedAt
                              ? `Seen ${formatReportDateTime(evidence.observedAt, timeZone)}.`
                              : null,
                            evidence.computedAt
                              ? `Checked ${formatReportDateTime(evidence.computedAt, timeZone)}.`
                              : null,
                            evidence.freshnessSeconds !== null
                              ? `Data was ${formatReportAge(evidence.freshnessSeconds)} old when checked.`
                              : null,
                            evidence.dueAt
                              ? `Due or expires ${formatReportDateTime(evidence.dueAt, timeZone)}.`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        </p>
                      ) : null}
                      {evidence.missingInputs.map((reason) => (
                        <p key={reason} className="text-text-muted">
                          {reason}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
                {Array.from(new Set(task.missingInputs)).map((reason) => (
                  <p key={reason} className="mt-2 text-sm text-text-muted">
                    {reason}
                  </p>
                ))}
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p role="status" className="mt-5 text-sm text-text-muted">
          Nothing to review. This only covers what has been recorded so far; see the notes below.
        </p>
      )}
      <h3 className="mt-6 font-semibold text-text-strong">What this list is based on</h3>
      <ul className="mt-3 divide-y divide-border-subtle">
        {pack.sources.map((source) => (
          <li
            key={source.id}
            id={sourceAnchor(source.id)}
            tabIndex={-1}
            className="space-y-2 py-4 text-sm focus-visible:outline-2 focus-visible:outline-ring"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {sourceNames[source.kind]} · {branchName(source.scope.branchId)}
              </span>
              <StatusPill
                status={source.status === 'unavailable' ? 'Could not load' : 'Loaded'}
                tone={source.status === 'unavailable' ? 'danger' : 'neutral'}
              />
              <StatusPill status={coverageLabel(source.coverage)} tone="warning" />
            </div>
            <p className="text-text-muted">{source.timeBasis}</p>
            <p className="break-words text-text-muted">
              {source.returnedRows !== null ? `Records found: ${source.returnedRows}. ` : ''}
              {source.window
                ? `Covers ${formatReportWindow(source.window.from, source.window.toExclusive, timeZone)}. `
                : ''}
              Checked {formatReportDateTime(source.readAt, timeZone)}.
            </p>
            {Array.from(
              new Set([
                ...source.missingInputs,
                ...pack.missingInputs
                  .filter((item) => item.sourceId === source.id)
                  .map((item) => item.reason),
              ])
            ).map((reason) => (
              <p key={reason} className="text-text-muted">
                {reason}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
