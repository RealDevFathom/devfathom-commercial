import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { expiryBoardHref, formatReportPeriod, formatReportTimestamp } from './report-helpers';

type Reader = ReturnType<typeof pharmacyReportsRouter.createCaller>['dailyWorkPack'];
type WorkPack = Awaited<ReturnType<Reader>>;
export type DailyWorkPackProps = {
  read: Reader;
  filters: Omit<Parameters<Reader>[0], 'asOf'>;
  branches: { id: string; name: string }[];
  refreshFields: Record<string, string>;
};

const sourceAnchor = (id: string) => `work-pack-source-${id}`;
const fieldLabel = (key: string) =>
  key
    .replace(/Minor$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
const linkClass =
  'inline-flex min-h-11 items-center break-all text-sm underline focus-visible:outline-2 focus-visible:outline-ring';
const sourceNames: Record<WorkPack['sources'][number]['kind'], string> = {
  'stock-dashboard': 'Stock dashboard',
  'stock-digest': 'Your stock digest',
  anomalies: 'Recorded anomalies',
  expiry: 'Expiry advice',
  'supplier-credit': 'Supplier credit',
};

type Source = WorkPack['sources'][number];

/** Plain-words reason and next step when a source could not be read. */
export function unavailableSourceHelp(source: Pick<Source, 'kind' | 'scope'>): {
  reason: string;
  next: { href: string; label: string } | null;
} {
  const branchId = source.scope.branchId;
  switch (source.kind) {
    case 'expiry':
      return {
        reason:
          'Expiry advice could not be read for this branch just now, so stock that is close to expiry is not listed in this pack. Nothing was changed. Check the expiry board directly, or refresh the work pack to try again.',
        next: { href: expiryBoardHref(null, branchId), label: 'Open expiry board' },
      };
    case 'supplier-credit':
      return {
        reason:
          'Supplier returns and credits could not be read for this branch just now. Nothing was changed. Prepare the supplier-credit follow-up directly, or refresh the work pack to try again.',
        next: {
          href: `/pharmacy/reports/supplier-credit-follow-up?${new URLSearchParams({ branch: branchId })}`,
          label: 'Open supplier-credit follow-up',
        },
      };
    case 'anomalies':
      return {
        reason:
          'Recorded anomalies could not be read for this branch just now. Nothing was changed. Review the anomaly signals on this page, or refresh the work pack to try again.',
        next: null,
      };
    default:
      return {
        reason:
          'Stock signals could not be read for this branch just now. Nothing was changed. Check inventory directly, or refresh the work pack to try again.',
        next: { href: '/pharmacy/inventory', label: 'Open inventory' },
      };
  }
}

function sourceSummary(source: Source) {
  if (source.returnedRows === null) return 'Item count unavailable.';
  if (source.returnedRows === 0)
    return 'No items found. That does not prove there is nothing to check.';
  return `${source.returnedRows} ${source.returnedRows === 1 ? 'item' : 'items'} found${
    source.limitReached ? '; more may exist beyond the read limit' : ''
  }.`;
}

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
        Reading permitted work-pack sources. Other reports remain available.
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
          Daily work pack could not load. Source data or report access may be unavailable. Retry
          this read, or ask your workspace administrator to check access. No data was changed.
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
      eyebrow="Read-only preparation"
      title="Daily work pack"
      titleLevel={2}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusPill status={`${pack.completeness.status} coverage`} tone="warning" />
        <Refresh fields={refreshFields} />
      </div>
      <div className="space-y-2 text-sm text-text-muted">
        <p className="text-text-body">
          {formatReportPeriod(pack.period.from, pack.period.to)} ·{' '}
          {pack.scope.branchIds.map(branchName).join(', ')} · checked{' '}
          {formatReportTimestamp(pack.asOf)}
        </p>
        <p>
          A read-only list of things to review today, gathered from stock, expiry, anomaly and
          supplier-credit records. Refresh reads them again; it never changes anything.
        </p>
        {!pack.permissions.financial ? (
          <p>Operational evidence only. Financial sources were not queried for your role.</p>
        ) : null}
        <details>
          <summary className="min-h-11 cursor-pointer py-3 font-medium text-text-body focus-visible:outline-2 focus-visible:outline-ring">
            How this pack is put together
          </summary>
          <div className="space-y-2">
            <p className="break-words">
              Requested period: {pack.period.from} to {pack.period.to}. As of:{' '}
              {formatReportTimestamp(pack.asOf)}. Read at: {formatReportTimestamp(pack.readAt)}.
            </p>
            <p>
              Each source keeps its own time basis below. Supplier, ingredient and batch filters do
              not apply to this pack. Current records are not a historical snapshot.
            </p>
            <p>{pack.completeness.definition}</p>
            <p>
              Refresh rereads existing evidence; it does not refresh domain signals or create
              drafts. No money or time saved is calculated. Amounts use pharmacy integer minor
              units, displayed to two decimal places. Source currency is unknown; — means
              unavailable, not zero.
            </p>
          </div>
        </details>
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
                  Evidence and missing inputs
                </summary>
                <ul className="space-y-4 text-sm text-text-body">
                  {task.evidence.map((evidence) => (
                    <li
                      key={evidence.id}
                      className="min-w-0 space-y-2 border-l border-border-subtle pl-4"
                    >
                      <p className="break-all">
                        {evidence.reference.kind}: {evidence.reference.id}
                      </p>
                      <StatusPill status={evidence.state} tone="neutral" />
                      <div>
                        <a
                          href={`#${encodeURIComponent(sourceAnchor(evidence.sourceId))}`}
                          className={linkClass}
                        >
                          Source:{' '}
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
                      <p className="break-words text-text-muted">
                        Observed: {formatReportTimestamp(evidence.observedAt)}. Computed:{' '}
                        {formatReportTimestamp(evidence.computedAt)}. Source freshness seconds:{' '}
                        {evidence.freshnessSeconds ?? 'Unavailable'}. Source due/expiry time:{' '}
                        {formatReportTimestamp(evidence.dueAt)}.
                      </p>
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
          Nothing to review was found. That is not an all-clear: check which sources could be read
          below.
        </p>
      )}
      <h3 className="mt-6 font-semibold text-text-strong">What this pack could read</h3>
      <ul className="mt-3 divide-y divide-border-subtle">
        {pack.sources.map((source) => {
          const help = source.status === 'unavailable' ? unavailableSourceHelp(source) : null;
          return (
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
                  status={source.status}
                  tone={source.status === 'unavailable' ? 'danger' : 'neutral'}
                />
                <StatusPill status={`${source.coverage} coverage`} tone="warning" />
              </div>
              {help ? (
                <>
                  <p className="text-text-body">{help.reason}</p>
                  {help.next ? (
                    <Link href={help.next.href} prefetch={false} className={linkClass}>
                      {help.next.label}
                    </Link>
                  ) : null}
                </>
              ) : (
                <p className="text-text-body">{sourceSummary(source)}</p>
              )}
              <details>
                <summary className="min-h-11 cursor-pointer py-3 font-medium text-text-body focus-visible:outline-2 focus-visible:outline-ring">
                  Technical detail
                </summary>
                <div className="space-y-2">
                  <p className="text-text-muted">{source.timeBasis}</p>
                  <p className="text-text-muted">
                    Returned rows: {source.returnedRows ?? 'Unavailable'}. Row limit:{' '}
                    {source.rowLimit ?? 'Not established'}.{' '}
                    {source.limitReached ? 'Source cap reached; records may be omitted.' : ''}
                  </p>
                  <p className="break-words text-text-muted">
                    Window:{' '}
                    {source.window
                      ? `${formatReportTimestamp(source.window.from)} to ${formatReportTimestamp(source.window.toExclusive)} (exclusive end)`
                      : 'Not period-bounded'}
                    . Evaluated as of: {formatReportTimestamp(source.evaluatedAsOf)}. Read at:{' '}
                    {formatReportTimestamp(source.readAt)}. Freshness:{' '}
                    {source.freshness === 'persisted-unverified'
                      ? 'Persisted; freshness unverified'
                      : 'Live inputs; not historical'}
                    .
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
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
