import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  user: vi.fn(),
  audit: vi.fn(),
  payments: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
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
vi.mock('@/lib/restaurant/reports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/reports')>()),
  readPaymentsReport: mocks.payments,
}));

import { router, type TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';
import { restaurantReportsRouter } from './restaurant-reports';

const testRouter = router({
  organizationAdmin: organizationAdminRouter,
  restaurantReports: restaurantReportsRouter,
});
const states = new Map<string, boolean>();
const db = {
  organization: { findUnique: mocks.findUnique, update: mocks.update },
  user: { findUnique: mocks.user },
  restaurantBranch: { findMany: vi.fn(async () => [{ id: 'branch_a', name: 'Main' }]) },
};

function context(organizationId = 'org_a', role = 'ADMIN'): TRPCContext {
  return {
    db,
    session: {
      expires: 'later',
      user: { id: `user_${organizationId}`, organizationId, role, status: 'ACTIVE' },
    },
    organization: { id: organizationId },
    entitlements: {
      organizationId,
      enabledModules: ['restaurant-core', 'restaurant-pos'],
      modules: [],
    },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

beforeEach(() => {
  vi.resetAllMocks();
  states.clear();
  states.set('org_a', true);
  states.set('org_b', false);
  mocks.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    states.has(where.id) ? { id: where.id, askFathomEnabled: states.get(where.id) } : null
  );
  mocks.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: { askFathomEnabled: boolean } }) => {
      states.set(where.id, data.askFathomEnabled);
      return { id: where.id, askFathomEnabled: data.askFathomEnabled };
    }
  );
  mocks.user.mockResolvedValue({ organizationRole: null, permissionOverrides: [] });
});

