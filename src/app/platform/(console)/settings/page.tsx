import { Plus } from 'lucide-react';
import { PlatformCommandForm } from '@/components/platform/platform-command-form';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';
import { PlatformMfaCard } from '@/components/platform/platform-mfa-card';
import { AiSettingsConsole } from '@/components/platform/ai-settings-console';
import { AIUsagePanel } from '@/components/platform/ai-usage-panel';
import { readMonthlyAIUsage } from '@/lib/ai/usage';

export default async function PlatformSettingsPage() {
  const actor = await requirePlatformRead('/platform/settings');
  const aiUsage = actor.role === 'SUPER_ADMIN' ? await readMonthlyAIUsage(new Date(), actor) : null;
  const settings = await withPlatformDb((db) =>
    db.platformSetting.findMany({ orderBy: [{ category: 'asc' }, { key: 'asc' }] })
  );
  const runtime = [
    ['Database', Boolean(process.env.DATABASE_URL)],
    ['Auth secret', Boolean(process.env.AUTH_SECRET)],
    ['Base domain', Boolean(process.env.PLATFORM_BASE_DOMAIN)],
    ['Blob storage', Boolean(process.env.BLOB_READ_WRITE_TOKEN)],
    ['Edge config', Boolean(process.env.EDGE_CONFIG)],
    ['Realtime', Boolean(process.env.ABLY_API_KEY)],
    ['Email', Boolean(process.env.EMAIL_SERVER_HOST || process.env.RESEND_API_KEY)],
    ['MFA encryption', Boolean(process.env.PLATFORM_ENCRYPTION_KEY)],
  ] as const;

  return (
    <div className="mx-auto max-w-[1380px]">
      <PlatformPageHeading
        eyebrow="Configuration / platform defaults"
        title="Platform settings"
        description="Versioned operational defaults live in PostgreSQL. Secrets remain in the deployment environment and are never rendered here."
      />
      {actor.role === 'SUPER_ADMIN' ? <AiSettingsConsole /> : null}
      <div className="mt-7 grid gap-7 xl:grid-cols-[1fr_400px]">
        <div className="space-y-7">
          {aiUsage ? <AIUsagePanel usage={aiUsage} /> : null}
          <PlatformMfaCard />
          <section className="border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Runtime readiness</h2>
            </div>
            <div className="grid gap-px bg-border-subtle sm:grid-cols-2 lg:grid-cols-4">
              {runtime.map(([label, ready]) => (
                <div key={label} className="bg-surface-card p-4">
                  <p className="text-xs font-semibold">{label}</p>
                  <div className="mt-3">
                    <PlatformStatus value={ready ? 'READY' : 'PENDING'} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <h2 className="font-display text-xl font-semibold">Configuration registry</h2>
            </div>
            <div className="divide-y divide-border-subtle">
              {settings.map((setting) => (
                <details key={setting.id} className="group">
                  <summary className="grid cursor-pointer list-none gap-3 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div>
                      <p className="text-xs font-semibold">{setting.key}</p>
                      <p className="mt-1 text-[10px] text-text-muted">
                        {setting.category} · {setting.description ?? 'No description'}
                      </p>
                    </div>
                    <PlatformStatus value={setting.sensitive ? 'REDACTED' : 'ACTIVE'} />
                  </summary>
                  <div className="border-t border-border-subtle bg-surface-sunken/30 px-5">
                    <PlatformCommandForm
                      compact
                      action="setting.upsert"
                      submitLabel="Update setting"
                      fields={[
                        { name: 'key', label: 'Key', required: true, defaultValue: setting.key },
                        {
                          name: 'category',
                          label: 'Category',
                          required: true,
                          defaultValue: setting.category,
                        },
                        {
                          name: 'value',
                          label: 'JSON value',
                          type: 'json',
                          required: true,
                          defaultValue: setting.sensitive
                            ? {}
                            : (setting.value as Record<string, unknown>),
                        },
                        {
                          name: 'description',
                          label: 'Description',
                          type: 'textarea',
                          defaultValue: setting.description,
                        },
                        {
                          name: 'sensitive',
                          label: 'Sensitive',
                          type: 'checkbox',
                          defaultValue: setting.sensitive,
                        },
                      ]}
                    />
                  </div>
                </details>
              ))}
              {!settings.length ? (
                <p className="px-5 py-12 text-center text-sm text-text-muted">
                  No database-backed settings have been created.
                </p>
              ) : null}
            </div>
          </section>
        </div>

        <aside>
          <details open className="group border border-border-default bg-surface-card">
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-xs font-semibold">
              Add setting
              <Plus className="h-4 w-4 transition group-open:rotate-45" />
            </summary>
            <div className="border-t border-border-subtle px-5">
              <PlatformCommandForm
                compact
                action="setting.upsert"
                submitLabel="Save setting"
                fields={[
                  {
                    name: 'key',
                    label: 'Key',
                    required: true,
                    placeholder: 'onboarding.default_grace_days',
                  },
                  { name: 'category', label: 'Category', required: true },
                  {
                    name: 'value',
                    label: 'JSON value',
                    type: 'json',
                    required: true,
                    defaultValue: {},
                  },
                  { name: 'description', label: 'Description', type: 'textarea' },
                  { name: 'sensitive', label: 'Sensitive', type: 'checkbox' },
                ]}
              />
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}
