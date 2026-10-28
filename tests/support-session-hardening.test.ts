import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformIdentity } from '@/lib/platform/auth';

const mocks = vi.hoisted(() => ({
  organization: { findUnique: vi.fn() },
  user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  platformSupportSession: {
    create: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  platformAuditLog: { create: vi.fn() },
  platformUser: { findMany: vi.fn() },
  notification: { createMany: vi.fn() },
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (fn: (db: unknown) => unknown) => fn(mocks),
  withTenantDb: (_id: string, fn: (db: unknown) => unknown) => fn(mocks),
}));
vi.mock('@/lib/secret-crypto', () => ({
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
}));
import {
  consumeSupportLaunchTicket,
  createSupportSession,
  forceEndSupportSession,
  getSupportSession,
  listActiveSupportSessions,
} from '@/lib/tenancy/support-session';

const actor: PlatformIdentity = {
  id: 'operator_one',
  sessionId: 'platform_session',
  name: 'Support Operator',
  email: 'support@example.test',
  role: 'SUPPORT',
  mfaEnabled: true,
  expiresAt: new Date(Date.now() + 60000),
};
const input = {
  actor,
  organizationId: 'org_one',
  tenantUserId: 'admin_one',
  reason: 'Investigate an access issue',
};
const session = () => ({
  id: 'support_one',
  organizationId: 'org_one',
  platformUserId: 'original_operator',
  tenantUserId: 'admin_one',
  status: 'ACTIVE',
  expiresAt: new Date(Date.now() + 60000),
  launchUsedAt: null,
  tokenCiphertext: 'opaque-token',
  reason: input.reason,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.organization.findUnique.mockResolvedValue({
    id: 'org_one',
    slug: 'one',
    status: 'ACTIVE',
    deployments: [],
  });
  mocks.user.findUnique.mockResolvedValue({ id: 'admin_one', role: 'ADMIN', status: 'ACTIVE' });
  mocks.user.findFirst.mockResolvedValue({ id: 'admin_one', role: 'ADMIN', status: 'ACTIVE' });
  mocks.user.findMany.mockResolvedValue([{ id: 'admin_one' }, { id: 'admin_two' }]);
  mocks.platformSupportSession.create.mockResolvedValue({ id: 'support_one' });
  mocks.platformSupportSession.updateMany.mockResolvedValue({ count: 1 });
  mocks.platformSupportSession.findUnique.mockResolvedValue(session());
});

describe('support-session hardening', () => {
  it.each(['EMPLOYEE', 'HR'])('rejects explicit %s target even for SUPER_ADMIN', async (role) => {
    mocks.user.findUnique.mockResolvedValue({ id: 'user_one', role, status: 'ACTIVE' });
    await expect(
      createSupportSession({ ...input, actor: { ...actor, role: 'SUPER_ADMIN' } })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.platformSupportSession.create).not.toHaveBeenCalled();
  });
  it('rejects a foreign or missing tenant user', async () => {
    mocks.user.findUnique.mockResolvedValue(null);
    await expect(createSupportSession(input)).rejects.toMatchObject({ status: 400 });
  });
  it('notifies all active tenant administrators as part of creation', async () => {
    await createSupportSession(input);
    expect(mocks.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_one', role: 'ADMIN', status: { in: ['ACTIVE', 'ON_LEAVE'] } },
      })
    );
    expect(mocks.notification.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          userId: 'admin_one',
          organizationId: 'org_one',
          type: 'support_session_started',
        }),
        expect.objectContaining({
          userId: 'admin_two',
          organizationId: 'org_one',
          entityId: 'support_one',
        }),
      ]),
    });
  });
  it('does not return a launch ticket if notification persistence fails', async () => {
    mocks.notification.createMany.mockRejectedValue(new Error('notification failed'));
    await expect(createSupportSession(input)).rejects.toThrow('notification failed');
  });
  it('attributes launch to the original platform operator and tenant target', async () => {
    await consumeSupportLaunchTicket({ launchToken: 'l'.repeat(40), organizationId: 'org_one' });
    expect(mocks.platformAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorPlatformUserId: 'original_operator',
        actorTenantUserId: 'admin_one',
        action: 'support.session.launched',
      }),
    });
  });
  it('rejects launch-ticket replay', async () => {
    mocks.platformSupportSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      consumeSupportLaunchTicket({ launchToken: 'l'.repeat(40), organizationId: 'org_one' })
    ).rejects.toMatchObject({ status: 401 });
    expect(mocks.platformAuditLog.create).not.toHaveBeenCalled();
  });
  it.each(['SALES', 'FINANCE', 'AUDITOR'] as const)(
    'denies %s create/list/force-end at the service boundary',
    async (role) => {
      const deniedActor = { ...actor, role };
      await expect(createSupportSession({ ...input, actor: deniedActor })).rejects.toMatchObject({
        status: 403,
      });
      await expect(listActiveSupportSessions(deniedActor)).rejects.toMatchObject({ status: 403 });
      await expect(
        forceEndSupportSession({
          actor: deniedActor,
          supportSessionId: 'support_one',
          reason: input.reason,
        })
      ).rejects.toMatchObject({ status: 403 });
      expect(mocks.platformSupportSession.updateMany).not.toHaveBeenCalled();
    }
  );
  it('force-ends another operator session with caller attribution and erases launch credentials', async () => {
    await forceEndSupportSession({ actor, supportSessionId: 'support_one', reason: input.reason });
    expect(mocks.platformSupportSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'support_one', status: 'ACTIVE' },
      data: expect.objectContaining({
        status: 'ENDED',
        tokenCiphertext: null,
        launchTokenHash: null,
      }),
    });
    expect(mocks.platformAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorPlatformUserId: actor.id,
        action: 'support.session.force_ended',
        metadata: { sessionPlatformUserId: 'original_operator' },
      }),
    });
  });
  it('makes repeated force-end idempotent', async () => {
    mocks.platformSupportSession.updateMany.mockResolvedValue({ count: 0 });
    await forceEndSupportSession({ actor, supportSessionId: 'support_one', reason: input.reason });
    expect(mocks.platformAuditLog.create).not.toHaveBeenCalled();
  });
  it.each(['ENDED', 'EXPIRED'])(
    'rejects a %s cookie without resolving a tenant user',
    async (status) => {
      mocks.platformSupportSession.findUnique.mockResolvedValue({ ...session(), status });
      expect(
        await getSupportSession(
          new Request('http://one.localhost', {
            headers: { cookie: `df_support_session=${'t'.repeat(40)}` },
          })
        )
      ).toBeNull();
      expect(mocks.user.findUnique).not.toHaveBeenCalled();
    }
  );
  it('rejects a target demoted after launch', async () => {
    mocks.user.findUnique.mockResolvedValue({
      id: 'admin_one',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
    });
    expect(
      await getSupportSession(
        new Request('http://one.localhost', {
          headers: { cookie: `df_support_session=${'t'.repeat(40)}` },
        })
      )
    ).toBeNull();
  });
  it('limits active list to active unexpired sessions and projects no credential fields', async () => {
    mocks.platformSupportSession.findMany.mockResolvedValue([]);
    mocks.platformUser.findMany.mockResolvedValue([]);
    expect(await listActiveSupportSessions(actor)).toEqual([]);
    const query = mocks.platformSupportSession.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ status: 'ACTIVE', expiresAt: { gt: expect.any(Date) } });
    for (const secret of ['tokenHash', 'launchTokenHash', 'tokenCiphertext'])
      expect(query.select).not.toHaveProperty(secret);
  });
});

it.each([NaN, Infinity, -Infinity])(
  'rejects non-finite support duration %s',
  async (durationMinutes) => {
    await expect(createSupportSession({ ...input, durationMinutes })).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.platformSupportSession.create).not.toHaveBeenCalled();
  }
);
