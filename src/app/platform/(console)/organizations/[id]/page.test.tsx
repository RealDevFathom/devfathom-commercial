import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  jobFindFirst: vi.fn(),
  pharmacyReadiness: vi.fn(),
}));

vi.mock('@/lib/pharmacy/onboarding', () => ({
  evaluatePharmacyReadiness: mocks.pharmacyReadiness,
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
    departments: [],
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
      platformJob: { findFirst: mocks.jobFindFirst },
    })
  );
  mocks.jobFindFirst.mockResolvedValue(null);
});

describe('OrganizationDetailPage restricted database reads', () => {
  it('renders required organization data without reading denied support-session counts', async () => {
    mocks.orgFindUnique.mockImplementationOnce(
      async (query: {
        where: { id: string };
        include: { _count?: { select: { users?: boolean; supportSessions?: boolean } } };
      }) => {
        if (query.include._count?.select.supportSessions) {
          throw Object.assign(new Error('permission denied for table platform_support_sessions'), {
            code: '42501',
          });
        }
        return organization({
          _count: query.include._count?.select.users ? { users: 3 } : {},
        });
      }
    );

    await renderDetail();

    expect(screen.getByRole('heading', { name: 'Northwind Kitchens' })).toBeInTheDocument();
    expect(screen.getByText(/Northwind Kitchens Ltd.*3\/25 seats/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Workspace profile' })).toBeInTheDocument();
    expect(screen.getByText('Restaurant readiness')).toBeInTheDocument();
    expect(mocks.orgFindUnique).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { id: 'org_1' },
        include: expect.objectContaining({
          users: expect.objectContaining({
            select: expect.objectContaining({ role: true, status: true }),
          }),
          package: expect.any(Object),
          modules: expect.any(Object),
          deployments: expect.any(Object),
          _count: { select: { users: true } },
        }),
      })
    );
    expect(mocks.requirePlatformRead).toHaveBeenCalledExactlyOnceWith('/platform/organizations');
    expect(mocks.requirePlatformRead.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.withPlatformDb.mock.invocationCallOrder[0]
    );
  });

  it('rejects unauthorized access before opening the platform database scope', async () => {
    const denied = new Error('Platform read denied');
    mocks.requirePlatformRead.mockRejectedValueOnce(denied);

    await expect(renderDetail()).rejects.toBe(denied);

    expect(mocks.requirePlatformRead).toHaveBeenCalledExactlyOnceWith('/platform/organizations');
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
    expect(mocks.orgFindUnique).not.toHaveBeenCalled();
  });

  it('still propagates a database failure on required organization data', async () => {
    const denied = Object.assign(new Error('permission denied for table organizations'), {
      code: '42501',
    });
    mocks.orgFindUnique.mockRejectedValueOnce(denied);

    await expect(renderDetail()).rejects.toBe(denied);
    expect(mocks.orgFindUnique).toHaveBeenCalledTimes(1);
  });
});

