import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { reportMoney, reportDate, reportLabel } from '@/lib/pharmacy/report-presentation';
import { ReportIdentity } from '@/components/pharmacy/report-identity';
import type { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';

type Reader = ReturnType<typeof pharmacyReportsRouter.createCaller>['dailyWorkPack'];
type WorkPack = Awaited<ReturnType<Reader>>;
export type DailyWorkPackProps = {
  currency?: string | null;
  timezone?: string;
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
  currency,
  timezone = 'UTC',
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
  const branchName = (id: string) => branches.find((branch) => branch.id === id)?.name ?? 'Branch name not recorded';
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
        <p>
          Requested period: {pack.period.from} to {pack.period.to}. Branch scope:{' '}
          {pack.scope.branchIds.map(branchName).join(', ')}.
        </p>
        <p className="break-words">
          As of: {reportDate(pack.asOf, timezone)}. Read at: {reportDate(pack.readAt, timezone)}.
        </p>
        <p>
          Each source keeps its own time basis below. Supplier, ingredient and batch filters do not
          apply to this pack. Current records are not a historical snapshot.
        </p>
        <p>{pack.completeness.definition}</p>
        <p>
          Refresh rereads existing evidence; it does not refresh domain signals or create drafts. No
          money or time saved is calculated. Amounts use pharmacy integer minor units, displayed to
          two decimal places. Currency uses the organization setting ({currency ?? 'not configured'}); — means unavailable, not zero.
        </p>
        {!pack.permissions.financial ? (
          <p>Operational evidence only. Financial sources were not queried for your role.</p>
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
                  Evidence and missing inputs
                </summary>
                <ul className="space-y-4 text-sm text-text-body">
                  {task.evidence.map((evidence) => (
                    <li
                      key={evidence.id}
                      className="min-w-0 space-y-2 border-l border-border-subtle pl-4"
                    >
                      <div className="break-all">
                        <ReportIdentity name={reportLabel(evidence.reference.kind)} id={evidence.reference.id} />
                      </div>
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
                                ? reportMoney(amount.value, currency)
                                : '—'}
                            </dd>
                            <dd className="text-text-muted">{amount.definition}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="break-words text-text-muted">
                        Observed: {reportDate(evidence.observedAt, timezone)}. Computed:{' '}
                        {reportDate(evidence.computedAt, timezone)}. Source freshness seconds:{' '}
                        {evidence.freshnessSeconds ?? 'Unavailable'}. Source due/expiry time:{' '}
                        {reportDate(evidence.dueAt, timezone)}.
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
          No review evidence returned from available sources. This is not an all-clear result; check
          source coverage and unavailable inputs below.
        </p>
      )}
      <h3 className="mt-6 font-semibold text-text-strong">Source coverage and freshness</h3>
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
                tone={source.status === 'unavailable' ? 'danger' : 'neutral'}
              />
              <StatusPill status={`${source.coverage} coverage`} tone="warning" />
            </div>
            <p className="text-text-muted">{source.timeBasis}</p>
            <p className="text-text-muted">
              Returned rows: {source.returnedRows ?? 'Unavailable'}. Row limit:{' '}
              {source.rowLimit ?? 'Not established'}.{' '}
              {source.limitReached ? 'Source cap reached; records may be omitted.' : ''}
            </p>
            <p className="break-words text-text-muted">
              Window:{' '}
              {source.window
                ? `${reportDate(source.window.from, timezone)} to ${reportDate(source.window.toExclusive, timezone)} (end excluded)`
                : 'Not period-bounded'}
              . Evaluated as of: {reportDate(source.evaluatedAsOf, timezone)}. Read at: {reportDate(source.readAt, timezone)}.{' '}
              Freshness:{' '}
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
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
