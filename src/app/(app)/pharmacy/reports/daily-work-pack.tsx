import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { copy, formatDateRange, formatPktTime } from '@/lib/pharmacy/plain-language';
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
        {retry ? copy('workPack.retry') : copy('workPack.refresh')}
      </Button>
    </form>
  );
}

export function DailyWorkPackLoading() {
  return (
    <SectionCard
      id="daily-work-pack"
      title={copy('workPack.title')}
      titleLevel={2}
      aria-busy="true"
    >
      <p role="status" className="mb-4 text-sm text-text-muted">
        {copy('workPack.loading')}
      </p>
      <Button variant="outline" className="min-h-11" disabled>
        {copy('workPack.refresh')}
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
      <SectionCard id="daily-work-pack" title={copy('workPack.title')} titleLevel={2}>
        <p role="alert" className="mb-4 text-sm text-text-muted">
          {copy('workPack.failed')}
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
      eyebrow={copy('workPack.eyebrow')}
      title={copy('workPack.title')}
      titleLevel={2}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusPill
          status={copy(
            pack.completeness.status === 'partial'
              ? 'workPack.badge.partial'
              : 'workPack.badge.unknown'
          )}
          tone="warning"
        />
        <Refresh fields={refreshFields} />
      </div>
      <p className="text-sm text-text-muted">
        {formatDateRange(pack.period.from, pack.period.to)} ·{' '}
        {pack.scope.branchIds.map(branchName).join(', ')} · {copy('workPack.updated')}{' '}
        {formatPktTime(pack.readAt)}
      </p>
      <details className="mt-2 text-sm text-text-muted">
        <summary className="min-h-11 cursor-pointer py-3 font-medium text-text-body focus-visible:outline-2 focus-visible:outline-ring">
          {copy('workPack.details')}
        </summary>
        <div className="space-y-2">
          <p>{copy('workPack.periodNote')}</p>
          <p>{pack.completeness.definition}</p>
          <p>{copy('workPack.refreshNote')}</p>
          <p>{copy('workPack.amountNote')}</p>
          {!pack.permissions.financial ? <p>{copy('workPack.noMoney')}</p> : null}
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
                {task.nextActions.slice(0, 1).map((action) => (
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
                                ? `${formatMinor(amount.value)} (${copy('workPack.currencyUnverified')})`
                                : '—'}
                            </dd>
                            <dd className="text-text-muted">{amount.definition}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="break-words text-text-muted">
                        {copy('workPack.seen')}:{' '}
                        {formatPktTime(evidence.observedAt) || copy('workPack.notAvailable')}.{' '}
                        {copy('workPack.workedOut')}:{' '}
                        {formatPktTime(evidence.computedAt) || copy('workPack.notAvailable')}.{' '}
                        {copy('workPack.dueOrExpires')}:{' '}
                        {formatPktTime(evidence.dueAt) || copy('workPack.notAvailable')}.
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
          {copy('workPack.noResult')}
        </p>
      )}
      <details className="mt-6" open>
        <summary className="min-h-11 cursor-pointer py-3 font-semibold text-text-strong focus-visible:outline-2 focus-visible:outline-ring">
          {copy('workPack.sourcesHeading')}
        </summary>
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
                        ? copy('workPack.couldNotLoad')
                        : source.returnedRows === 0
                          ? copy('workPack.noEligibleStock')
                          : copy('workPack.adviceReady')
                      : undefined
                  }
                  tone={source.status === 'unavailable' ? 'danger' : 'neutral'}
                />
                <StatusPill
                  status={copy(
                    source.coverage === 'partial'
                      ? 'workPack.badge.partial'
                      : 'workPack.badge.unknown'
                  )}
                  tone="warning"
                />
              </div>
              {source.kind === 'expiry' &&
              source.status === 'available' &&
              source.returnedRows === 0 ? (
                <p role="status" className="text-text-muted">
                  No available, unexpired stock was found for expiry advice in this branch. This
                  does not assess expired or quarantined stock. Refresh daily work pack after stock
                  is received or updated.
                </p>
              ) : null}
              <p className="text-text-muted">{source.timeBasis}</p>
              <p className="text-text-muted">
                {copy('workPack.recordsRead')}:{' '}
                {source.returnedRows ?? copy('workPack.notAvailable')}.{' '}
                {source.limitReached ? copy('workPack.limitReached') : ''}
              </p>
              <p className="break-words text-text-muted">
                {copy('workPack.checked')} {formatPktTime(source.readAt)}.{' '}
                {source.freshness === 'persisted-unverified'
                  ? copy('workPack.savedRecords')
                  : copy('workPack.currentRecords')}
              </p>
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
                    source.kind === 'expiry' && source.status === 'unavailable'
                      ? 'alert'
                      : undefined
                  }
                  className="text-text-muted"
                >
                  {reason}
                </p>
              ))}
            </li>
          ))}
        </ul>
      </details>
    </SectionCard>
  );
}
