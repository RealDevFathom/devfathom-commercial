import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import OrganizationDetailPage from './page';

const mocks = vi.hoisted(() => ({ withPlatformDb: vi.fn() }));

vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));
vi.mock('@/components/platform/support-access-form', () => ({
  SupportAccessForm: () => <div>Support access</div>,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

const modules = [
  {
    id: 'core-id',
    key: 'restaurant-core',
    name: 'Restaurant Core',
    category: 'Core',
    sortOrder: 0,
  },
  {
    id: 'pos-id',
    key: 'restaurant-pos',
    name: 'POS and Fulfilment',
    category: 'Operations',
    sortOrder: 1,
  },
];

function organization(activatedAt: Date | null = null, ready = false) {
  return {
    id: 'org-1',
    slug: 'table-one',
    displayName: 'Table One',
    legalName: 'Table One Limited',
    vertical: 'RESTAURANT',
    status: activatedAt ? 'ACTIVE' : 'ONBOARDING',
    deploymentMode: 'SHARED',
    packageId: 'restaurant-package',
    package: {
      id: 'restaurant-package',
      name: 'Restaurant Essentials',
      key: 'restaurant-essentials',
      vertical: 'RESTAURANT',
      moduleLinks: modules.map((module) => ({ module })),
    },
    activatedAt,
    seatLimit: 10,
    gracePeriodDays: 0,
    timezone: 'Asia/Karachi',
    locale: 'en',
    currency: 'USD',
    dataResidency: null,
    primaryContactName: 'Owner',
    primaryContactEmail: 'owner@example.com',
    notes: null,
    modules: [],
    limits: [],
    usageCounters: [],
    brand: null,
    emailSettings: null,
    domains: [],
    identityConnections: [],
    scimTokens: [],
    scimEvents: [],
    roles: [],
    permissionOverrides: [],
    deployments: ready
      ? [
          {
            id: 'deployment-1',
            environment: 'production',
            mode: 'SHARED',
            provider: 'vercel',
            region: 'iad1',
            status: 'READY',
            projectId: null,
            url: 'https://table-one.example.com',
            databaseRef: null,
            edgeConfigRef: null,
            version: 'v1',
          },
        ]
      : [],
    contracts: [],
    invoices: [],
    lifecycleEvents: [],
    users: ready
      ? [
          {
            id: 'admin-1',
            name: 'Restaurant Admin',
            email: 'admin@example.com',
            role: 'ADMIN',
            status: 'ON_LEAVE',
            title: null,
            department: null,
            organizationRoleId: null,
          },
        ]
      : [],
    _count: { users: ready ? 1 : 0, supportSessions: 0 },
    createdAt: new Date('2026-08-18T00:00:00Z'),
  };
}

function useDatabase(activatedAt: Date | null = null, ready = false) {
  const database = {
    organization: { findUnique: vi.fn().mockResolvedValue(organization(activatedAt, ready)) },
    platformModule: { findMany: vi.fn().mockResolvedValue(modules) },
    platformPackage: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'agency-package', name: 'Agency Growth', vertical: 'AGENCY' },
        {
          id: 'restaurant-package',
          name: 'Restaurant Essentials',
          vertical: 'RESTAURANT',
        },
      ]),
    },
    restaurantBranch: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'branch-1',
          name: 'Main Branch',
          timezone: 'Asia/Karachi',
          active: true,
          isDefault: true,
        },
        {
          id: 'branch-2',
          name: 'Mall Branch',
          timezone: 'Asia/Karachi',
          active: true,
          isDefault: false,
        },
      ]),
    },
  };
  mocks.withPlatformDb.mockImplementation((run: (db: typeof database) => unknown) => run(database));
}

describe('OrganizationDetailPage', () => {
  it('shows restaurant package filtering, branches, and activation preflight', async () => {
    useDatabase();
    render(await OrganizationDetailPage({ params: Promise.resolve({ id: 'org-1' }) }));

    const vertical = screen.getByLabelText(/^Organization type/);
    const packageSelect = screen.getByLabelText(/^Commercial package/);
    expect(vertical).toBeEnabled();
    expect(within(packageSelect).queryByText('Agency Growth')).not.toBeInTheDocument();
    expect(within(packageSelect).getByText('Restaurant Essentials')).toBeInTheDocument();

    fireEvent.change(vertical, { target: { value: 'AGENCY' } });
    expect(within(packageSelect).getByText('Agency Growth')).toBeInTheDocument();
    expect(within(packageSelect).queryByText('Restaurant Essentials')).not.toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Restaurant activation preflight' })).toBeVisible();
    for (const label of [
      'Compatible package',
      'Mandatory core module',
      'Operational restaurant module',
      'Active organization administrator',
      'Ready production deployment',
      'Exactly one default branch',
    ]) {
      expect(screen.getByText(label)).toBeVisible();
    }
    for (const label of ['Active organization administrator', 'Ready production deployment']) {
      expect(within(screen.getByText(label).closest('li')!).getByText('FAILED')).toBeVisible();
    }
    expect(screen.getByText('2 total')).toBeVisible();
    expect(screen.getAllByText('Main Branch').length).toBeGreaterThan(0);
  });

  it('shows active administration and production deployment as ready', async () => {
    useDatabase(null, true);
    render(await OrganizationDetailPage({ params: Promise.resolve({ id: 'org-1' }) }));

    for (const label of ['Active organization administrator', 'Ready production deployment']) {
      expect(within(screen.getByText(label).closest('li')!).getByText('READY')).toBeVisible();
    }
  });

  it('locks organization type after activation and explains why', async () => {
    useDatabase(new Date('2026-08-18T01:00:00Z'));
    render(await OrganizationDetailPage({ params: Promise.resolve({ id: 'org-1' }) }));

    expect(screen.getByLabelText(/^Organization type/)).toBeDisabled();
    expect(screen.getByText('Organization type is locked after activation.')).toBeVisible();
  });
});
