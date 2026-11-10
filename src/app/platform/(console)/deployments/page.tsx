import { PlatformCommandForm } from '@/components/platform/platform-command-form';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';

export default async function DeploymentsPage({
  searchParams,
}: {
  // WHA-1180 — the activation checklist links here with the organization whose
  // production_deployment gate is unmet, so the registration form opens already
  // pointed at it instead of making the operator find it in the list.
  searchParams?: Promise<{ organizationId?: string }>;
}) {
  await requirePlatformRead('/platform/deployments');
  const { organizationId } = (await searchParams) ?? {};
  const data = await withPlatformDb(async (db) => {
    const [deployments, organizations] = await Promise.all([
      db.organizationDeployment.findMany({
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        include: {
          organization: {
            select: { id: true, displayName: true, slug: true, status: true, deploymentMode: true },
          },
        },
        take: 250,
      }),
      db.organization.findMany({
        where: { status: { not: 'PURGED' } },
        orderBy: { displayName: 'asc' },
        select: { id: true, displayName: true, slug: true },
        take: 1_000,
      }),
    ]);
    return { deployments, organizations };
  });
  // Only honoured when it names an organization the operator can already pick,
  // so a crafted query string cannot seed the form with an unknown id.
  const preselectedOrganizationId = data.organizations.some(
    (organization) => organization.id === organizationId
  )
    ? organizationId
    : undefined;

  return (
    <div className="mx-auto max-w-[1480px]">
      <PlatformPageHeading
        eyebrow="Operations / runtime estate"
        title="Deployments"
        description="Shared and dedicated production positions, provider references, health, versions, and activation readiness."
      />
      <details
        open={Boolean(preselectedOrganizationId)}
        className="group mt-7 border border-border-default bg-surface-card"
      >
        <summary className="cursor-pointer list-none px-5 py-4">
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent-brand">
            Runtime registration
          </p>
          <h2 className="mt-1 font-display text-lg font-semibold">Add deployment</h2>
          <p className="mt-1 text-xs text-text-muted">
            Register any environment, or queue automatic production provisioning.
          </p>
        </summary>
        <div className="border-t border-border-subtle px-5">
          <PlatformCommandForm
            compact
            action="deployment.create"
            submitLabel="Create deployment"
            fields={[
              {
                name: 'organizationId',
                label: 'Organization',
                type: 'select',
                required: true,
                defaultValue: preselectedOrganizationId,
                options: data.organizations.map((organization) => ({
                  label: `${organization.displayName} · ${organization.slug}`,
                  value: organization.id,
                })),
              },
              {
                name: 'environment',
                label: 'Environment',
                minLength: 2,
                maxLength: 80,
                // Trimmed on the server; uppercase is not normalized here.
                pattern: '\\s*[a-z0-9][a-z0-9_\\-]*\\s*',
                required: true,
                defaultValue: 'production',
                help: 'Automatic provisioning is available for production only.',
              },
              {
                name: 'mode',
                label: 'Isolation mode',
                type: 'select',
                required: true,
                defaultValue: 'SHARED',
                options: ['SHARED', 'DEDICATED'].map((value) => ({ label: value, value })),
              },
              {
                name: 'provider',
                minLength: 2,
                maxLength: 80,
                label: 'Provider',
                required: true,
                defaultValue: 'VERCEL',
              },
              { name: 'region', maxLength: 5000, label: 'Region' },
              { name: 'databaseRef', maxLength: 5000, label: 'Database reference' },
              {
                name: 'queueProvision',
                label: 'Queue provisioning',
                type: 'checkbox',
                defaultValue: true,
              },
            ]}
          />
        </div>
      </details>
      <div className="mt-7 grid gap-5 xl:grid-cols-2">
        {data.deployments.map((deployment) => (
          <article key={deployment.id} className="border border-border-default bg-surface-card">
            <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
              <div>
                <p className="text-sm font-semibold">{deployment.organization.displayName}</p>
                <p className="mt-1 font-mono text-[9px] text-text-muted">
                  {deployment.organization.slug} · {deployment.environment} · {deployment.mode}
                </p>
              </div>
              <PlatformStatus value={deployment.status} />
            </div>
            <div className="grid grid-cols-2 gap-px bg-border-subtle text-xs">
              {[
                ['Provider', deployment.provider],
                ['Region', deployment.region ?? 'Pending'],
                ['Version', deployment.version ?? 'Pending'],
                ['Healthy', deployment.lastHealthyAt?.toLocaleString() ?? 'Not confirmed'],
              ].map(([label, value]) => (
                <div key={label} className="bg-surface-card p-4">
                  <p className="font-mono text-[8px] uppercase tracking-[0.12em] text-text-muted">
                    {label}
                  </p>
                  <p className="mt-2 truncate">{value}</p>
                </div>
              ))}
            </div>
            <div className="p-5">
              <PlatformCommandForm
                compact
                action="deployment.update"
                submitLabel="Save deployment"
                fields={[
                  { name: 'id', label: 'Deployment', type: 'hidden', defaultValue: deployment.id },
                  {
                    name: 'status',
                    label: 'Status',
                    type: 'select',
                    required: true,
                    defaultValue: deployment.status,
                    options: [
                      'PENDING',
                      'PROVISIONING',
                      'READY',
                      'DEGRADED',
                      'FAILED',
                      'DECOMMISSIONED',
                    ].map((value) => ({ label: value, value })),
                  },
                  {
                    name: 'provider',
                    minLength: 2,
                    maxLength: 80,
                    label: 'Provider',
                    defaultValue: deployment.provider,
                  },
                  {
                    name: 'projectId',
                    maxLength: 5000,
                    label: 'Project ID',
                    defaultValue: deployment.projectId,
                  },
                  {
                    name: 'region',
                    maxLength: 5000,
                    label: 'Region',
                    defaultValue: deployment.region,
                  },
                  {
                    name: 'url',
                    maxLength: 2000,
                    label: 'URL',
                    type: 'url',
                    defaultValue: deployment.url,
                  },
                  {
                    name: 'databaseRef',
                    maxLength: 5000,
                    label: 'Database reference',
                    defaultValue: deployment.databaseRef,
                  },
                  {
                    name: 'edgeConfigRef',
                    maxLength: 5000,
                    label: 'Edge config reference',
                    defaultValue: deployment.edgeConfigRef,
                  },
                  {
                    name: 'version',
                    maxLength: 5000,
                    label: 'Version',
                    defaultValue: deployment.version,
                  },
                ]}
              />
            </div>
          </article>
        ))}
      </div>
      {!data.deployments.length ? (
        <p className="mt-7 border border-border-default bg-surface-card px-5 py-14 text-center text-sm text-text-muted">
          No deployments are registered.
        </p>
      ) : null}
    </div>
  );
}
