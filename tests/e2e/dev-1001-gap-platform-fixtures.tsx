import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';

import PlatformAuditPage from '@/app/platform/(console)/audit/page';
import HealthPage from '@/app/platform/(console)/health/page';
import OrganizationsPage from '@/app/platform/(console)/organizations/page';
import { AiSettingsConsole } from '@/components/platform/ai-settings-console';
import { PlatformCommandForm } from '@/components/platform/platform-command-form';
import { PlatformPageHeading } from '@/components/platform/platform-ui';

const organizations = [
  {
    id: 'fixture-platform-org-a',
    displayName: 'Example Pharmacy',
    slug: 'example-pharmacy',
    primaryContactEmail: 'pharmacy@example.test',
    vertical: 'PHARMACY',
    status: 'ACTIVE',
    deploymentMode: 'SHARED',
    seatLimit: 10,
    package: { name: 'Pharmacy' },
    deployments: [{ status: 'READY' }],
    _count: { users: 2, modules: 4, contracts: 1 },
  },
  {
    id: 'fixture-platform-org-b',
    displayName: 'Example Restaurant',
    slug: 'example-restaurant',
    primaryContactEmail: 'restaurant@example.test',
    vertical: 'RESTAURANT',
    status: 'ONBOARDING',
    deploymentMode: 'SHARED',
    seatLimit: 10,
    package: { name: 'Restaurant' },
    deployments: [],
    _count: { users: 1, modules: 3, contracts: 1 },
  },
];

const database = {
  organization: { findMany: async () => organizations },
  platformAuditLog: { findMany: async () => [] },
  platformUser: { findMany: async () => [] },
  user: { findMany: async () => [] },
};

/** Importer-scoped runner substitutes: these never import a database or credentials. */
export const platformFixtureWithDb = async <T,>(read: (db: typeof database) => T) => read(database);
export const platformFixtureReadAccess = async () => ({
  id: 'fixture-platform-operator',
  role: 'SUPER_ADMIN',
});
export const platformFixtureHealthFilters = {
  safeParse: (filters: { vertical?: string; organizationId?: string; page: number }) => ({
    success: true as const,
    data: filters,
  }),
};
export const platformFixtureReadHealth = async (filters: {
  vertical?: string;
  organizationId?: string;
  page: number;
}) => ({
  filters,
  observedAt: new Date('2026-11-20T09:00:00.000Z'),
  organizations,
  counts: [
    { queue: 'Pharmacy imports', status: 'QUEUED', count: 0, oldestCreatedAt: null },
    { queue: 'Restaurant jobs', status: 'RUNNING', count: 0, oldestCreatedAt: null },
  ],
  alerts: [],
  alertCount: 0,
  workerHeartbeat: { status: 'not instrumented', note: 'Local fixture has no background worker.' },
  integrations: [],
  tenantCount: organizations.length,
  page: 1,
  pageCount: 1,
});

const pages = {
  audit: () => PlatformAuditPage({ searchParams: Promise.resolve({}) }),
  health: () => HealthPage({ searchParams: Promise.resolve({}) }),
  organizations: () => OrganizationsPage({ searchParams: Promise.resolve({}) }),
};

/** Render the real server-page JSX against the explicit local reads above. */
function PlatformPageFixture({ page }: { page: keyof typeof pages }) {
  const [content, setContent] = useState<ReactNode>(null);
  useEffect(() => {
    let active = true;
    void pages[page]().then((result) => {
      if (active) setContent(result);
    });
    return () => {
      active = false;
    };
  }, [page]);
  return content;
}

const command = {
  action: 'fixture.review',
  title: 'Review organization settings',
  description: 'Isolated control fixture. No platform command is sent.',
  fields: [
    {
      name: 'status',
      label: 'Lifecycle status',
      type: 'select',
      required: true,
      defaultValue: 'ACTIVE',
      options: [
        { value: 'ONBOARDING', label: 'Onboarding' },
        { value: 'ACTIVE', label: 'Active' },
        { value: 'SUSPENDED', label: 'Suspended' },
      ],
    },
    {
      name: 'deploymentMode',
      label: 'Deployment mode',
      type: 'select',
      required: true,
      defaultValue: 'SHARED',
      options: [
        { value: 'SHARED', label: 'Shared' },
        { value: 'DEDICATED', label: 'Dedicated' },
      ],
    },
  ],
} satisfies ComponentProps<typeof PlatformCommandForm>;

export const platformScreens: Record<string, ReactNode> = {
  'platform-audit': <PlatformPageFixture page="audit" />,
  'platform-health': <PlatformPageFixture page="health" />,
  'platform-organizations': <PlatformPageFixture page="organizations" />,
  'platform-ai-settings': (
    <>
      <PlatformPageHeading
        eyebrow="Configuration"
        title="AI settings"
        description="Local provider settings fixture."
      />
      <AiSettingsConsole />
    </>
  ),
  'platform-command': <PlatformCommandForm {...command} />,
};

export const platformQueryData: Record<string, unknown> = {
  'aiSettings.get': {
    mode: { value: 'Auto', isOverride: false },
    providerOrder: {
      value: ['anthropic', 'openai', 'bedrock'],
      isOverride: false,
      defaultValue: ['anthropic', 'openai', 'bedrock'],
      defaultSource: 'built-in',
    },
    fallbackEnabled: { value: true, isOverride: false },
    chain: ['anthropic', 'openai', 'bedrock'],
    routing: 'active',
    environmentPreferred: null,
    providers: [],
    month: {
      label: '2026-11',
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
    },
    updatedAt: null,
    updatedBy: null,
    appliesWithinSeconds: 30,
  },
  'aiSettings.listModelPrices': [],
};

export const platformScreenSources: Record<string, string[]> = {
  'platform-audit': ['src/app/platform/(console)/audit/page.tsx'],
  'platform-health': ['src/app/platform/(console)/health/page.tsx'],
  'platform-organizations': ['src/app/platform/(console)/organizations/page.tsx'],
  'platform-ai-settings': ['src/components/platform/ai-settings-console.tsx'],
  'platform-command': ['src/components/platform/platform-command-form.tsx'],
};
