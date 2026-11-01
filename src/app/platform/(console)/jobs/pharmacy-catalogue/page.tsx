import Link from 'next/link';
import { PlatformCommandButton } from '@/components/platform/platform-command-form';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { defaultCatalogueOverview, DEFAULT_CATALOGUE_KEY } from '@/lib/pharmacy/default-catalogue';
import { requirePlatformRead } from '@/lib/platform/page-access';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

function skippedForNoVersion(result: unknown): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    (result as Record<string, unknown>).status === 'NO_PUBLISHED_VERSION'
  );
}

export default async function PharmacyDefaultCataloguePage() {
  await requirePlatformRead('/platform/jobs');
  const overview = await withPlatformDb((db) => defaultCatalogueOverview(db));
  const published = overview.versions.find((version) => version.publishedAt);

  return (
    <div className="mx-auto max-w-[1480px]">
      <PlatformPageHeading
        eyebrow="Operations / pharmacy catalogue"
        title="Default medicine catalogue"
        description="The shared platform catalogue each pharmacy is seeded from, and where every pharmacy stands. Copies start with zero stock and are never sold until a pharmacist completes them."
        action={
          <Link
            href="/platform/jobs"
            className="text-sm underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to job control
          </Link>
        }
      />

      <section
        aria-labelledby="catalogue-versions"
        className="mt-7 overflow-x-auto border border-border-default bg-surface-card"
      >
        <h2 id="catalogue-versions" className="px-4 pt-4 text-sm font-semibold">
          Versions of {DEFAULT_CATALOGUE_KEY}
        </h2>
        {overview.versions.length ? (
          <table className="mt-3 w-full min-w-[720px] text-left">
            <thead className="bg-surface-sunken/60 font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
              <tr>
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3 text-right">Items</th>
                <th className="px-4 py-3">Digest</th>
                <th className="px-4 py-3">Published</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {overview.versions.map((version) => (
                <tr key={version.id}>
                  <td className="px-4 py-4 text-xs font-semibold">v{version.version}</td>
                  <td className="px-4 py-4 text-right font-mono text-[10px] tabular-nums">
                    {version.rowCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-4 font-mono text-[9px] text-text-muted">
                    {version.digest.slice(0, 16)}
                  </td>
                  <td className="px-4 py-4">
                    {version.publishedAt ? (
                      <span className="font-mono text-[9px]">
                        {version.publishedAt.toLocaleString()}
                      </span>
                    ) : (
                      <PlatformStatus value="LOADING" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 pb-4 pt-2 text-sm text-text-muted">
            No catalogue is loaded in this environment yet. New pharmacies are still created
            normally; load the seed with <code>pharmacy:catalogue:load</code>, then apply it to
            existing pharmacies with <code>pharmacy:catalogue:backfill --apply --actor &lt;email&gt;</code>.
          </p>
        )}
      </section>

      <section
        aria-labelledby="catalogue-organizations"
        className="mt-7 overflow-x-auto border border-border-default bg-surface-card"
      >
        <h2 id="catalogue-organizations" className="px-4 pt-4 text-sm font-semibold">
          Pharmacies
        </h2>
        {overview.organizationsTruncated ? (
          <p className="px-4 pt-2 text-xs text-text-muted" role="status">
            Showing the first {overview.organizations.length.toLocaleString()} pharmacies by name;
            more exist. Use the backfill dry run for a complete report.
          </p>
        ) : null}
        {overview.organizations.length ? (
          <table className="mt-3 w-full min-w-[980px] text-left">
            <thead className="bg-surface-sunken/60 font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
              <tr>
                <th className="px-4 py-3">Organization</th>
                <th className="px-4 py-3 text-right">Medicines from catalogue</th>
                <th className="px-4 py-3 text-right">Controlled candidates</th>
                <th className="px-4 py-3">Latest apply</th>
                <th className="px-4 py-3">Control</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {overview.organizations.map((organization) => {
                const job = organization.latestJob;
                const skipped = job?.status === 'SUCCEEDED' && skippedForNoVersion(job.result);
                return (
                  <tr key={organization.id}>
                    <td className="px-4 py-4">
                      <p className="text-xs font-semibold">{organization.displayName}</p>
                      <p className="mt-1 font-mono text-[8px] text-text-muted">
                        {organization.status.replaceAll('_', ' ')}
                      </p>
                    </td>
                    <td className="px-4 py-4 text-right font-mono text-[10px] tabular-nums">
                      {organization.held.toLocaleString()}
                      {published ? ` / ${published.rowCount.toLocaleString()}` : ''}
                    </td>
                    <td className="px-4 py-4 text-right font-mono text-[10px] tabular-nums">
                      {organization.controlledCandidates.toLocaleString()}
                    </td>
                    <td className="px-4 py-4">
                      {job ? (
                        <>
                          <PlatformStatus value={skipped ? 'NO_PUBLISHED_VERSION' : job.status} />
                          <p className="mt-1 font-mono text-[9px] text-text-muted">
                            Attempt {job.attempts}/{job.maxAttempts}
                            {job.finishedAt ? ` · ${job.finishedAt.toLocaleString()}` : ''}
                          </p>
                          {job.error ? (
                            <p className="mt-2 max-w-sm text-[10px] text-destructive">
                              {job.error}
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-xs text-text-muted">Never queued</span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex gap-2">
                        {job?.status === 'FAILED' ? (
                          <PlatformCommandButton
                            action="job.retry"
                            label="Retry"
                            payload={{ id: job.id }}
                          />
                        ) : null}
                        {published &&
                        (!job || skipped || job.status === 'SUCCEEDED') &&
                        organization.held < published.rowCount ? (
                          <PlatformCommandButton
                            action="job.create"
                            label="Queue apply"
                            tone="quiet"
                            payload={{
                              organizationId: organization.id,
                              type: 'PHARMACY_DEFAULT_CATALOGUE_V1',
                              maxAttempts: 3,
                              payload: { catalogueKey: DEFAULT_CATALOGUE_KEY },
                            }}
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="px-4 pb-4 pt-2 text-sm text-text-muted">
            No pharmacy organizations exist yet. Each new pharmacy queues the catalogue when it is
            created.
          </p>
        )}
      </section>
    </div>
  );
}
