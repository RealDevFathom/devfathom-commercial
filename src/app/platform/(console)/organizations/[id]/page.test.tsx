import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrganizationDetailPage from './page';

const mocks = vi.hoisted(() => ({
  requirePlatformRead: vi.fn(),
  withPlatformDb: vi.fn(),
  orgFindUnique: vi.fn(),
  moduleFindMany: vi.fn(),
  packageFindMany: vi.fn(),
  contractFindMany: vi.fn(),
  branchCount: vi.fn(),
  branchFindMany: vi.fn(),
}));

vi.mock('@/lib/platform/page-access', () => ({
  requirePlatformRead: mocks.requirePlatformRead,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CATALOG = [
  { id: 'mod_core', key: 'restaurant-core', name: 'Restaurant Core', category: 'Core' },
  { id: 'mod_pos', key: 'restaurant-pos', name: 'POS and Fulfilment', category: 'Operations' },
  {
    id: 'mod_loyalty',
    key: 'restaurant-loyalty',
    name: 'Customers and Loyalty',
    category: 'Loyalty',
  },
  {
    id: 'mod_insights',
    key: 'restaurant-insights',
    name: 'Restaurant Insights',
    category: 'Insights',
  },
  { id: 'mod_projects', key: 'projects', name: 'Agency Projects', category: 'Delivery' },
];

const PACKAGES = [
  { id: 'pkg_r1', key: 'restaurant-growth', name: 'Restaurant Growth', vertical: 'RESTAURANT' },
  { id: 'pkg_a1', key: 'agency-growth', name: 'Agency Growth', vertical: 'AGENCY' },
];

/** An override row as the page reads it (status plus its activation window). */
function override(moduleId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: `orgmod_${moduleId}`,
    moduleId,
    status,
    startsAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: null,
    ...extra,
  };
}

function organization(overrides: Record<string, unknown> = {}) {
  return {
    id: 'org_1',
    slug: 'northwind',
    displayName: 'Northwind Kitchens',
    legalName: 'Northwind Kitchens Ltd',
    vertical: 'RESTAURANT',
    status: 'ONBOARDING',
    activatedAt: null,
    deploymentMode: 'SHARED',
    packageId: 'pkg_r1',
    seatLimit: 25,
    gracePeriodDays: 0,
    timezone: 'UTC',
    locale: 'en',
    currency: 'USD',
    dataResidency: null,
    primaryContactName: 'Ada Ops',
    primaryContactEmail: 'ops@northwind.test',
    notes: null,
    createdAt: new Date('2026-02-01T09:00:00Z'),
    package: {
      id: 'pkg_r1',
      key: 'restaurant-growth',
      name: 'Restaurant Growth',
      vertical: 'RESTAURANT',
      moduleLinks: [],
    },
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
    deployments: [],
    contracts: [],
    invoices: [],
    lifecycleEvents: [],
    restaurantActivationAcknowledgements: [],
    users: [],
    _count: { users: 3, supportSessions: 0 },
    ...overrides,
  };
}

async function renderDetail({
  org = organization(),
  contracts = [] as Array<{ modules: Array<{ moduleId: string; module: { active: boolean } }> }>,
  branchCount = 0,
} = {}) {
  mocks.orgFindUnique.mockResolvedValue(org);
  mocks.contractFindMany.mockResolvedValue(contracts);
  mocks.branchCount.mockResolvedValue(branchCount);
  mocks.branchFindMany.mockResolvedValue([]);
  return render(await OrganizationDetailPage({ params: Promise.resolve({ id: 'org_1' }) }));
}

/** The module row containing a given module name. */
function moduleRow(name: string) {
  const row = screen.getByText(name).closest('div.grid');
  if (!row) throw new Error(`No module row for ${name}`);
  return within(row as HTMLElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformRead.mockResolvedValue({ role: 'SUPER_ADMIN' });
  mocks.moduleFindMany.mockResolvedValue(CATALOG);
  mocks.packageFindMany.mockResolvedValue(PACKAGES);
  mocks.withPlatformDb.mockImplementation((run: (db: unknown) => Promise<unknown>) =>
    run({
      organization: { findUnique: mocks.orgFindUnique },
      platformModule: { findMany: mocks.moduleFindMany },
      platformPackage: { findMany: mocks.packageFindMany },
      platformContract: { findMany: mocks.contractFindMany },
      restaurantBranch: { count: mocks.branchCount, findMany: mocks.branchFindMany },
    })
  );
});

describe('OrganizationDetailPage vertical presentation', () => {
  it('presents the vertical as immutable and filters lists by it', async () => {
    await renderDetail();

    expect(screen.getByRole('heading', { name: 'Organization type' })).toBeInTheDocument();
    expect(screen.getByText('LOCKED')).toBeInTheDocument();

    // Only the organization's own vertical owns modules it could be granted.
    expect(screen.getByText('POS and Fulfilment')).toBeInTheDocument();
    expect(screen.queryByText('Agency Projects')).toBeNull();

    // The profile form may only offer same-vertical packages.
    const profileForm = screen.getByRole('heading', { name: 'Workspace profile' }).closest('form');
    const options = [...(profileForm?.querySelectorAll('select[name="packageId"] option') ?? [])]
      .map((option) => option.textContent)
      .filter((label) => label !== 'Not set');
    expect(options).toEqual(['Restaurant Growth']);
  });
});

describe('OrganizationDetailPage entitlement limit diagnostics', () => {
  it('shows which bootstrapped key supplied the limit', async () => {
    await renderDetail({
      org: organization({
        package: {
          id: 'pkg_r1',
          key: 'restaurant-growth',
          name: 'Restaurant Growth',
          vertical: 'RESTAURANT',
          moduleLinks: [
            {
              moduleId: 'mod_core',
              limits: { 'sop.templates.max': 25 },
              module: { active: true, key: 'restaurant-core' },
            },
          ],
        },
      }),
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Bootstrapped compatibility key restaurant-core.sop.templates.max resolves to 25'
    );
  });

  it('shows an actionable fault when both supported keys are absent', async () => {
    await renderDetail({
      org: organization({
        package: {
          id: 'pkg_r1',
          key: 'restaurant-growth',
          name: 'Restaurant Growth',
          vertical: 'RESTAURANT',
          moduleLinks: [],
        },
      }),
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'neither sop.templates.max nor restaurant-core.sop.templates.max is set'
    );
  });

  it('distinguishes a deliberate explicit zero', async () => {
    await renderDetail({
      org: organization({
        limits: [{ id: 'limit_1', key: 'sop.templates.max', value: 0, period: null }],
      }),
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Explicit key sop.templates.max resolves to 0'
    );
    expect(screen.getByRole('status')).toHaveTextContent('Zero is a deliberate disable');
  });
});

describe('OrganizationDetailPage effective entitlement source', () => {
  it('reports NONE and offers only Enable when nothing grants the module', async () => {
    await renderDetail();
    const row = moduleRow('Customers and Loyalty');

    expect(row.getByText(/Source: NONE/)).toBeInTheDocument();
    expect(row.getByText('INACTIVE')).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(row.queryByRole('button', { name: 'Use inherited' })).toBeNull();
  });

  it('reports PACKAGE and writes no redundant override when already inherited-enabled', async () => {
    await renderDetail({
      org: organization({
        package: {
          id: 'pkg_r1',
          key: 'restaurant-growth',
          name: 'Restaurant Growth',
          vertical: 'RESTAURANT',
          moduleLinks: [{ moduleId: 'mod_pos', module: { active: true } }],
        },
      }),
    });
    const row = moduleRow('POS and Fulfilment');

    expect(row.getByText(/Source: PACKAGE/)).toBeInTheDocument();
    expect(row.getByText('ACTIVE')).toBeInTheDocument();
    // Enabling again would duplicate the package grant, so it is not offered.
    expect(row.queryByRole('button', { name: 'Enable' })).toBeNull();
    // There is no override row to reset.
    expect(row.queryByRole('button', { name: 'Use inherited' })).toBeNull();
    expect(row.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('reports CONTRACT for a module granted by a live contract only', async () => {
    await renderDetail({
      contracts: [{ modules: [{ moduleId: 'mod_insights', module: { active: true } }] }],
    });
    const row = moduleRow('Restaurant Insights');

    expect(row.getByText(/Source: CONTRACT/)).toBeInTheDocument();
    expect(row.getByText('ACTIVE')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Enable' })).toBeNull();
    expect(row.queryByRole('button', { name: 'Use inherited' })).toBeNull();
  });

  it('ignores a contract grant on an inactive catalog module', async () => {
    await renderDetail({
      contracts: [{ modules: [{ moduleId: 'mod_insights', module: { active: false } }] }],
    });

    expect(moduleRow('Restaurant Insights').getByText(/Source: NONE/)).toBeInTheDocument();
  });

  it('reports OVERRIDE and offers Use inherited once an override row exists', async () => {
    await renderDetail({
      org: organization({ modules: [override('mod_loyalty', 'ENABLED')] }),
    });
    const row = moduleRow('Customers and Loyalty');

    expect(row.getByText(/Source: OVERRIDE/)).toBeInTheDocument();
    expect(row.getByText('ACTIVE')).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Use inherited' })).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Enable' })).toBeNull();
  });

  it('lets an override disable a package-granted module and keeps Enable available', async () => {
    await renderDetail({
      org: organization({
        modules: [override('mod_pos', 'DISABLED')],
        package: {
          id: 'pkg_r1',
          key: 'restaurant-growth',
          name: 'Restaurant Growth',
          vertical: 'RESTAURANT',
          moduleLinks: [{ moduleId: 'mod_pos', module: { active: true } }],
        },
      }),
    });
    const row = moduleRow('POS and Fulfilment');

    // The override is final, so the package default no longer decides the state.
    expect(row.getByText(/Source: OVERRIDE/)).toBeInTheDocument();
    expect(row.getByText('INACTIVE')).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  it('treats an expired override window as disabled', async () => {
    await renderDetail({
      org: organization({
        modules: [
          override('mod_loyalty', 'ENABLED', { expiresAt: new Date('2020-01-01T00:00:00Z') }),
        ],
      }),
    });
    const row = moduleRow('Customers and Loyalty');

    expect(row.getByText('INACTIVE')).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });

  it('never offers to disable or reset the vertical mandatory module', async () => {
    await renderDetail({
      org: organization({
        modules: [override('mod_core', 'ENABLED')],
        package: {
          id: 'pkg_r1',
          key: 'restaurant-growth',
          name: 'Restaurant Growth',
          vertical: 'RESTAURANT',
          moduleLinks: [{ moduleId: 'mod_core', module: { active: true } }],
        },
      }),
    });
    const row = moduleRow('Restaurant Core');

    expect(row.getByText(/mandatory/)).toBeInTheDocument();
    expect(row.getByText('Always enabled')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(row.queryByRole('button', { name: 'Use inherited' })).toBeNull();
  });

  it('still offers Enable for a mandatory module that nothing currently grants', async () => {
    await renderDetail();
    const row = moduleRow('Restaurant Core');

    expect(row.getByText(/Source: NONE/)).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });
});

describe('OrganizationDetailPage vertical correction gating', () => {
  const correctionLabel = 'Correct type to Agency';

  it('offers the correction while onboarding, unactivated, and free of vertical rows', async () => {
    await renderDetail();

    expect(screen.getByRole('button', { name: correctionLabel })).toBeInTheDocument();
    // Lane B requires the replacement package in the same command, and it must
    // belong to the target vertical.
    const form = screen.getByRole('button', { name: correctionLabel }).closest('form');
    const options = [...(form?.querySelectorAll('select[name="packageId"] option') ?? [])].map(
      (option) => option.textContent
    );
    expect(options).toEqual(['Agency Growth']);
    expect(form?.querySelector('input[name="vertical"]')).toHaveValue('AGENCY');
    expect(form?.querySelector('input[name="id"]')).toHaveValue('org_1');
  });

  it('withdraws the correction once the organization has left onboarding', async () => {
    await renderDetail({ org: organization({ status: 'ACTIVE' }) });

    expect(screen.queryByRole('button', { name: correctionLabel })).toBeNull();
  });

  it('withdraws the correction once the organization has been activated', async () => {
    await renderDetail({
      org: organization({ activatedAt: new Date('2026-03-01T00:00:00Z') }),
    });

    expect(screen.queryByRole('button', { name: correctionLabel })).toBeNull();
  });

  it('withdraws the correction once a vertical-owned branch exists', async () => {
    await renderDetail({ branchCount: 1 });

    expect(screen.queryByRole('button', { name: correctionLabel })).toBeNull();
  });

  it('withdraws the correction once a module override row exists', async () => {
    await renderDetail({
      org: organization({ modules: [override('mod_loyalty', 'ENABLED')] }),
    });

    expect(screen.queryByRole('button', { name: correctionLabel })).toBeNull();
  });

  it('explains rather than offering a correction with no target package', async () => {
    mocks.packageFindMany.mockResolvedValue([PACKAGES[0]]);

    await renderDetail();

    expect(screen.queryByRole('button', { name: correctionLabel })).toBeNull();
    expect(screen.getByText(/No active Agency package is published/)).toBeInTheDocument();
  });
});