describe('OrganizationDetailPage provisioning recovery', () => {
  it('names the failed step, owner, and safe retry without exposing the worker error', async () => {
    mocks.jobFindFirst.mockResolvedValue({
      id: 'job_provision_1',
      type: 'PROVISION_DEDICATED',
      status: 'FAILED',
      attempts: 3,
      maxAttempts: 3,
      error: 'VERCEL_ACCESS_TOKEN=secret-value',
      finishedAt: new Date('2026-09-04T10:30:00Z'),
    });

    await renderDetail();

    const recovery = screen.getByRole('region', { name: 'Provisioning needs operator recovery' });
    expect(recovery).toHaveTextContent('Failed step · Dedicated environment provisioning');
    expect(recovery).toHaveTextContent('Owner: Platform Operations');
    expect(recovery).toHaveTextContent('does not create a second deployment');
    expect(
      within(recovery).getByRole('button', { name: 'Retry provisioning' })
    ).toBeInTheDocument();
    expect(within(recovery).getByRole('link', { name: 'Open Job control' })).toHaveAttribute(
      'href',
      '/platform/jobs'
    );
    expect(recovery).not.toHaveTextContent('secret-value');
  });

  it('does not show recovery guidance when no provisioning job has failed', async () => {
    await renderDetail();

    expect(
      screen.queryByRole('region', { name: 'Provisioning needs operator recovery' })
    ).toBeNull();
  });
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

/**
 * WHA-1180 — the Lifecycle gate panel lists each unmet activation gate as its
 * own checklist row with a link, instead of leaving the operator to read a
 * single banner string after a failed submit.
 */
describe('OrganizationDetailPage activation gate checklist', () => {
  // The shared-host default reads PLATFORM_BASE_DOMAIN at render time, and this
  // project does not set `unstubEnvs`, so each case clears its own stub rather
  // than depending on the order these run in.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The checklist row whose message is `message`. */
  function gateRow(message: string) {
    const row = screen.getByText(message).closest('li');
    if (!row) throw new Error(`No gate row for ${message}`);
    return within(row as HTMLElement);
  }

  const sharedLabel = 'Use shared deployment';

  it('renders one linked row per unmet gate', async () => {
    // The default fixture has a package but no modules, administrator or
    // deployment, so exactly three of the four gates are unmet.
    await renderDetail();

    expect(screen.getByText('Unmet activation gates')).toBeInTheDocument();
    expect(
      gateRow('Enable at least one module.').getByRole('link', { name: 'Review modules' })
    ).toHaveAttribute('href', '/platform/organizations/org_1#modules');
    expect(
      gateRow('Add an active organization administrator.').getByRole('link', {
        name: 'Add administrator',
      })
    ).toHaveAttribute('href', '/platform/organizations/org_1#people');
    expect(
      gateRow('Add a ready production deployment.').getByRole('link', { name: 'Add deployment' })
    ).toHaveAttribute('href', '/platform/deployments?organizationId=org_1');
    // The package IS assigned, so its gate is not listed.
    expect(screen.queryByText('Assign a commercial package.')).toBeNull();
  });

  it('offers the one-click shared default on a shared-host organization', async () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', 'staging.devfathom.com');

    await renderDetail();

    expect(
      gateRow('Add a ready production deployment.').getByRole('button', { name: sharedLabel })
    ).toBeInTheDocument();
    // It is offered on the deployment gate only.
    expect(screen.getAllByRole('button', { name: sharedLabel })).toHaveLength(1);
  });

  it('keeps a custom-domain tenant on the manual path', async () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', 'staging.devfathom.com');

    await renderDetail({ org: organization({ deploymentMode: 'DEDICATED' }) });

    const row = gateRow('Add a ready production deployment.');
    expect(row.queryByRole('button', { name: sharedLabel })).toBeNull();
    expect(row.getByRole('link', { name: 'Add deployment' })).toBeInTheDocument();
  });

  it('omits the shared default when no shared host is configured', async () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', '');

    await renderDetail();

    expect(
      gateRow('Add a ready production deployment.').queryByRole('button', { name: sharedLabel })
    ).toBeNull();
  });

  it('shows no checklist once every gate is satisfied', async () => {
    await renderDetail({
      org: organization({
        package: {
          id: 'pkg_r1',
          key: 'restaurant-growth',
          name: 'Restaurant Growth',
          vertical: 'RESTAURANT',
          moduleLinks: [{ moduleId: 'mod_core', module: { active: true, key: 'restaurant-core' } }],
        },
        users: [
          {
            id: 'user_1',
            name: 'Ada Admin',
            email: 'ada@northwind.test',
            role: 'ADMIN',
            status: 'ACTIVE',
            title: 'Organization administrator',
            department: 'operations',
            organizationRoleId: null,
          },
        ],
        deployments: [
          {
            id: 'dep_1',
            environment: 'production',
            mode: 'SHARED',
            status: 'READY',
            provider: 'VERCEL',
            projectId: null,
            region: 'global',
            url: 'https://northwind.staging.devfathom.com',
            databaseRef: null,
            edgeConfigRef: null,
            version: 'local',
          },
        ],
      }),
    });

    expect(screen.queryByText('Unmet activation gates')).toBeNull();
    expect(screen.queryByText('Add a ready production deployment.')).toBeNull();
    // The lifecycle form itself is untouched by the checklist.
    expect(screen.getByRole('button', { name: 'Apply lifecycle change' })).toBeInTheDocument();
  });

  it('hides the checklist for an organization that can no longer be activated', async () => {
    await renderDetail({ org: organization({ status: 'PURGED' }) });

    expect(screen.queryByText('Unmet activation gates')).toBeNull();
    expect(screen.getByText('This lifecycle is terminal.')).toBeInTheDocument();
  });
});

