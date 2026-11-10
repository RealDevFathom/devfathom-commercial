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
  opportunityUpdateMany: vi.fn(),
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
    updateMany: mocks.opportunityUpdateMany,
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

const conversionActions = ['crm.opportunity.convert', 'organization.create'] as const;

describe('opportunity conversion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lockOpportunity.mockResolvedValue([]);
    mocks.opportunityFindUnique.mockResolvedValue(null);
    mocks.opportunityUpdateMany.mockReset();
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
    expect(mocks.opportunityFindUnique).not.toHaveBeenCalled();
    expect(mocks.opportunityUpdate).not.toHaveBeenCalled();
    expect(mocks.jobCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'crm.opportunity.convert',
        success: false,
      }),
    });
  });

  it.each(conversionActions)(
    '%s rejects a nonexistent opportunity before locking or provisioning anything',
    async (action) => {
      const error = await executePlatformCommand(actor, action, payload, request).catch(
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(PlatformSecurityError);
      expect(error).toMatchObject({ status: 409, message: 'Opportunity is not eligible for conversion.' });
      expect(mocks.opportunityFindUnique).toHaveBeenCalledWith({
        where: { id: payload.opportunityId },
        select: { id: true, accountId: true, stage: true, convertedOrganizationId: true },
      });
      expect(mocks.opportunityUpdateMany).not.toHaveBeenCalled();
      expect(mocks.lockOpportunity).not.toHaveBeenCalled();
      expect(mocks.packageFindUnique).not.toHaveBeenCalled();
      expect(mocks.organizationCreate).not.toHaveBeenCalled();
      expect(mocks.roleCreate).not.toHaveBeenCalled();
      expect(mocks.departmentCreateMany).not.toHaveBeenCalled();
      expect(mocks.userFindFirst).not.toHaveBeenCalled();
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
          action,
          success: false,
        }),
      });
    }
  );

  it.each(conversionActions)(
    '%s rejects a sequential retry after the opportunity was converted',
    async (action) => {
      mocks.opportunityFindUnique.mockResolvedValue({
        id: payload.opportunityId,
        accountId: 'account_1',
        stage: 'WON',
        convertedOrganizationId: 'organization_existing',
      });

      await expect(executePlatformCommand(actor, action, payload, request)).rejects.toMatchObject({
        status: 409,
        message: 'Opportunity is not eligible for conversion.',
      });

      expect(mocks.packageFindUnique).not.toHaveBeenCalled();
      expect(mocks.organizationCreate).not.toHaveBeenCalled();
      expect(mocks.opportunityFindUnique).toHaveBeenCalledOnce();
      expect(mocks.opportunityUpdateMany).not.toHaveBeenCalled();
      expect(mocks.lockOpportunity).not.toHaveBeenCalled();
      expect(mocks.opportunityUpdate).not.toHaveBeenCalled();
      expect(mocks.jobCreate).not.toHaveBeenCalled();
    }
  );

  it.each(conversionActions)('%s still checks the locked opportunity before provisioning', async (action) => {
    mocks.opportunityFindUnique.mockResolvedValue({
      id: payload.opportunityId,
      accountId: 'account_1',
      stage: 'PROPOSAL',
      convertedOrganizationId: null,
    });
    mocks.opportunityUpdateMany.mockResolvedValue({ count: 1 });
    for (const [rows, error] of [
      [[], { status: 400, message: 'Opportunity not found.' }],
      [[{ id: payload.opportunityId, convertedOrganizationId: 'organization_existing' }],
        { status: 409, message: 'Opportunity has already been converted.' }],
    ] as const) {
      mocks.lockOpportunity
        .mockResolvedValueOnce([{ organizationId: null }])
        .mockResolvedValueOnce(rows);
      await expect(executePlatformCommand(actor, action, payload, request)).rejects.toMatchObject(error);
      expect(mocks.packageFindUnique).not.toHaveBeenCalled();
      expect(mocks.organizationCreate).not.toHaveBeenCalled();
      expect(mocks.jobCreate).not.toHaveBeenCalled();
      expect(mocks.opportunityUpdate).not.toHaveBeenCalled();
      expect(mocks.stageEventCreate).not.toHaveBeenCalled();
      expect(mocks.accountUpdate).not.toHaveBeenCalled();
    }
  });

  it.each(
    conversionActions.flatMap((first) =>
      conversionActions.map((second) => [first, second] as const)
    )
  )(
    'serializes concurrent %s and %s conversions and provisions exactly one tenant and job',
    async (firstAction, secondAction) => {
      let finishConversion!: () => void;
      const linked = new Promise<void>((resolve) => { finishConversion = resolve; });
      let claimAttempt = 0;
      mocks.opportunityUpdateMany.mockImplementation(async () => {
        claimAttempt += 1;
        if (claimAttempt > 1) {
          // PostgreSQL rechecks the conditional claim after the winner releases
          // its row lock. Both callers initially read the same unlinked deal.
          await linked;
          return { count: 0 };
        }
        return { count: 1 };
      });
      mocks.lockOpportunity
        .mockResolvedValueOnce([{ organizationId: null }])
        .mockResolvedValueOnce([{ id: payload.opportunityId, convertedOrganizationId: null }]);
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
        convertedOrganizationId: null,
      });
      mocks.opportunityUpdate.mockImplementation(async ({ data }) => {
        finishConversion();
        return { id: payload.opportunityId, ...data };
      });
      mocks.auditCreate.mockResolvedValue({ id: 'audit_1' });

      const first = executePlatformCommand(actor, firstAction, payload, request);
      const second = executePlatformCommand(
        actor,
        secondAction,
        { ...payload, slug: 'acme-retry' },
        request
      );

      const results = await Promise.allSettled([first, second]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { status: 409, message: 'Opportunity is not eligible for conversion.' },
      });
      expect(mocks.opportunityUpdateMany).toHaveBeenCalledTimes(2);
      expect(mocks.opportunityUpdateMany).toHaveBeenNthCalledWith(1, {
        where: { id: payload.opportunityId, stage: 'PROPOSAL', convertedOrganizationId: null },
        data: { stage: 'WON', wonAt: expect.any(Date) },
      });
      expect(mocks.opportunityUpdateMany).toHaveBeenNthCalledWith(2, {
        where: { id: payload.opportunityId, stage: 'PROPOSAL', convertedOrganizationId: null },
        data: { stage: 'WON', wonAt: expect.any(Date) },
      });
      expect(mocks.lockOpportunity).toHaveBeenCalledTimes(2);
      const [accountQuery] = mocks.lockOpportunity.mock.calls[0];
      expect(accountQuery.sql).toMatch(/FROM "platform_accounts"\s+WHERE "id" = \?\s+FOR UPDATE/);
      expect(accountQuery.values).toEqual(['account_1']);
      const [query, opportunityId] = mocks.lockOpportunity.mock.calls[1];
      expect(Array.from(query).join('$1')).toMatch(
        /SELECT id, "convertedOrganizationId"\s+FROM platform_opportunities\s+WHERE id = \$1\s+FOR UPDATE/
      );
      expect(opportunityId).toBe(payload.opportunityId);
      expect(mocks.lockOpportunity).toHaveBeenCalledBefore(mocks.organizationCreate);
      expect(mocks.lockOpportunity.mock.invocationCallOrder[1]).toBeLessThan(
        mocks.organizationCreate.mock.invocationCallOrder[0]
      );
      expect(mocks.organizationCreate).toHaveBeenCalledTimes(1);
      expect(mocks.jobCreate).toHaveBeenCalledTimes(1);
      expect(mocks.opportunityUpdate).toHaveBeenCalledTimes(1);
      expect(mocks.opportunityUpdate).toHaveBeenCalledWith({
        where: { id: payload.opportunityId },
        data: {
          convertedOrganizationId: 'organization_1',
        },
      });
      expect(mocks.accountUpdate).toHaveBeenCalledTimes(1);
      expect(mocks.accountUpdate).toHaveBeenCalledWith({
        where: { id: 'account_1' },
        data: { organizationId: 'organization_1', status: 'CUSTOMER' },
      });
      expect(mocks.stageEventCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          opportunityId: payload.opportunityId,
          fromStage: 'PROPOSAL',
          toStage: 'WON',
        }),
      });
    }
  );
});
