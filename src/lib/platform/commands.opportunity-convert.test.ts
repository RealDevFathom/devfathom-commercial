import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lockOpportunity: vi.fn(),
  packageFindUnique: vi.fn(),
  organizationCreate: vi.fn(),
  roleCreate: vi.fn(),
  departmentCreateMany: vi.fn(),
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  brandCreate: vi.fn(),
  emailSettingsCreate: vi.fn(),
  deploymentCreate: vi.fn(),
  jobCreate: vi.fn(),
  lifecycleCreate: vi.fn(),
  opportunityFindUnique: vi.fn(),
  opportunityUpdate: vi.fn(),
  stageEventCreate: vi.fn(),
  accountUpdate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
}));

const platformDb = {
  $queryRaw: mocks.lockOpportunity,
  platformPackage: { findUnique: mocks.packageFindUnique },
  organization: { create: mocks.organizationCreate },
  organizationRole: { create: mocks.roleCreate },
  organizationDepartment: { createMany: mocks.departmentCreateMany },
  user: { findFirst: mocks.userFindFirst, create: mocks.userCreate },
  organizationBrand: { create: mocks.brandCreate },
  organizationEmailSettings: { create: mocks.emailSettingsCreate },
  organizationDeployment: { create: mocks.deploymentCreate },
  platformJob: { create: mocks.jobCreate },
  organizationLifecycleEvent: { create: mocks.lifecycleCreate },
  platformOpportunity: {
    findUnique: mocks.opportunityFindUnique,
    update: mocks.opportunityUpdate,
  },
  platformOpportunityStageEvent: { create: mocks.stageEventCreate },
  platformAccount: { update: mocks.accountUpdate },
  platformAuditLog: { create: mocks.auditCreate },
};

import { executePlatformCommand } from './commands';
import { PlatformSecurityError } from './security';

const actor = { id: 'operator_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

const payload = {
  opportunityId: 'opportunity_missing',
  slug: 'acme',
  legalName: 'Acme Inc',
  displayName: 'Acme',
  deploymentMode: 'SHARED',
  packageId: 'package_1',
  timezone: 'UTC',
  locale: 'en-US',
  currency: 'USD',
  primaryContactName: 'Operations',
  primaryContactEmail: 'ops@acme.example',
  adminName: 'Acme Admin',
  adminEmail: 'admin@acme.example',
  adminPassword: 'a-strong-password',
};

describe('crm.opportunity.convert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lockOpportunity.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: 'failure_audit_1' });
  });

  it('rejects a missing opportunity id before attempting to lock or provision', async () => {
    await expect(
      executePlatformCommand(
        actor,
        'crm.opportunity.convert',
        { ...payload, opportunityId: undefined },
        request
      )
    ).rejects.toMatchObject({
      status: 400,
      message: 'An opportunity is required for conversion.',
    });

    expect(mocks.lockOpportunity).not.toHaveBeenCalled();
    expect(mocks.packageFindUnique).not.toHaveBeenCalled();
    expect(mocks.organizationCreate).not.toHaveBeenCalled();
    expect(mocks.jobCreate).not.toHaveBeenCalled();
  });

  it('locks and rejects a nonexistent opportunity before provisioning anything', async () => {
    const error = await executePlatformCommand(
      actor,
      'crm.opportunity.convert',
      payload,
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400, message: 'Opportunity not found.' });
    const [query, opportunityId] = mocks.lockOpportunity.mock.calls[0];
    expect(Array.from(query).join('$1')).toMatch(
      /SELECT id, "convertedOrganizationId"\s+FROM platform_opportunities\s+WHERE id = \$1\s+FOR UPDATE/
    );
    expect(opportunityId).toBe(payload.opportunityId);
    expect(mocks.packageFindUnique).not.toHaveBeenCalled();
    expect(mocks.organizationCreate).not.toHaveBeenCalled();
    expect(mocks.roleCreate).not.toHaveBeenCalled();
    expect(mocks.departmentCreateMany).not.toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.brandCreate).not.toHaveBeenCalled();
    expect(mocks.emailSettingsCreate).not.toHaveBeenCalled();
    expect(mocks.deploymentCreate).not.toHaveBeenCalled();
    expect(mocks.jobCreate).not.toHaveBeenCalled();
    expect(mocks.lifecycleCreate).not.toHaveBeenCalled();
    expect(mocks.opportunityUpdate).not.toHaveBeenCalled();
    expect(mocks.stageEventCreate).not.toHaveBeenCalled();
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'crm.opportunity.convert',
        success: false,
      }),
    });
  });

  it('rejects a sequential retry after the opportunity was converted', async () => {
    mocks.lockOpportunity.mockResolvedValue([
      { id: payload.opportunityId, convertedOrganizationId: 'organization_existing' },
    ]);

    await expect(
      executePlatformCommand(actor, 'crm.opportunity.convert', payload, request)
    ).rejects.toMatchObject({ status: 409, message: 'Opportunity has already been converted.' });

    expect(mocks.packageFindUnique).not.toHaveBeenCalled();
    expect(mocks.organizationCreate).not.toHaveBeenCalled();
    expect(mocks.jobCreate).not.toHaveBeenCalled();
  });

  it('serializes concurrent conversions and provisions exactly one tenant and job', async () => {
    let convertedOrganizationId: string | null = null;
    let lockAttempt = 0;
    mocks.lockOpportunity.mockImplementation(async () => {
      lockAttempt += 1;
      if (lockAttempt > 1) {
        await vi.waitUntil(() => convertedOrganizationId !== null);
      }
      return [{ id: payload.opportunityId, convertedOrganizationId }];
    });
    mocks.packageFindUnique.mockResolvedValue({
      id: payload.packageId,
      active: true,
      vertical: 'AGENCY',
      defaultSeats: 1,
      moduleLinks: [],
    });
    mocks.organizationCreate.mockImplementation(async ({ data }) => ({
      ...data,
      id: `organization_${mocks.organizationCreate.mock.calls.length}`,
    }));
    mocks.roleCreate.mockResolvedValue({ id: 'role_admin' });
    mocks.departmentCreateMany.mockResolvedValue({ count: 1 });
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_admin' });
    mocks.opportunityFindUnique.mockResolvedValue({
      id: payload.opportunityId,
      accountId: 'account_1',
      stage: 'PROPOSAL',
    });
    mocks.opportunityUpdate.mockImplementation(async ({ data }) => {
      convertedOrganizationId = data.convertedOrganizationId;
      // Keep the winning transaction open until the competing request has
      // attempted its row lock, as PostgreSQL does until commit.
      await vi.waitUntil(() => lockAttempt >= 2);
      return { id: payload.opportunityId, ...data };
    });
    mocks.auditCreate.mockResolvedValue({ id: 'audit_1' });

    const first = executePlatformCommand(actor, 'crm.opportunity.convert', payload, request);
    await vi.waitFor(() => expect(mocks.organizationCreate).toHaveBeenCalledTimes(1));
    const second = executePlatformCommand(
      actor,
      'crm.opportunity.convert',
      { ...payload, slug: 'acme-retry' },
      request
    );

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409, message: 'Opportunity has already been converted.' },
    });
    expect(mocks.organizationCreate).toHaveBeenCalledTimes(1);
    expect(mocks.jobCreate).toHaveBeenCalledTimes(1);
  });
});
