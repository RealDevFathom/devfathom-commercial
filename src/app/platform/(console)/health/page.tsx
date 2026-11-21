import { SelectField as StudioSelect } from '@/components/ui/select-field';
import Link from 'next/link';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { Button } from '@/components/ui/button';
import { requirePlatformRead } from '@/lib/platform/page-access';
import {
  healthFilters,
  readPlatformHealth,
  type HealthStatus,
} from '@/server/routers/platform-health';
import { HealthSnapshot } from './snapshot';

const tones: Record<HealthStatus, StatusTone> = {
  healthy: 'success',
  degraded: 'warning',
  down: 'danger',
  'not configured': 'neutral',
  'not instrumented': 'neutral',
};
const stamp = (date: Date | null) =>
  date ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'No observation';
const age = (date: Date | null, now: Date) =>
  date ? `${Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000))} min` : '—';
const control =
  'min-h-11 w-full rounded-sm border border-border-default bg-surface-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';
const cell = 'px-4 py-3 align-top';
const heading = 'bg-surface-sunken font-mono text-xs uppercase tracking-wide';
const tableRegion =
  'overflow-x-auto rounded-sm border border-border-subtle focus-visible:outline-2 focus-visible:outline-ring';

export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlatformRead('/platform/health');
  const params = await searchParams;
  const parsed = healthFilters.safeParse({
    vertical: params.vertical || undefined,
    organizationId: params.organizationId || undefined,
    page: params.page ? Number(params.page) : 1,
  });
  if (!parsed.success)
    return (
      <SectionCard title="Invalid health filters" titleLevel={2}>
        <p>Choose a supported vertical and organization.</p>
        <Link href="/platform/health" className="underline">
          Clear filters
        </Link>
      </SectionCard>
    );
  const data = await readPlatformHealth(parsed.data);
  function pageHref(page: number) {
    const query = new URLSearchParams({ page: String(page) });
    if (data.filters.vertical) query.set('vertical', data.filters.vertical);
    if (data.filters.organizationId) query.set('organizationId', data.filters.organizationId);
    return `/platform/health?${query}`;
  }
  return (
    <div className="mx-auto max-w-[1480px] space-y-6 text-text-strong">
      <PlatformPageHeading
        eyebrow="Operations / observability"
        title="Platform health"
        description="Read-only queue and integration signals across organizations. Missing instrumentation stays visible."
      />
      <HealthSnapshot observedAt={data.observedAt.toISOString()} />
      <SectionCard title="Scope" titleLevel={2}>
        <form
          action="/platform/health"
          className="grid items-end gap-4 md:grid-cols-[1fr_2fr_auto_auto]"
        >
          <label className="space-y-2 text-sm font-semibold">
            Vertical
            <StudioSelect
              aria-label="Vertical"
              name="vertical"
              defaultValue={data.filters.vertical ?? ''}
              className={control}
            >
              <option value="">All verticals</option>
              <option value="AGENCY">Agency</option>
              <option value="PHARMACY">Pharmacy</option>
              <option value="RESTAURANT">Restaurant</option>
            </StudioSelect>
          </label>
          <label className="space-y-2 text-sm font-semibold">
            Organization
            <StudioSelect
              name="organizationId"
              defaultValue={data.filters.organizationId ?? ''}
              className={control}
            >
              <option value="">All organizations</option>
              {data.organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.displayName}
                </option>
              ))}
            </StudioSelect>
          </label>
          <Button type="submit" className="min-h-11">
            Apply filters
          </Button>
          <Link
            href="/platform/health"
            className="flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Clear
          </Link>
        </form>
      </SectionCard>
      <SectionCard title="Job queues" titleLevel={2}>
        <p className="mb-4 text-sm">
          Counts cover the selected scope. Queue age is time since creation for the oldest queued or
          running job.
        </p>
        <div role="region" aria-label="Job queue counts" tabIndex={0} className={tableRegion}>
          <table className="w-full min-w-[540px] text-left text-sm">
            <thead className={heading}>
              <tr>
                {['Queue', 'Status', 'Count', 'Oldest age'].map((label) => (
                  <th key={label} scope="col" className={cell}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {data.counts.map((item) => (
                <tr key={`${item.queue}-${item.status}`} className="hover:bg-surface-sunken">
                  <th scope="row" className={`${cell} font-medium`}>
                    {item.queue}
                  </th>
                  <td className={cell}>
                    <PlatformStatus value={item.status} />
                  </td>
                  <td className={`${cell} text-right font-mono tabular-nums`}>{item.count}</td>
                  <td className={`${cell} font-mono`}>
                    {['QUEUED', 'RUNNING'].includes(item.status)
                      ? age(item.oldestCreatedAt, data.observedAt)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
      <SectionCard title={`Queue alerts · ${data.alertCount}`} titleLevel={2}>
        <p className="mb-4 text-sm">
          Running longer than 15 minutes, or failed in the last 24 hours (including restaurant DEAD
          jobs). Missing claim times use creation time. Restaurant failures use the final queue
          update time.
        </p>
        {data.alerts.length ? (
          <>
            <div role="region" aria-label="Queue alerts" tabIndex={0} className={tableRegion}>
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className={heading}>
                  <tr>
                    {['Queue', 'Organization', 'Alert', 'Since (UTC)'].map((label) => (
                      <th key={label} scope="col" className={cell}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {data.alerts.map((item) => (
                    <tr key={`${item.queue}-${item.id}`} className="hover:bg-surface-sunken">
                      <td className={cell}>{item.queue}</td>
                      <th scope="row" className={`${cell} font-medium`}>
                        {item.organization}
                      </th>
                      <td className={cell}>
                        <StatusPill
                          status={item.status === 'RUNNING' ? 'Stale running' : item.status}
                          tone="danger"
                        />
                      </td>
                      <td className={`${cell} whitespace-nowrap font-mono text-xs`}>
                        {stamp(item.since)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm">
              Showing {data.alerts.length} of {data.alertCount} alerts; at most 50 per queue, oldest
              created first.
            </p>
          </>
        ) : (
          <p>No stale running or recent failed jobs in this scope.</p>
        )}
      </SectionCard>
      <SectionCard title="Worker heartbeat" titleLevel={2}>
        <StatusPill status={data.workerHeartbeat.status} />
        <p className="mt-3 text-sm">{data.workerHeartbeat.note}</p>
      </SectionCard>
      <SectionCard title="Integration health" titleLevel={2}>
        <p className="mb-4 text-sm">
          One row per organization and integration. Healthy means all configured endpoints meet the
          stated observation rule; mixed or unobserved endpoints are degraded. Contact timestamps
          are separate from success/error outcomes.
        </p>
        {data.integrations.length ? (
          <div role="region" aria-label="Integration health" tabIndex={0} className={tableRegion}>
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead className={heading}>
                <tr>
                  {[
                    'Organization / integration',
                    'Status',
                    'Last success (UTC)',
                    'Last error (UTC)',
                    'Evidence',
                  ].map((label) => (
                    <th key={label} scope="col" className={cell}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {data.integrations.map((item) => (
                  <tr
                    key={`${item.organizationId}-${item.integration}`}
                    className="hover:bg-surface-sunken"
                  >
                    <th scope="row" className={`${cell} min-w-52 font-medium`}>
                      <p>{item.organization}</p>
                      <p className="mt-1">{item.integration}</p>
                      <p className="mt-1 font-mono text-xs">{item.vertical.toLowerCase()}</p>
                    </th>
                    <td className={cell}>
                      <StatusPill status={item.status} tone={tones[item.status]} />
                    </td>
                    <td className={`${cell} whitespace-nowrap font-mono text-xs`}>
                      {['Print bridges', 'Enrolled devices', 'Cameras'].includes(item.integration)
                        ? 'Not instrumented'
                        : stamp(item.lastSuccess)}
                    </td>
                    <td className={`${cell} whitespace-nowrap font-mono text-xs`}>
                      {['Print bridges', 'Enrolled devices', 'Cameras'].includes(item.integration)
                        ? 'Not instrumented'
                        : stamp(item.lastError)}
                    </td>
                    <td className={`${cell} min-w-72 max-w-sm`}>
                      <p>{item.note}</p>
                      {item.lastContact && (
                        <p className="mt-2 font-mono text-xs">
                          Last contact: {stamp(item.lastContact)}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>
            No organizations match these filters. Clear the filters to view other organizations.
          </p>
        )}
        <nav
          aria-label="Integration pages"
          className="mt-4 flex flex-wrap items-center gap-4 text-sm"
        >
          <span>
            {data.tenantCount} organizations · Page {data.page} of {data.pageCount} · 25
            organizations per page
          </span>
          {data.page > 1 && (
            <Link className="underline" href={pageHref(data.page - 1)}>
              Previous
            </Link>
          )}
          {data.page < data.pageCount && (
            <Link className="underline" href={pageHref(data.page + 1)}>
              Next
            </Link>
          )}
        </nav>
      </SectionCard>
    </div>
  );
}
