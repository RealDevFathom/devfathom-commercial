import Link from 'next/link';
import { ArrowUpRight, Search } from 'lucide-react';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const query = await searchParams;
  const q = query.q?.trim().slice(0, 100);
  const allowedStatuses = [
    'PROSPECT',
    'ONBOARDING',
    'ACTIVE',
    'GRACE',
    'SUSPENDED',
    'TERMINATED',
    'PURGING',
    'PURGED',
  ] as const;
  const status = allowedStatuses.find((value) => value === query.status);
  const organizations = await withPlatformDb((db) =>
    db.organization.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(q
          ? {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                { legalName: { contains: q, mode: 'insensitive' } },
                { slug: { contains: q, mode: 'insensitive' } },
                { primaryContactEmail: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ status: 'asc' }, { displayName: 'asc' }],
      include: {
        package: { select: { name: true } },
        _count: { select: { users: true, modules: true, contracts: true } },
        deployments: {
          where: { environment: 'production' },
          take: 1,
          select: { status: true },
        },
      },
      take: 250,
    })
  );

  return (
    <div className="mx-auto max-w-[1480px]">
      <PlatformPageHeading
        eyebrow="Organizations / tenant registry"
        title="Organizations"
        description="Every customer workspace, its lifecycle gate, commercial package, and deployment position."
        action={
          <Link
            href="/platform/organizations/new"
            className="inline-flex h-10 items-center gap-2 bg-abyss-900 px-4 text-xs font-semibold text-paper-white"
          >
            Onboard organization
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        }
      />

      <form className="mt-6 grid gap-3 border border-border-default bg-surface-card p-4 sm:grid-cols-[1fr_220px_auto]">
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-text-faint" />
          <input
            name="q"
            defaultValue={q}
            placeholder="Search name, slug, or contact"
            className="h-10 w-full border border-border-default bg-surface-card pl-9 pr-3 text-sm outline-none focus:border-accent-brand"
          />
        </label>
        <select
          name="status"
          defaultValue={status ?? ''}
          className="h-10 border border-border-default bg-surface-card px-3 text-sm outline-none focus:border-accent-brand"
        >
          <option value="">All lifecycle states</option>
          {allowedStatuses.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
        <button className="h-10 bg-abyss-900 px-4 text-xs font-semibold text-paper-white">
          Apply filters
        </button>
      </form>

      <div className="mt-6 overflow-x-auto border border-border-default bg-surface-card">
        <table className="w-full min-w-[900px] text-left">
          <thead className="border-b border-border-default bg-surface-sunken/70 font-mono text-[9px] uppercase tracking-[0.14em] text-text-muted">
            <tr>
              <th className="px-4 py-3 font-semibold">Organization</th>
              <th className="px-4 py-3 font-semibold">Lifecycle</th>
              <th className="px-4 py-3 font-semibold">Package</th>
              <th className="px-4 py-3 font-semibold">Mode</th>
              <th className="px-4 py-3 font-semibold">Deployment</th>
              <th className="px-4 py-3 font-semibold">Seats / modules</th>
              <th className="px-4 py-3 font-semibold">Commercial</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {organizations.map((organization) => (
              <tr key={organization.id} className="transition hover:bg-surface-sunken/50">
                <td className="px-4 py-4">
                  <Link
                    href={`/platform/organizations/${organization.id}`}
                    className="font-semibold hover:text-accent-brand"
                  >
                    {organization.displayName}
                  </Link>
                  <p className="mt-1 font-mono text-[9px] text-text-muted">
                    {organization.slug} · {organization.primaryContactEmail ?? 'No contact'}
                  </p>
                </td>
                <td className="px-4 py-4">
                  <PlatformStatus value={organization.status} />
                </td>
                <td className="px-4 py-4 text-xs">{organization.package?.name ?? 'Unassigned'}</td>
                <td className="px-4 py-4 font-mono text-[10px]">{organization.deploymentMode}</td>
                <td className="px-4 py-4">
                  <PlatformStatus
                    value={organization.deployments[0]?.status ?? 'NOT_PROVISIONED'}
                  />
                </td>
                <td className="px-4 py-4 text-xs">
                  {organization._count.users}/{organization.seatLimit} seats ·{' '}
                  {organization._count.modules} modules
                </td>
                <td className="px-4 py-4 text-xs">
                  {organization._count.contracts} contract
                  {organization._count.contracts === 1 ? '' : 's'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!organizations.length ? (
          <p className="px-5 py-14 text-center text-sm text-text-muted">
            No organizations match these filters.
          </p>
        ) : null}
      </div>
    </div>
  );
}