describe('organizationAdmin AskFathom contract (mock database, real authorization)', () => {
  it.each(['ADMIN', 'EMPLOYEE', 'HR'])(
    'allows active %s to read only current company settings',
    async (role) => {
      const caller = testRouter.createCaller(context('org_b', role));
      await expect(caller.organizationAdmin.askFathomSettings()).resolves.toEqual({
        organizationId: 'org_b',
        askFathomEnabled: false,
      });
      expect(mocks.findUnique).toHaveBeenCalledWith({
        where: { id: 'org_b' },
        select: { id: true, askFathomEnabled: true },
      });
    }
  );

  it('audits ADMIN writes through isolated procedure contexts and supports repeated values', async () => {
    const ctx = context();
    const caller = testRouter.createCaller(ctx).organizationAdmin;
    for (const askFathomEnabled of [false, false, true]) {
      await expect(caller.setAskFathomEnabled({ askFathomEnabled })).resolves.toEqual({
        organizationId: 'org_a',
        askFathomEnabled,
      });
      await expect(caller.askFathomSettings()).resolves.toEqual({
        organizationId: 'org_a',
        askFathomEnabled,
      });
    }
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: 'org_a' },
      data: { askFathomEnabled: true },
      select: { id: true, askFathomEnabled: true },
    });
    expect(ctx.audit.detail).toEqual({});
    expect(mocks.audit).toHaveBeenCalledTimes(3);
    const procedureAudits = mocks.audit.mock.calls.map(([entry]) => entry.ctx.audit);
    for (const audit of procedureAudits) {
      expect(audit).not.toBe(ctx.audit);
      expect(audit.detail).toMatchObject({
        targetType: 'Organization',
        targetId: 'org_a',
        operation: 'UPDATE',
      });
    }
    expect(new Set(procedureAudits.map((audit) => audit.detail)).size).toBe(3);
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: 'organizationAdmin.setAskFathomEnabled',
        type: 'mutation',
        outcome: 'SUCCESS',
        ctx: expect.objectContaining({ db: ctx.db, session: ctx.session }),
      })
    );
  });

  it.each(['EMPLOYEE', 'HR'])('denies non-admin %s and audits the denial', async (role) => {
    await expect(
      testRouter
        .createCaller(context('org_a', role))
        .organizationAdmin.setAskFathomEnabled({ askFathomEnabled: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
  });

  it('does not let a custom admin capability grant widen the ADMIN-only control', async () => {
    mocks.user.mockResolvedValue({
      organizationRole: null,
      permissionOverrides: [{ capability: 'admin:access', effect: 'ALLOW' }],
    });
    await expect(
      testRouter
        .createCaller(context('org_a', 'EMPLOYEE'))
        .organizationAdmin.setAskFathomEnabled({ askFathomEnabled: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('preserves explicit capability denial for ADMIN', async () => {
    mocks.user.mockResolvedValue({
      organizationRole: null,
      permissionOverrides: [{ capability: 'admin:access', effect: 'DENY' }],
    });
    await expect(
      testRouter
        .createCaller(context())
        .organizationAdmin.setAskFathomEnabled({ askFathomEnabled: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(['unauthenticated', 'inactive', 'revoked'])(
    'denies %s reads and writes',
    async (state) => {
      const ctx = context();
      if (state === 'unauthenticated') ctx.session = null;
      if (state === 'inactive') ctx.session!.user.status = 'INACTIVE';
      if (state === 'revoked') ctx.session!.user.sessionRevoked = true;
      const caller = testRouter.createCaller(ctx).organizationAdmin;
      const code = state === 'inactive' ? 'FORBIDDEN' : 'UNAUTHORIZED';
      await expect(caller.askFathomSettings()).rejects.toMatchObject({ code });
      await expect(caller.setAskFathomEnabled({ askFathomEnabled: false })).rejects.toMatchObject({
        code,
      });
      expect(mocks.findUnique).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    {},
    true,
    { askFathomEnabled: 'false' },
    { askFathomEnabled: 0 },
    { askFathomEnabled: null },
    { askFathomEnabled: false, organizationId: 'org_b' },
    { askFathomEnabled: false, role: 'ADMIN' },
  ])('rejects non-boolean or extra mutation input: %j', async (input) => {
    await expect(
      testRouter
        .createCaller(context())
        .organizationAdmin.setAskFathomEnabled(input as { askFathomEnabled: boolean })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects client-supplied organization IDs on the query', async () => {
    await expect(
      testRouter.createCaller(context()).organizationAdmin.askFathomSettings(
        // @ts-expect-error Deliberately bypass the public no-input contract.
        { organizationId: 'org_b' }
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it.each([null, { id: 'org_b', askFathomEnabled: true }, { id: 'org_a' }])(
    'denies missing or cross-tenant settings: %j',
    async (row) => {
      mocks.findUnique.mockResolvedValue(row);
      const caller = testRouter.createCaller(context()).organizationAdmin;
      await expect(caller.askFathomSettings()).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(caller.setAskFathomEnabled({ askFathomEnabled: false })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(mocks.update).not.toHaveBeenCalled();
    }
  );

  it('propagates read and write failures and records failure instead of success', async () => {
    const caller = testRouter.createCaller(context()).organizationAdmin;
    mocks.findUnique.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(caller.askFathomSettings()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    mocks.findUnique.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(caller.setAskFathomEnabled({ askFathomEnabled: false })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.update.mockRejectedValueOnce(new Error('write unavailable'));
    await expect(caller.setAskFathomEnabled({ askFathomEnabled: false })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(states.get('org_a')).toBe(true);
    expect(mocks.audit.mock.calls.every(([entry]) => entry.outcome === 'FAILURE')).toBe(true);
  });

  it('keeps concurrent company writes isolated', async () => {
    await Promise.all([
      testRouter
        .createCaller(context('org_a'))
        .organizationAdmin.setAskFathomEnabled({ askFathomEnabled: false }),
      testRouter
        .createCaller(context('org_b'))
        .organizationAdmin.setAskFathomEnabled({ askFathomEnabled: true }),
    ]);
    expect([...states]).toEqual([
      ['org_a', false],
      ['org_b', true],
    ]);
  });

  it.each([true, false])(
    'preserves ordinary report permissions with AskFathom %s',
    async (askFathomEnabled) => {
      states.set('org_a', askFathomEnabled);
      mocks.user.mockResolvedValue({
        organizationRole: null,
        permissionOverrides: [
          { capability: 'reports:financial', effect: 'ALLOW' },
          { capability: 'restaurant:configure', effect: 'ALLOW' },
        ],
      });
      mocks.payments.mockResolvedValue({ marker: 'deterministic-report' });
      const caller = testRouter.createCaller(context());
      expect((await caller.organizationAdmin.askFathomSettings()).askFathomEnabled).toBe(
        askFathomEnabled
      );
      mocks.findUnique.mockClear();
      const input = { branchId: 'branch_a', from: '2026-09-01', to: '2026-09-10' };
      await expect(caller.restaurantReports.payments(input)).resolves.toEqual({
        marker: 'deterministic-report',
      });
      expect(mocks.payments).toHaveBeenCalledOnce();
      expect(mocks.findUnique).not.toHaveBeenCalled();
      mocks.user.mockResolvedValue({ organizationRole: null, permissionOverrides: [] });
      await expect(caller.restaurantReports.payments(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mocks.payments).toHaveBeenCalledOnce();
    }
  );
});
