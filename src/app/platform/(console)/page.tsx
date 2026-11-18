import Link from 'next/link';
import { ArrowUpRight, Building2, CircleDollarSign, Clock3, ServerCog } from 'lucide-react';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';

const verticals = ['AGENCY', 'RESTAURANT', 'PHARMACY'] as const;
const lifecycleStatuses = [
  'PROSPECT',
  'ONBOARDING',
  'ACTIVE',
  'GRACE',
  'SUSPENDED',
  'TERMINATED',
  'PURGING',
  'PURGED',
] as const;

function money(value: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export default async function PlatformOverviewPage() {
  await requirePlatformRead('/platform');
  const data = await withPlatformDb(async (db) => {
    const now = new Date();
    const renewalWindow = new Date(now);
    renewalWindow.setDate(renewalWindow.getDate() + 90);
    const [
      organizations,
      activeContracts,
      pipeline,
      overdueInvoices,
      jobs,
      activationQueue,
      renewals,
    ] = await Promise.all([
      db.organization.groupBy({
        by: ['vertical', 'status'],
        where: { isDemo: false },
        _count: { _all: true },
      }),
      db.platformContract.aggregate({
        where: { status: 'ACTIVE', organization: { isDemo: false } },
        _sum: { value: true },
        _count: { _all: true },
      }),
      db.platformOpportunity.aggregate({
        where: {
          stage: { notIn: ['WON', 'LOST'] },
          OR: [{ convertedOrganizationId: null }, { convertedOrganization: { isDemo: false } }],
        },
        _sum: { estimatedValue: true },
        _count: true,
      }),
      db.platformInvoice.aggregate({
        where: {
          status: { in: ['OVERDUE', 'PARTIALLY_PAID'] },
          organization: { isDemo: false },
        },
        _sum: { total: true },
        _count: { _all: true },
      }),
      db.platformJob.groupBy({
        by: ['status'],
        where: {
          OR: [{ organizationId: null }, { organization: { isDemo: false } }],
        },
        _count: { _all: true },
      }),
      db.organization.findMany({
        where: { isDemo: false, status: { in: ['PROSPECT', 'ONBOARDING'] } },
        orderBy: { createdAt: 'asc' },
        take: 6,
        select: {
          id: true,
          displayName: true,
          slug: true,
          status: true,
          deploymentMode: true,
          createdAt: true,
        },
      }),
      db.platformContract.findMany({
        where: {
          status: 'ACTIVE',
          endDate: { lte: renewalWindow, gte: now },
          organization: { isDemo: false },
        },
        orderBy: { endDate: 'asc' },
        take: 6,
        select: {
          id: true,
          number: true,
          value: true,
          currency: true,
          endDate: true,
          organization: { select: { displayName: true } },
        },
      }),
    ]);

    return {
      organizationCounts: organizations,
      organizations: organizations.reduce<Record<string, number>>((counts, entry) => {
        counts[entry.status] = (counts[entry.status] ?? 0) + entry._count._all;
        return counts;
      }, {}),
      activeContractValue: Number(activeContracts._sum.value ?? 0),
      activeContractCount: activeContracts._count._all,
      pipelineValue: Number(pipeline._sum?.estimatedValue ?? 0),
      pipelineCount: pipeline._count,
      overdueValue: Number(overdueInvoices._sum.total ?? 0),
      overdueCount: overdueInvoices._count._all,
      jobs: Object.fromEntries(jobs.map((entry) => [entry.status, entry._count._all])),
      activationQueue,
      renewals: renewals.map((renewal) => ({ ...renewal, value: Number(renewal.value) })),
    };
  });

  const activeOrganizations = (data.organizations.ACTIVE ?? 0) + (data.organizations.GRACE ?? 0);
  const queuedJobs = (data.jobs.QUEUED ?? 0) + (data.jobs.RUNNING ?? 0);

  return (
    <div className="mx-auto max-w-[1480px]">
      <PlatformPageHeading
        eyebrow="Control room / live ledger"
        title="Platform position"
        description="The organizations, revenue, and operations that need a decision today."
        action={
          <Link
            href="/platform/organizations/new"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-control bg-primary px-4 text-xs font-semibold text-primary-foreground shadow-control-ink transition-all hover:-translate-y-px hover:bg-primary-hover"
          >
            Onboard organization
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        }
      />

      <section
        aria-label="Platform metrics"
        className="grid overflow-hidden rounded-lg border border-border-subtle bg-card shadow-none sm:grid-cols-2 xl:grid-cols-4"
      >
        {[
          {
            label: 'Active organizations',
            value: String(activeOrganizations),
            detail: `${data.organizations.ONBOARDING ?? 0} onboarding`,
            icon: Building2,
          },
          {
            label: 'Contracted value',
            value: money(data.activeContractValue),
            detail: `${data.activeContractCount} active contracts`,
            icon: CircleDollarSign,
          },
          {
            label: 'Open pipeline',
            value: money(data.pipelineValue),
            detail: `${data.pipelineCount} opportunities`,
            icon: ArrowUpRight,
          },
          {
            label: 'Operations queue',
            value: String(queuedJobs),
            detail: `${data.jobs.FAILED ?? 0} failed jobs`,
            icon: ServerCog,
          },
        ].map((metric) => {
          const Icon = metric.icon;
          return (
            <article
              key={metric.label}
              className="studio-kpi-card group min-h-40 border-0 border-b border-border-subtle bg-card p-5 shadow-none last:border-b-0 sm:border-r sm:[&:nth-child(2)]:border-r-0 xl:border-b-0 xl:[&:nth-child(2)]:border-r xl:last:border-r-0"
            >
              <div className="studio-kpi-icon">
                <Icon className="size-4" aria-hidden="true" />
              </div>
              <Stat
                label={metric.label}
                value={metric.value}
                sub={metric.detail}
                valueClassName="mt-5 text-[2.15rem]"
              />
            </article>
          );
        })}
      </section>

      <SectionCard title="Organizations by vertical" titleLevel={2} className="mt-6">
        <div
          className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring"
          role="region"
          aria-label="Organization lifecycle counts"
          tabIndex={0}
        >
          <table className="w-full min-w-[960px] text-right text-sm tabular-nums">
            <caption className="mb-4 text-left text-xs text-text-muted">
              Organization counts by lifecycle status. Demo organizations are excluded.
            </caption>
            <thead className="border-b border-border-default font-mono text-[10px] uppercase tracking-wide text-text-muted">
              <tr>
                <th scope="col" className="px-3 py-3 text-left">
                  Vertical
                </th>
                <th scope="col" className="px-3 py-3">
                  Total
                </th>
                {lifecycleStatuses.map((status) => (
                  <th key={status} scope="col" className="px-3 py-3">
                    {status}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {verticals.map((vertical) => {
                const counts = data.organizationCounts.filter(
                  (entry) => entry.vertical === vertical
                );
                return (
                  <tr key={vertical}>
                    <th scope="row" className="px-3 py-4 text-left font-semibold">
                      {vertical.charAt(0) + vertical.slice(1).toLowerCase()}
                    </th>
                    <td className="px-3 py-4 font-semibold">
                      {counts.reduce((total, entry) => total + entry._count._all, 0)}
                    </td>
                    {lifecycleStatuses.map((status) => (
                      <td key={status} className="px-3 py-4">
                        {counts.find((entry) => entry.status === status)?._count._all ?? 0}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]">
        <section className="overflow-hidden rounded-lg border border-border-subtle bg-card shadow-none">
          <div className="flex min-h-20 items-center justify-between gap-4 border-b border-border-subtle px-5 py-4">
            <div>
              <p className="eyebrow text-accent-brand">Manual gate</p>
              <h2 className="mt-1 font-display text-lg font-semibold tracking-tight">
                Activation queue
              </h2>
            </div>
            <Link
              href="/platform/organizations"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-text-muted transition hover:bg-muted hover:text-text-strong"
            >
              Review all
              <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
          {data.activationQueue.length ? (
            <div className="divide-y divide-border-subtle">
              {data.activationQueue.map((organization) => (
                <Link
                  key={organization.id}
                  href={`/platform/organizations/${organization.id}`}
                  className="grid min-h-18 gap-3 px-5 py-4 transition hover:bg-muted/60 sm:grid-cols-[1fr_auto_auto] sm:items-center"
                >
                  <div>
                    <p className="text-sm font-semibold">{organization.displayName}</p>
                    <p className="mt-1 font-mono text-[9px] text-text-muted">
                      {organization.slug} · opened {organization.createdAt.toLocaleDateString()}
                    </p>
                  </div>
                  <span className="w-fit rounded-full bg-muted px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-text-muted">
                    {organization.deploymentMode}
                  </span>
                  <PlatformStatus value={organization.status} />
                </Link>
              ))}
            </div>
          ) : (
            <div className="grid min-h-56 place-items-center px-5 py-12 text-center">
              <div>
                <span className="mx-auto grid size-11 place-items-center rounded-full bg-success/10 text-success">
                  <Building2 className="size-5" />
                </span>
                <p className="mt-4 text-sm font-semibold text-text-strong">
                  Activation queue is clear
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  New organizations will appear here for manual review.
                </p>
              </div>
            </div>
          )}
        </section>

        <div className="space-y-6">
          <section className="rounded-lg border border-primary bg-primary p-5 text-primary-foreground shadow-sm">
            <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-primary-foreground">
              <Clock3 className="size-3.5" aria-hidden="true" />
              Cash collection
            </div>
            <p className="mt-5 font-display text-4xl font-semibold tracking-[-0.045em] text-primary-foreground">
              {money(data.overdueValue)}
            </p>
            <p className="mt-2 text-xs leading-5 text-primary-foreground/62">
              Across {data.overdueCount} overdue or partially paid invoices.
            </p>
            <Link
              href="/platform/commercial?view=invoices"
              className="mt-6 inline-flex min-h-10 items-center gap-2 rounded-full border border-primary-foreground/15 px-3.5 text-xs font-semibold transition hover:bg-primary-foreground/8"
            >
              Open invoice ledger
              <ArrowUpRight className="size-3.5" />
            </Link>
          </section>

          <section className="overflow-hidden rounded-lg border border-border-subtle bg-card shadow-none">
            <div className="border-b border-border-subtle px-5 py-4">
              <p className="eyebrow text-accent-brand">Next 90 days</p>
              <h2 className="mt-1 font-display text-lg font-semibold tracking-tight">
                Renewal watch
              </h2>
            </div>
            {data.renewals.length ? (
              <div className="divide-y divide-border-subtle">
                {data.renewals.map((renewal) => (
                  <div
                    key={renewal.id}
                    className="flex items-center justify-between gap-3 px-5 py-3.5"
                  >
                    <div>
                      <p className="text-xs font-semibold">{renewal.organization.displayName}</p>
                      <p className="mt-1 font-mono text-[9px] text-text-muted">
                        {renewal.number} · {renewal.endDate.toLocaleDateString()}
                      </p>
                    </div>
                    <span className="font-mono text-[10px] font-semibold">
                      {money(renewal.value, renewal.currency)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-5 py-7">
                <p className="text-sm font-semibold text-text-strong">No renewals due</p>
                <p className="mt-1 text-xs text-text-muted">
                  Active contracts are clear for the next 90 days.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
