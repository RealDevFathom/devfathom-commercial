import { workspaceTimezone } from '@/lib/timezone';
import { SHOP_SCREEN_COPY as screenCopy } from '@/lib/pharmacy/plain-language';
import Link from 'next/link';
import {
  PHARMACY_COPY as copy,
  formatShopTime,
  formatShopPeriod,
  workPackStateLabel,
  plainCopy,
} from '@/lib/pharmacy/plain-language';

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
const sourceNames = copy.workPack.sourceNames;

function Refresh({ fields, retry = false }: { fields: Record<string, string>; retry?: boolean }) {
  return (
    <form action="/pharmacy/reports#daily-work-pack" method="get">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button variant="outline" className="min-h-11" type="submit">
        {retry ? copy.workPack.retry : copy.workPack.refresh}
      </Button>
    </form>
  );
}

export function DailyWorkPackLoading() {
  return (
    <SectionCard id="daily-work-pack" title={copy.workPack.title} titleLevel={2} aria-busy="true">
      <p role="status" className="mb-4 text-sm text-text-muted">
        {copy.workPack.loading}
      </p>
      <Button variant="outline" className="min-h-11" disabled>
        {copy.workPack.refresh}
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
  const shopTime = (value: string | Date | null | undefined) =>
    formatShopTime(value, workspaceTimezone(timeZone));
  let pack: WorkPack | null = null;
  try {
    // Generate as-of on every server read, including GET refresh; never trust a URL timestamp.
    pack = await read({ ...filters, asOf: new Date().toISOString() });
  } catch {
    // A failed/denied read must not expose server errors or erase successful sibling reports.
  }
  if (!pack) {
    return (
      <SectionCard id="daily-work-pack" title={copy.workPack.title} titleLevel={2}>
        <p role="alert" className="mb-4 text-sm text-text-muted">
          {copy.workPack.failed}
        </p>
        <Refresh fields={refreshFields} retry />
      </SectionCard>
    );
  }
  const branchName = (id: string) =>
    branches.find((branch) => branch.id === id)?.name ?? copy.selectedBranch;
  const missingSources = pack.sources
    .filter((source) => source.status === 'unavailable')
    .map((source) => sourceNames[source.kind].toLowerCase());
  const tasks = pack.groups
    .flatMap((group) => group.tasks.map((task) => ({ ...task, group: group.key })))
    .filter((task) => task.evidence.length);
  return (
    <SectionCard
      id="daily-work-pack"
      eyebrow={copy.workPack.preparation}
      title={copy.workPack.title}
      titleLevel={2}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Refresh fields={refreshFields} />
      </div>
      {missingSources.length ? (
        <p role="status" className="mb-4 text-sm text-text-body">
          {screenCopy.workPack.couldNotCheck}
          {missingSources.join(' or ')}
          {screenCopy.workPack.justNowRefreshToTryAgainTheRest}
        </p>
      ) : null}
      {!pack.permissions.financial ? (
        <p className="mb-4 text-sm text-text-muted">{copy.workPack.moneyHidden}</p>
      ) : null}
      <details className="mb-2 text-sm text-text-muted">
        <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-2 focus-visible:outline-ring">
          {copy.workPack.prepared}
        </summary>
        <div className="space-y-2">
          <p>
            {screenCopy.workPack.period}
            {formatShopPeriod(pack.period.from, pack.period.to)}
            {screenCopy.workPack.branches} {pack.scope.branchIds.map(branchName).join(', ')}.
          </p>
          <p className="break-words">
            {screenCopy.workPack.preparedAt}
            {shopTime(pack.readAt)}.
          </p>
          <p>{copy.workPack.explanation}</p>
          <p>{copy.workPack.completeness}</p>
        </div>
      </details>
      {tasks.length ? (
        <ol className="mt-5 divide-y divide-border-subtle">
          {tasks.map((task) => (
            <li key={task.id} className="py-4">
              <h3 className="font-semibold text-text-strong">
                {task.title} · {branchName(task.branchId)}
              </h3>
              <p className="mt-1 text-sm text-text-body">{copy.workPack.results[task.group]}</p>
              <div className="flex flex-wrap gap-x-4">
                {task.nextActions.slice(0, 1).map((action) => (
                  <Link key={action.href} href={action.href} prefetch={false} className={linkClass}>
                    {action.label}
                  </Link>
                ))}
              </div>
              <details className="mt-2">
                <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
                  {copy.details}
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
                      <StatusPill
                        status={evidence.state}
                        label={workPackStateLabel(evidence.state)}
                        tone="neutral"
                      />
                      <div>
                        <a
                          href={`#${encodeURIComponent(sourceAnchor(evidence.sourceId))}`}
                          className={linkClass}
                        >
                          {screenCopy.workPack.sourceLabel}{' '}
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
                                ? `${formatMinor(amount.value)} (currency not confirmed)`
                                : '—'}
                            </dd>
                            <dd className="text-text-muted">{amount.definition}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="break-words text-text-muted">
                        {screenCopy.workPack.observed}
                        {shopTime(evidence.observedAt)}
                        {screenCopy.workPack.computed} {shopTime(evidence.computedAt)}
                        {screenCopy.workPack.secondsSinceLastCheck}{' '}
                        {evidence.freshnessSeconds ?? 'Unavailable'}
                        {screenCopy.workPack.dueOrExpiryTime} {shopTime(evidence.dueAt)}.
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
          {missingSources.length ? copy.workPack.partialEmpty : copy.workPack.nothing}
        </p>
      )}
      <h3 className="mt-6 font-semibold text-text-strong">{screenCopy.workPack.whatWasChecked}</h3>
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
                    : source.status === 'unavailable'
                      ? copy.unavailable
                      : source.returnedRows === 0
                        ? copy.workPack.checked
                        : copy.workPack.reviewItems
                }
                tone={source.status === 'unavailable' ? 'warning' : 'neutral'}
              />
            </div>
            {source.kind === 'expiry' &&
            source.status === 'available' &&
            source.returnedRows === 0 ? (
              <p role="status" className="text-text-muted">
                {screenCopy.workPack.noAvailableUnexpiredStockWasFoundForExpiry}
              </p>
            ) : null}
            {source.kind !== 'expiry' ? (
              <p role="status" className="text-text-muted">
                {source.status === 'unavailable'
                  ? copy.workPack.couldNotCheck
                  : source.returnedRows === 0
                    ? copy.workPack.nothingToActOn
                    : copy.workPack.reviewItems}
              </p>
            ) : null}
            {source.kind === 'expiry' && source.status === 'unavailable' ? (
              <p role="alert" className="text-text-muted">
                {copy.workPack.expiryFailure}
              </p>
            ) : null}
            <details className="text-text-muted">
              <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-2 focus-visible:outline-ring">
                {copy.details}
              </summary>
              <StatusPill
                status={source.coverage}
                label={
                  source.coverage === 'partial'
                    ? plainCopy['workPack.badge.partial']
                    : plainCopy['workPack.badge.unknown']
                }
                tone="warning"
              />
              {source.kind === 'expiry' && source.status === 'unavailable' ? (
                <p className="text-text-muted">{copy.workPack.expiryFailureDetail}</p>
              ) : null}
              <p className="text-text-muted">{source.timeBasis}</p>
              <p className="text-text-muted">
                {screenCopy.workPack.itemsReturned}
                {source.returnedRows ?? 'Unavailable'}
                {screenCopy.workPack.maximumItems} {source.rowLimit ?? 'Not confirmed'}.{' '}
                {source.limitReached ? screenCopy.workPack.limitReached : ''}
              </p>
              <p className="break-words text-text-muted">
                {screenCopy.workPack.window}{' '}
                {source.window
                  ? `${shopTime(source.window.from)} to ${shopTime(source.window.toExclusive)}${screenCopy.workPack.endNotIncluded}`
                  : screenCopy.workPack.selectedDatesNotApplied}
                {screenCopy.workPack.evaluatedAsOf}
                {shopTime(source.evaluatedAsOf)}
                {screenCopy.workPack.readAt}
                {shopTime(source.readAt)}
                {screenCopy.workPack.lastCheck}{' '}
                {source.freshness === 'persisted-unverified'
                  ? copy.workPack.savedCheck
                  : copy.workPack.currentCheck}
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
            </details>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
