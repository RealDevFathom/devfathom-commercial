/* eslint-disable @typescript-eslint/no-explicit-any -- Partial Prisma delegates model only the operations exercised by these boundary tests. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ audits: [] as any[], operator: {} as any, remaining: 0 }));
vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: async () => 'hashed' }));
const db = {
  $queryRawUnsafe: vi.fn(async () => []),
  platformUser: {
    findUnique: vi.fn(async () => state.operator),
    count: vi.fn(async () => state.remaining),
    update: vi.fn(async ({ data }: any) => ({ id: 'target_1', ...data })),
    create: vi.fn(async ({ data }: any) => ({ id: 'new_1', ...data })),
  },
  platformSession: { updateMany: vi.fn() },
  user: { update: vi.fn(async () => ({ id: 'user_1', organizationId: 'org_1' })) },
  organization: { findUnique: vi.fn(async () => ({ id: 'org_1', vertical: 'AGENCY' })) },
  platformAuditLog: {
    create: vi.fn(async ({ data }: any) => {
      state.audits.push(data);
      return data;
    }),
  },
};
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: (fn: any) => fn(db) }));
import { executePlatformCommand } from '@/lib/platform/commands';
const req = new Request('http://admin.localhost/api/platform/control');
const execute = (action: string, payload: unknown, role = 'SUPER_ADMIN', id = 'actor_1') =>
  executePlatformCommand({ id, role } as any, action, payload, req);
const actions = [
  'organization.user.password',
  'organization.scim.token',
  'organization.scim.revoke',
  'organization.identity',
  'organization.identity.test',
  'organization.identity.remove',
  'organization.transition',
];
beforeEach(() => {
  vi.clearAllMocks();
  state.audits = [];
  state.operator = { id: 'target_1', role: 'SUPER_ADMIN', active: true };
  state.remaining = 0;
});
describe('sensitive commands', () => {
  it.each(['OPERATIONS', 'SUPPORT', 'SALES', 'FINANCE', 'AUDITOR'])(
    'denies and audits every sensitive command for %s',
    async (role) => {
      for (const action of actions) {
        await expect(
          execute(action, { id: 'target_1', reason: 'A valid business reason' }, role)
        ).rejects.toMatchObject({ status: 403 });
        expect(state.audits.at(-1)).toMatchObject({
          action,
          success: false,
          metadata: { outcomeCategory: 'capability_denied' },
        });
      }
      expect(db.user.update).not.toHaveBeenCalled();
    }
  );
  it.each(actions)('%s requires a nonblank reason before writes', async (action) => {
    for (const reason of [undefined, '', '   ', 'short']) {
      await expect(execute(action, { id: 'target_1', reason })).rejects.toThrow();
    }
    expect(db.user.update).not.toHaveBeenCalled();
    expect(state.audits).toHaveLength(4);
  });
  it('allows SA password reset and audits the reason without the password', async () => {
    await execute('organization.user.password', {
      id: 'user_1',
      password: 'A-secret-password1',
      reason: 'Verified owner recovery',
    });
    expect(db.user.update).toHaveBeenCalledOnce();
    expect(state.audits[0].after).toMatchObject({
      reason: 'Verified owner recovery',
      passwordReset: true,
    });
    expect(JSON.stringify(state.audits)).not.toContain('A-secret-password1');
  });
  it('rejects a weak SA password reset before updating the user', async () => {
    await expect(
      execute('organization.user.password', {
        id: 'user_1',
        password: 'aaaaaaaaaaaa',
        reason: 'Verified owner recovery',
      })
    ).rejects.toMatchObject({ issues: expect.any(Array) });

    expect(db.user.update).not.toHaveBeenCalled();
  });
  it('denies an OPERATIONS vertical correction before mutation', async () => {
    await expect(
      execute(
        'organization.update',
        {
          id: 'org_1',
          vertical: 'RESTAURANT',
          packageId: 'pkg_1',
          reason: 'Correct initial vertical',
        },
        'OPERATIONS'
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(state.audits.at(-1).success).toBe(false);
  });
  it('requires a reason on SA vertical corrections', async () => {
    await expect(
      execute('organization.update', { id: 'org_1', vertical: 'RESTAURANT', packageId: 'pkg_1' })
    ).rejects.toThrow();
  });
});
describe('operator safety', () => {
  const payload = {
    id: 'target_1',
    name: 'Target',
    email: 'target@example.com',
    role: 'SUPPORT',
    mfaRequired: false,
  };
  it.each([{ role: 'SUPPORT' }, { role: 'SUPER_ADMIN', active: false }])(
    'rejects last-SA reduction %j',
    async (change) => {
      await expect(execute('operator.upsert', { ...payload, ...change })).rejects.toMatchObject({
        status: 403,
      });
      expect(db.platformUser.update).not.toHaveBeenCalled();
      expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(1597, 1)');
    }
  );
  it('allows another-SA demotion when one remains and revokes target sessions', async () => {
    state.remaining = 1;
    await execute('operator.upsert', payload);
    expect(db.platformUser.update).toHaveBeenCalledOnce();
    expect(db.platformSession.updateMany).toHaveBeenCalledOnce();
  });
  it.each([{ role: 'SUPPORT' }, { role: 'SUPER_ADMIN', active: false }])(
    'rejects self reduction even with another admin %j',
    async (change) => {
      state.remaining = 2;
      await expect(
        execute('operator.upsert', { ...payload, ...change }, 'SUPER_ADMIN', 'target_1')
      ).rejects.toMatchObject({ status: 403 });
      expect(db.platformUser.update).not.toHaveBeenCalled();
    }
  );
  it('allows creation with mandatory MFA before enrollment', async () => {
    await execute('operator.upsert', {
      name: 'New',
      email: 'new@example.com',
      role: 'SUPER_ADMIN',
      password: 'a-valid-password',
      mfaRequired: true,
    });
    expect(db.platformUser.create).toHaveBeenCalledOnce();
  });
});
