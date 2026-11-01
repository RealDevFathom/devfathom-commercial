import Link from 'next/link';
import { Plus } from 'lucide-react';
import {
  PlatformCommandButton,
  PlatformCommandForm,
} from '@/components/platform/platform-command-form';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';

export default async function JobsPage() {
  await requirePlatformRead('/platform/jobs');
  const data = await withPlatformDb(async (db) => {
    const [jobs, organizations] = await Promise.all([
      db.platformJob.findMany({
        orderBy: { createdAt: 'desc' },
        include: { organization: { select: { displayName: true } } },
        take: 300,
      }),
      db.organization.findMany({
        where: { status: { not: 'PURGED' } },
        orderBy: { displayName: 'asc' },
        select: { id: true, displayName: true },
      }),
    ]);
    return { jobs, organizations };
  });

  return (
    <div className="mx-auto max-w-[1480px]">
      <PlatformPageHeading
        eyebrow="Operations / durable work"
        title="Job control"
        description="Provisioning, domains, branding, identity sync, exports, suspension, and data lifecycle tasks with retry state and operator attribution."
        action={
          <Link
            href="/platform/jobs/pharmacy-catalogue"
            className="text-sm underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Pharmacy default catalogue
          </Link>
        }
      />
      <div className="mt-7 grid gap-7 xl:grid-cols-[1fr_380px]">
        <section className="overflow-x-auto border border-border-default bg-surface-card">
          <table className="w-full min-w-[980px] text-left">
            <thead className="bg-surface-sunken/60 font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
              <tr>
                <th className="px-4 py-3">Job</th>
                <th className="px-4 py-3">Organization</th>
                <th className="px-4 py-3">Scheduled</th>
                <th className="px-4 py-3">Attempts</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Control</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {data.jobs.map((job) => (
                <tr key={job.id}>
                  <td className="px-4 py-4">
                    <p className="text-xs font-semibold">{job.type.replaceAll('_', ' ')}</p>
                    <p className="mt-1 max-w-xs truncate font-mono text-[8px] text-text-muted">
                      {job.idempotencyKey ?? job.id}
                    </p>
                    {job.error ? (
                      <p className="mt-2 max-w-sm text-[10px] text-destructive">{job.error}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-4 text-xs">
                    {job.organization?.displayName ?? 'Platform'}
                  </td>
                  <td className="px-4 py-4 font-mono text-[9px]">
                    {job.scheduledAt.toLocaleString()}
                  </td>
                  <td className="px-4 py-4 font-mono text-[10px]">
                    {job.attempts}/{job.maxAttempts}
                  </td>
                  <td className="px-4 py-4">
                    <PlatformStatus value={job.status} />
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex gap-2">
                      {job.status === 'FAILED' ? (
                        <PlatformCommandButton
                          action="job.retry"
                          label="Retry"
                          payload={{ id: job.id }}
                        />
                      ) : null}
                      {job.status === 'QUEUED' || job.status === 'RUNNING' ? (
                        <PlatformCommandButton
                          action="job.cancel"
                          label="Cancel"
                          tone="danger"
                          confirm="Cancel this operation?"
                          payload={{ id: job.id }}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <aside>
          <details open className="group border border-border-default bg-surface-card">
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-xs font-semibold">
              Queue operation
              <Plus className="h-4 w-4 transition group-open:rotate-45" />
            </summary>
            <div className="border-t border-border-subtle px-5">
              <PlatformCommandForm
                compact
                action="job.create"
                submitLabel="Queue job"
                fields={[
                  {
                    name: 'organizationId',
                    label: 'Organization',
                    type: 'select',
                    options: data.organizations.map((item) => ({
                      label: item.displayName,
                      value: item.id,
                    })),
                  },
                  {
                    name: 'type',
                    label: 'Operation',
                    type: 'select',
                    required: true,
                    options: [
                      'PROVISION_SHARED',
                      'PROVISION_DEDICATED',
                      'CONFIGURE_DOMAIN',
                      'APPLY_BRAND',
                      'SYNC_IDENTITY',
                      'EXPORT_DATA',
                      'PURGE_DATA',
                      'SUSPEND',
                      'RESUME',
                      'PHARMACY_DEFAULT_CATALOGUE_V1',
                    ].map((value) => ({ label: value.replaceAll('_', ' '), value })),
                  },
                  { name: 'scheduledAt', label: 'Schedule', type: 'datetime-local' },
                  {
                    name: 'maxAttempts',
                    label: 'Max attempts',
                    type: 'number',
                    defaultValue: 3,
                    min: 1,
                    max: 10,
                  },
                  { name: 'payload', label: 'Payload', type: 'json', defaultValue: {} },
                ]}
              />
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}
