import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';

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
  const missingSources = pack.sources
    .filter((source) => source.status === 'unavailable')
    .map((source) => sourceNames[source.kind].toLowerCase());
  const tasks = pack.groups.flatMap((group) => group.tasks).filter((task) => task.evidence.length);
  return (
    <SectionCard
      id="daily-work-pack"
      eyebrow="Read-only preparation"
      title="Daily work pack"
      titleLevel={2}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Refresh fields={refreshFields} />
      </div>
      {missingSources.length ? (
        <p role="status" className="mb-4 text-sm text-text-body">
          Could not check {missingSources.join(' or ')} just now. Refresh to try again; the rest of
          this list is still good to use.
        </p>
      ) : null}
      {!pack.permissions.financial ? (
        <p className="mb-4 text-sm text-text-muted">
          Money-related checks are not shown for your role.
        </p>
      ) : null}
      <details className="mb-2 text-sm text-text-muted">
        <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-2 focus-visible:outline-ring">
          How this list was prepared
        </summary>
        <div className="space-y-2">
          <p>
            Period: {pack.period.from} to {pack.period.to}. Branches:{' '}
            {pack.scope.branchIds.map(branchName).join(', ')}.
          </p>
          <p className="break-words">Prepared at {pack.readAt}.</p>
          <p>
            This list only reads your records; it does not change stock or create drafts. Supplier,
            ingredient and batch filters do not apply. Amounts are shown to two decimal places; a
            dash means the figure was not available, not zero.
          </p>
        </div>
      </details>
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
                        Observed: {evidence.observedAt ?? 'Unavailable'}. Computed:{' '}
                        {evidence.computedAt ?? 'Unavailable'}. Source freshness seconds:{' '}
                        {evidence.freshnessSeconds ?? 'Unavailable'}. Source due/expiry time:{' '}
                        {evidence.dueAt ?? 'Unavailable'}.
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
          {missingSources.length
            ? 'Nothing to do from the checks that loaded.'
            : 'Nothing needs your attention right now.'}
        </p>
      )}
      <h3 className="mt-6 font-semibold text-text-strong">What was checked</h3>
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
                status={source.status}
                label={
                  source.kind === 'expiry'
                    ? source.status === 'unavailable'
                      ? 'Could not load'
                      : source.returnedRows === 0
                        ? 'No eligible stock'
                        : 'Advice ready'
                    : undefined
                }
                tone={source.status === 'unavailable' ? 'danger' : 'neutral'}
              />
            </div>
            {source.kind === 'expiry' &&
            source.status === 'available' &&
            source.returnedRows === 0 ? (
              <p role="status" className="text-text-muted">
                No available, unexpired stock was found for expiry advice in this branch. This does
                not assess expired or quarantined stock. Refresh daily work pack after stock is
                received or updated.
              </p>
            ) : null}
            <details className="text-text-muted">
              <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-2 focus-visible:outline-ring">
                Technical details
              </summary>
              <p className="text-text-muted">{source.timeBasis}</p>
              <p className="text-text-muted">
                Returned rows: {source.returnedRows ?? 'Unavailable'}. Row limit:{' '}
                {source.rowLimit ?? 'Not established'}.{' '}
                {source.limitReached ? 'Source cap reached; records may be omitted.' : ''}
              </p>
              <p className="break-words text-text-muted">
                Window:{' '}
                {source.window
                  ? `${source.window.from} to ${source.window.toExclusive} (exclusive end)`
                  : 'Not period-bounded'}
                . Evaluated as of: {source.evaluatedAsOf ?? 'Unavailable'}. Read at: {source.readAt}
                . Freshness:{' '}
                {source.freshness === 'persisted-unverified'
                  ? 'Persisted; freshness unverified'
                  : 'Live inputs; not historical'}
                .
              </p>
            </details>
            {Array.from(
              new Set([
                ...source.missingInputs,
                ...pack.missingInputs
                  .filter((item) => item.sourceId === source.id)
                  .map((item) => item.reason),
              ])
            ).map((reason) => (
              <p
                key={reason}
                role={
                  source.kind === 'expiry' && source.status === 'unavailable' ? 'alert' : undefined
                }
                className="text-text-muted"
              >
                {reason}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
