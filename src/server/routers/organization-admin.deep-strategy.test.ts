import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  user: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(), withTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: mocks.audit,
}));

import { router, type TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const testRouter = router({ organizationAdmin: organizationAdminRouter });
const states = new Map<string, boolean>();
const db = {
  organization: { findUnique: mocks.findUnique, update: mocks.update },
  user: { findUnique: mocks.user },
};

function context(organizationId = 'org_a', role = 'ADMIN'): TRPCContext {
  return {
    db,
    session: {
      expires: 'later',
      user: { id: `user_${organizationId}`, organizationId, role, status: 'ACTIVE' },
    },
    organization: { id: organizationId },
    entitlements: { organizationId, enabledModules: ['pharmacy-core'], modules: [] },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

beforeEach(() => {
  vi.resetAllMocks();
  states.clear();
  states.set('org_a', false);
  states.set('org_b', true);
  mocks.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    states.has(where.id) ? { id: where.id, aiDeepStrategyEnabled: states.get(where.id) } : null
  );
  mocks.update.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { aiDeepStrategyEnabled: boolean };
    }) => {
      states.set(where.id, data.aiDeepStrategyEnabled);
      return { id: where.id, aiDeepStrategyEnabled: data.aiDeepStrategyEnabled };
    }
  );
  mocks.user.mockResolvedValue({ organizationRole: null, permissionOverrides: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe('organizationAdmin deep-strategy opt-in (mock database, real authorization)', () => {
  it('reads the current company opt-in, off by default', async () => {
    const caller = testRouter.createCaller(context()).organizationAdmin;
    await expect(caller.deepStrategySettings()).resolves.toEqual({
      organizationId: 'org_a',
      aiDeepStrategyEnabled: false,
    });
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: 'org_a' },
      select: { id: true, aiDeepStrategyEnabled: true },
    });
  });

  it('lets ADMIN switch it, audited like the Ask Fathom switch', async () => {
    const ctx = context();
    const caller = testRouter.createCaller(ctx).organizationAdmin;
    await expect(caller.setDeepStrategyEnabled({ aiDeepStrategyEnabled: true })).resolves.toEqual({
      organizationId: 'org_a',
      aiDeepStrategyEnabled: true,
    });
    await expect(caller.deepStrategySettings()).resolves.toMatchObject({
      aiDeepStrategyEnabled: true,
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'org_a' },
      data: { aiDeepStrategyEnabled: true },
      select: { id: true, aiDeepStrategyEnabled: true },
    });
    expect(ctx.audit.detail).toMatchObject({
      targetType: 'Organization',
      targetId: 'org_a',
      operation: 'UPDATE',
      description: 'Enabled AI deep strategy',
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'organizationAdmin.setDeepStrategyEnabled',
        type: 'mutation',
        outcome: 'SUCCESS',
      })
    );
  });

  it.each(['EMPLOYEE', 'HR'])('denies %s reads and writes', async (role) => {
    const caller = testRouter.createCaller(context('org_a', role)).organizationAdmin;
    await expect(caller.deepStrategySettings()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.setDeepStrategyEnabled({ aiDeepStrategyEnabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
  });

  it('does not let a custom admin capability grant widen the ADMIN-only control', async () => {
    mocks.user.mockResolvedValue({
      organizationRole: null,
      permissionOverrides: [{ capability: 'admin:access', effect: 'ALLOW' }],
    });
    const caller = testRouter.createCaller(context('org_a', 'EMPLOYEE')).organizationAdmin;
    await expect(
      caller.setDeepStrategyEnabled({ aiDeepStrategyEnabled: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { aiDeepStrategyEnabled: 'true' },
    { aiDeepStrategyEnabled: 1 },
    { aiDeepStrategyEnabled: true, organizationId: 'org_b' },
  ])('rejects non-boolean or extra input: %j', async (input) => {
    await expect(
      testRouter
        .createCaller(context())
        .organizationAdmin.setDeepStrategyEnabled(input as { aiDeepStrategyEnabled: boolean })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([null, { id: 'org_b', aiDeepStrategyEnabled: true }, { id: 'org_a' }])(
    'denies missing or cross-tenant settings: %j',
    async (row) => {
      mocks.findUnique.mockResolvedValue(row);
      const caller = testRouter.createCaller(context()).organizationAdmin;
      await expect(caller.deepStrategySettings()).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller.setDeepStrategyEnabled({ aiDeepStrategyEnabled: true })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mocks.update).not.toHaveBeenCalled();
    }
  );
});
