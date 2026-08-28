import { Plus } from 'lucide-react';
import {
  PlatformCommandButton,
  PlatformCommandForm,
} from '@/components/platform/platform-command-form';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

export default async function CatalogPage() {
  const data = await withPlatformDb(async (db) => {
    const [modules, packages, cameraPresets] = await Promise.all([
      db.platformModule.findMany({
        orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
        include: { _count: { select: { organizations: true, contracts: true } } },
      }),
      db.platformPackage.findMany({
        orderBy: { name: 'asc' },
        include: {
          moduleLinks: { include: { module: true }, orderBy: { module: { sortOrder: 'asc' } } },
          _count: { select: { organizations: true } },
        },
      }),
      db.platformCameraBrandPreset.findMany({
        orderBy: [{ sortOrder: 'asc' }, { familyName: 'asc' }],
      }),
    ]);
    return { modules, packages, cameraPresets };
  });

  return (
    <div className="mx-auto max-w-[1480px]">
      <PlatformPageHeading
        eyebrow="Catalog / commercial entitlements"
        title="Modules and packages"
        description="The product catalog behind contracts and organization entitlements. Package changes are versioned; tenant overrides remain explicit."
      />

      <div className="mt-7 grid gap-7 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-7">
          <section className="border border-border-default bg-surface-card p-5">
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent-brand">
              Camera catalog
            </p>
            <h2 className="mt-1 font-display text-xl font-semibold">Camera brand presets</h2>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              {data.cameraPresets.map((preset) => (
                <PlatformCommandForm
                  key={preset.id}
                  compact
                  action="catalog.camerapreset"
                  submitLabel="Update preset"
                  fields={[
                    { name: 'id', label: 'Preset', type: 'hidden', defaultValue: preset.id },
                    { name: 'key', label: 'Key', required: true, defaultValue: preset.key },
                    {
                      name: 'familyName',
                      label: 'Brand family',
                      required: true,
                      defaultValue: preset.familyName,
                    },
                    {
                      name: 'aliases',
                      label: 'Aliases',
                      type: 'json',
                      required: true,
                      defaultValue: preset.aliases,
                    },
                    {
                      name: 'iconKey',
                      label: 'Icon',
                      required: true,
                      defaultValue: preset.iconKey,
                    },
                    {
                      name: 'rtspPort',
                      label: 'RTSP port',
                      type: 'number',
                      required: true,
                      defaultValue: preset.rtspPort,
                    },
                    {
                      name: 'onvifPort',
                      label: 'ONVIF port',
                      type: 'number',
                      required: true,
                      defaultValue: preset.onvifPort,
                    },
                    {
                      name: 'mainStreamPathTemplate',
                      label: 'Main stream path',
                      required: true,
                      defaultValue: preset.mainStreamPathTemplate,
                    },
                    {
                      name: 'subStreamPathTemplate',
                      label: 'Sub stream path',
                      required: true,
                      defaultValue: preset.subStreamPathTemplate,
                    },
                    {
                      name: 'authSchemeHint',
                      label: 'Authentication',
                      required: true,
                      defaultValue: preset.authSchemeHint,
                    },
                    {
                      name: 'defaultUsernameHint',
                      label: 'Username hint',
                      defaultValue: preset.defaultUsernameHint,
                    },
                    {
                      name: 'credentialNote',
                      label: 'Credential note',
                      required: true,
                      defaultValue: preset.credentialNote,
                    },
                    {
                      name: 'setupNote',
                      label: 'Setup note',
                      required: true,
                      defaultValue: preset.setupNote,
                    },
                    {
                      name: 'active',
                      label: 'Active',
                      type: 'checkbox',
                      defaultValue: preset.active,
                    },
                    {
                      name: 'sortOrder',
                      label: 'Sort order',
                      type: 'number',
                      required: true,
                      defaultValue: preset.sortOrder,
                    },
                  ]}
                />
              ))}
            </div>
          </section>
          <section className="border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent-brand">
                Product surface
              </p>
              <h2 className="mt-1 font-display text-xl font-semibold">Module registry</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[780px] text-left">
                <thead className="bg-surface-sunken/60 font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">
                  <tr>
                    <th className="px-4 py-3">Module</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Route</th>
                    <th className="px-4 py-3">Organizations</th>
                    <th className="px-4 py-3">Contracts</th>
                    <th className="px-4 py-3">State</th>
                    <th className="px-4 py-3 text-right">Manage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {data.modules.map((module) => (
                    <tr key={module.id}>
                      <td className="px-4 py-4">
                        <p className="text-xs font-semibold">{module.name}</p>
                        <p className="mt-1 font-mono text-[9px] text-text-muted">{module.key}</p>
                      </td>
                      <td className="px-4 py-4 text-xs">{module.category}</td>
                      <td className="px-4 py-4 font-mono text-[9px]">
                        {module.routePrefix ?? '—'}
                      </td>
                      <td className="px-4 py-4 text-xs">{module._count.organizations}</td>
                      <td className="px-4 py-4 text-xs">{module._count.contracts}</td>
                      <td className="px-4 py-4">
                        <PlatformStatus value={module.active ? 'ACTIVE' : 'INACTIVE'} />
                      </td>
                      <td className="px-4 py-4 text-right">
                        <details className="relative inline-block text-left">
                          <summary className="cursor-pointer list-none border border-border-default px-3 py-2 text-[10px] font-semibold">
                            Edit
                          </summary>
                          <div className="absolute right-0 z-20 mt-2 w-[min(440px,85vw)] border border-border-default bg-surface-card p-4 shadow-xl">
                            <PlatformCommandForm
                              compact
                              action="catalog.module.upsert"
                              submitLabel="Update module"
                              fields={[
                                {
                                  name: 'id',
                                  label: 'Module',
                                  type: 'hidden',
                                  defaultValue: module.id,
                                },
                                {
                                  name: 'key',
                                  label: 'Module key',
                                  required: true,
                                  defaultValue: module.key,
                                },
                                {
                                  name: 'name',
                                  label: 'Name',
                                  required: true,
                                  defaultValue: module.name,
                                },
                                {
                                  name: 'description',
                                  label: 'Description',
                                  type: 'textarea',
                                  defaultValue: module.description,
                                },
                                {
                                  name: 'category',
                                  label: 'Category',
                                  required: true,
                                  defaultValue: module.category,
                                },
                                {
                                  name: 'routePrefix',
                                  label: 'Route prefix',
                                  defaultValue: module.routePrefix,
                                },
                                { name: 'icon', label: 'Icon key', defaultValue: module.icon },
                                {
                                  name: 'sortOrder',
                                  label: 'Sort order',
                                  type: 'number',
                                  min: 0,
                                  defaultValue: module.sortOrder,
                                },
                                {
                                  name: 'active',
                                  label: 'Active',
                                  type: 'checkbox',
                                  defaultValue: module.active,
                                },
                              ]}
                            />
                          </div>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="border border-border-default bg-surface-card">
            <div className="border-b border-border-subtle px-5 py-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent-brand">
                Commercial packaging
              </p>
              <h2 className="mt-1 font-display text-xl font-semibold">Packages</h2>
            </div>
            <div className="grid gap-px bg-border-subtle lg:grid-cols-2">
              {data.packages.map((item) => {
                const linked = new Map(item.moduleLinks.map((link) => [link.moduleId, link]));
                return (
                  <article key={item.id} className="bg-surface-card p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{item.name}</p>
                        <p className="mt-1 font-mono text-[9px] text-text-muted">
                          {item.key} · version {item.version}
                        </p>
                      </div>
                      <PlatformStatus value={item.active ? 'ACTIVE' : 'INACTIVE'} />
                    </div>
                    <p className="mt-3 text-xs leading-5 text-text-muted">
                      {item.description ?? 'No package description.'}
                    </p>
                    <div className="mt-5 flex items-center justify-between border-y border-border-subtle py-3 text-xs">
                      <span>{item.defaultSeats} default seats</span>
                      <span>{item._count.organizations} organizations</span>
                    </div>
                    <div className="mt-4 space-y-2">
                      {data.modules.map((module) => {
                        const link = linked.get(module.id);
                        return (
                          <div key={module.id} className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-xs">{module.name}</p>
                              <p className="font-mono text-[8px] text-text-faint">
                                {module.category}
                              </p>
                            </div>
                            <PlatformCommandButton
                              action="catalog.package.module"
                              label={link?.enabled ? 'Included' : 'Add'}
                              tone="quiet"
                              payload={{
                                packageId: item.id,
                                moduleId: module.id,
                                enabled: !link?.enabled,
                                limits: link?.limits ?? null,
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <details className="mt-5 border-t border-border-subtle pt-4">
                      <summary className="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                        Edit package
                      </summary>
                      <PlatformCommandForm
                        compact
                        action="catalog.package.upsert"
                        submitLabel="Update package"
                        fields={[
                          {
                            name: 'id',
                            label: 'Package',
                            type: 'hidden',
                            defaultValue: item.id,
                          },
                          {
                            name: 'key',
                            label: 'Package key',
                            required: true,
                            defaultValue: item.key,
                          },
                          {
                            name: 'name',
                            label: 'Name',
                            required: true,
                            defaultValue: item.name,
                          },
                          {
                            name: 'description',
                            label: 'Description',
                            type: 'textarea',
                            defaultValue: item.description,
                          },
                          {
                            name: 'defaultSeats',
                            label: 'Default seats',
                            type: 'number',
                            required: true,
                            min: 1,
                            defaultValue: item.defaultSeats,
                          },
                          {
                            name: 'active',
                            label: 'Active',
                            type: 'checkbox',
                            defaultValue: item.active,
                          },
                        ]}
                      />
                    </details>
                  </article>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <details open className="group border border-border-default bg-surface-card">
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-xs font-semibold">
              Add camera brand preset
              <Plus className="h-4 w-4 transition group-open:rotate-45" />
            </summary>
            <div className="border-t border-border-subtle px-5">
              <PlatformCommandForm
                compact
                action="catalog.camerapreset"
                submitLabel="Create preset"
                fields={[
                  { name: 'key', label: 'Key', required: true },
                  { name: 'familyName', label: 'Brand family', required: true },
                  {
                    name: 'aliases',
                    label: 'Aliases',
                    type: 'json',
                    required: true,
                    defaultValue: [],
                  },
                  { name: 'iconKey', label: 'Icon', required: true, defaultValue: 'camera' },
                  {
                    name: 'rtspPort',
                    label: 'RTSP port',
                    type: 'number',
                    required: true,
                    defaultValue: 554,
                  },
                  {
                    name: 'onvifPort',
                    label: 'ONVIF port',
                    type: 'number',
                    required: true,
                    defaultValue: 80,
                  },
                  { name: 'mainStreamPathTemplate', label: 'Main stream path', required: true },
                  { name: 'subStreamPathTemplate', label: 'Sub stream path', required: true },
                  {
                    name: 'authSchemeHint',
                    label: 'Authentication',
                    required: true,
                    defaultValue: 'digest',
                  },
                  { name: 'defaultUsernameHint', label: 'Username hint' },
                  { name: 'credentialNote', label: 'Credential note', required: true },
                  { name: 'setupNote', label: 'Setup note', required: true },
                  { name: 'active', label: 'Active', type: 'checkbox', defaultValue: true },
                  {
                    name: 'sortOrder',
                    label: 'Sort order',
                    type: 'number',
                    required: true,
                    defaultValue: 0,
                  },
                ]}
              />
            </div>
          </details>
          <details open className="group border border-border-default bg-surface-card">
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-xs font-semibold">
              Register module
              <Plus className="h-4 w-4 transition group-open:rotate-45" />
            </summary>
            <div className="border-t border-border-subtle px-5">
              <PlatformCommandForm
                compact
                action="catalog.module.upsert"
                submitLabel="Create module"
                fields={[
                  {
                    name: 'key',
                    label: 'Module key',
                    required: true,
                    placeholder: 'workforce.payroll',
                  },
                  { name: 'name', label: 'Name', required: true },
                  { name: 'description', label: 'Description', type: 'textarea' },
                  { name: 'category', label: 'Category', required: true },
                  { name: 'routePrefix', label: 'Route prefix', placeholder: '/payroll' },
                  { name: 'icon', label: 'Icon key' },
                  { name: 'active', label: 'Active', type: 'checkbox', defaultValue: true },
                  {
                    name: 'sortOrder',
                    label: 'Sort order',
                    type: 'number',
                    defaultValue: 0,
                    min: 0,
                  },
                ]}
              />
            </div>
          </details>

          <details open className="group border border-border-default bg-surface-card">
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-xs font-semibold">
              Create package
              <Plus className="h-4 w-4 transition group-open:rotate-45" />
            </summary>
            <div className="border-t border-border-subtle px-5">
              <PlatformCommandForm
                compact
                action="catalog.package.upsert"
                submitLabel="Create package"
                fields={[
                  {
                    name: 'key',
                    label: 'Package key',
                    required: true,
                    placeholder: 'agency-growth',
                  },
                  { name: 'name', label: 'Name', required: true },
                  { name: 'description', label: 'Description', type: 'textarea' },
                  {
                    name: 'defaultSeats',
                    label: 'Default seats',
                    type: 'number',
                    required: true,
                    min: 1,
                  },
                  { name: 'active', label: 'Active', type: 'checkbox', defaultValue: true },
                ]}
              />
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}
