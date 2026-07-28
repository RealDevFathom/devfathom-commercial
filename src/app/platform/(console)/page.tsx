import Link from 'next/link';
import { ArrowUpRight, Building2, CircleDollarSign, Clock3, ServerCog } from 'lucide-react';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

function money(value: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export default async function PlatformOverviewPage() {
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
      db.organization.groupBy({ by: ['status'], _count: { _all: true } }),
      db.platformContract.aggregate({
        where: { status: 'ACTIVE' },
        _sum: { value: true },
        _count: { _all: true },
      }),
      db.platformOpportunity.aggregate({
        where: { stage: { notIn: ['WON', 'LOST'] } },
        _sum: { estimatedValue: true },
        _count: true,
      }),
      db.platformInvoice.aggregate({
        where: { status: { in: ['OVERDUE', 'PARTIALLY_PAID'] } },
        _sum: { total: true },
        _count: { _all: true },
      }),
      db.platformJob.groupBy({ by: ['status'], _count: { _all: true } }),
      db.organization.findMany({
        where: { status: { in: ['PROSPECT', 'ONBOARDING'] } },
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
        where: { status: 'ACTIVE', endDate: { lte: renewalWindow, gte: now } },
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
      organizations: Object.fromEntries(
        organizations.map((entry) => [entry.status, entry._count._all])
      ),
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
      <div className="flex flex-col justify-between gap-5 border-b border-border-default pb-7 md:flex-row md:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent-brand">
            Control room / live ledger
          </p>
          <h1 className="mt-2 font-display text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
            Platform position
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">
            The commercial, tenant, and deployment picture requiring operator attention today.
          </p>
        </div>
        <Link
          href="/platform/organizations/new"
          className="inline-flex h-10 items-center justify-center gap-2 bg-abyss-900 px-4 text-xs font-semibold text-paper-white transition hover:bg-abyss-800"
        >
          Onboard organization
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      <section
        aria-label="Platform metrics"
        className="grid gap-px bg-border-default md:grid-cols-2 xl:grid-cols-4"
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
            <article key={metric.label} className="bg-surface-card px-5 py-6">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-text-muted">
                  {metric.label}
                </p>
                <Icon className="h-4 w-4 text-accent-brand" aria-hidden="true" />
              </div>
              <p className="mt-6 font-display text-3xl font-semibold tracking-[-0.04em]">
                {metric.value}
              </p>
              <p className="mt-2 text-xs text-text-muted">{metric.detail}</p>
            </article>
          );
        })}
      </section>

      <div className="mt-7 grid gap-7 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="border border-border-default bg-surface-card">
          <div className="flex items-end justify-between border-b border-border-subtle px-5 py-4">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
                Manual gate
              </p>
              <h2 className="mt-1 font-display text-xl font-semibold">Activation queue</h2>
            </div>
            <Link
              href="/platform/organizations"
              className="text-xs text-text-muted hover:text-text-strong"
            >
              Review all
            </Link>
          </div>
          {data.activationQueue.length ? (
            <div className="divide-y divide-border-subtle">
              {data.activationQueue.map((organization) => (
                <Link
                  key={organization.id}
                  href={`/platform/organizations/${organization.id}`}
                  className="grid gap-3 px-5 py-4 transition hover:bg-surface-sunken/60 sm:grid-cols-[1fr_auto_auto] sm:items-center"
                >
                  <div>
                    <p className="text-sm font-semibold">{organization.displayName}</p>
                    <p className="mt-1 font-mono text-[9px] text-text-muted">
                      {organization.slug} · opened {organization.createdAt.toLocaleDateString()}
                    </p>
                  </div>
                  <span className="w-fit border border-border-default px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em]">
                    {organization.deploymentMode}
                  </span>
                  <span className="w-fit bg-brass-100 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-brass-700">
                    {organization.status}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="px-5 py-12 text-center text-sm text-text-muted">
              No organizations are waiting for activation.
            </p>
          )}
        </section>

        <div className="space-y-7">
          <section className="border border-border-default bg-abyss-900 p-5 text-paper-50">
            <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-brass-300">
              <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
              Cash collection
            </div>
            <p className="mt-6 font-display text-4xl font-semibold tracking-[-0.045em]">
              {money(data.overdueValue)}
            </p>
            <p className="mt-2 text-xs leading-5 text-abyss-200">
              Across {data.overdueCount} overdue or partially paid invoices.
            </p>
            <Link
              href="/platform/commercial?view=invoices"
              className="mt-7 inline-flex items-center gap-2 border border-white/15 px-3 py-2 text-xs text-paper-50 transition hover:bg-white/5"
            >
              Open invoice ledger
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </section>

          <section className="border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-accent-brand">
                Next 90 days
              </p>
              <h2 className="mt-1 font-display text-lg font-semibold">Renewal watch</h2>
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
              <p className="px-5 py-8 text-sm text-text-muted">
                No contract renewals in the window.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