describe('vertical readiness parity', () => {
  it('offers configured department names and keys instead of agency defaults', async () => {
    const { container } = await renderDetail({
      org: organization({
        departments: [{ key: 'KITCHEN', name: 'Kitchen team' }],
        users: [
          {
            id: 'user_1',
            name: 'Chef',
            email: 'chef@example.test',
            role: 'EMPLOYEE',
            status: 'ACTIVE',
            title: 'Chef',
            department: 'KITCHEN',
            organizationRoleId: null,
          },
        ],
      }),
    });
    const department = container.querySelector('select[name="department"]') as HTMLSelectElement;
    expect(department.value).toBe('KITCHEN');
    expect(within(department).getByRole('option', { name: 'Kitchen team' })).toHaveValue('KITCHEN');
    expect(within(department).queryByRole('option', { name: 'ENGINEERING' })).toBeNull();
  });

  it('shows agency requirements without querying pharmacy evidence', async () => {
    await renderDetail({ org: organization({ vertical: 'AGENCY' }) });
    expect(screen.getByRole('region', { name: 'Agency readiness' })).toHaveTextContent(
      '3 agency activation requirements remain.'
    );
    expect(mocks.pharmacyReadiness).not.toHaveBeenCalled();
  });

  it('shows evaluated pharmacy evidence, including downgraded claims', async () => {
    mocks.pharmacyReadiness.mockResolvedValue({
      ready: false,
      gates: [
        {
          gate: 'OPENING_STOCK_READINESS',
          step: 9,
          label: 'Opening stock readiness',
          status: 'FAILED',
          downgradeReason: 'EVIDENCE_ABSENT',
        },
        {
          gate: 'LEGAL_BUSINESS',
          step: 2,
          label: 'Legal business',
          status: 'PASSED',
          downgradeReason: null,
        },
      ],
    });
    await renderDetail({ org: organization({ vertical: 'PHARMACY' }) });
    const panel = screen.getByRole('region', { name: 'Pharmacy readiness' });
    expect(panel).toHaveTextContent('Opening stock readiness');
    expect(panel).toHaveTextContent('Required evidence is missing.');
    expect(panel).toHaveTextContent('Legal business');
    expect(mocks.pharmacyReadiness).toHaveBeenCalledWith(
      expect.anything(),
      'org_1',
      expect.any(Date)
    );
    expect(screen.queryByText('Restaurant readiness')).toBeNull();
  });

  it('keeps restaurant readiness isolated', async () => {
    await renderDetail();
    expect(screen.getByText('Restaurant readiness')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Agency readiness' })).toBeNull();
    expect(mocks.pharmacyReadiness).not.toHaveBeenCalled();
  });
});

describe('destructive lifecycle reason', () => {
  it('requires an operator-entered purge reason and preserves confirmation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      await renderDetail({ org: organization({ status: 'TERMINATED' }) });
      const form = screen.getByRole('button', { name: 'Schedule purge' }).closest('form')!;
      const reason = within(form).getByRole('textbox', { name: 'Operator reason' });
      expect(reason).toHaveValue('');
      fireEvent.submit(form);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      fireEvent.change(reason, {
        target: { value: 'Retention reviewed and approved by the owner' },
      });
      fireEvent.submit(form);
      expect(confirm).toHaveBeenCalledWith(
        'Schedule this organization for purge? This begins the retention countdown.'
      );
      expect(fetchMock).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      fireEvent.submit(form);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        action: 'organization.transition',
        payload: {
          id: 'org_1',
          status: 'PURGING',
          reason: 'Retention reviewed and approved by the owner',
        },
      });
      await waitFor(() => expect(within(form).getByRole('button')).not.toBeDisabled());
    } finally {
      confirm.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
