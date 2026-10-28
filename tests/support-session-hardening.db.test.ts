// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { PlatformIdentity } from '@/lib/platform/auth';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.TEST_DATABASE_URL;
const actor: PlatformIdentity = {
  id: 'wha1598_operator',
  sessionId: 'wha1598_session',
  name: 'Support Test',
  email: 'support@example.test',
  role: 'SUPPORT',
  mfaEnabled: true,
  expiresAt: new Date(Date.now() + 600000),
};
let scoped: typeof import('@/lib/tenancy/scoped-db');
let support: typeof import('@/lib/tenancy/support-session');
let db: typeof import('@/lib/db').db;
let adminId: string;
let employeeId: string;
let orgId: string;

describe.skipIf(!url)('support hardening on restricted PostgreSQL', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    vi.stubEnv('DATABASE_URL', url!);
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'wha1598-disposable-encryption-key');
    ({ db } = await import('@/lib/db'));
    scoped = await import('@/lib/tenancy/scoped-db');
    support = await import('@/lib/tenancy/support-session');
    const role = await db.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await scoped.withPlatformDb(async (tx) => {
      const org = await tx.organization.create({
        data: {
          slug: `wha1598-${Date.now()}`,
          displayName: 'Support QA tenant',
          legalName: 'Support QA tenant',
          status: 'ACTIVE',
        },
      });
      orgId = org.id;
      await tx.organizationDepartment.create({
        data: { organizationId: orgId, key: 'ADMINISTRATION', name: 'Administration' },
      });
      const admin = await tx.user.create({
        data: {
          organizationId: orgId,
          name: 'Admin',
          email: 'admin@example.test',
          role: 'ADMIN',
          department: 'ADMINISTRATION',
          title: 'Administrator',
        },
      });
      adminId = admin.id;
      const employee = await tx.user.create({
        data: {
          organizationId: orgId,
          name: 'Employee',
          email: 'employee@example.test',
          role: 'EMPLOYEE',
          department: 'ADMINISTRATION',
          title: 'Employee',
        },
      });
      employeeId = employee.id;
    });
  });
  afterAll(async () => {
    await db?.$disconnect();
    vi.unstubAllEnvs();
  });

  it('rejects non-admin targets in the real tenant scope', async () => {
    await expect(
      support.createSupportSession({
        actor,
        organizationId: orgId,
        tenantUserId: employeeId,
        reason: 'Investigate test support access',
      })
    ).rejects.toMatchObject({ status: 400 });
  });
  it('notifies tenant admin, attributes launch, then invalidates the same cookie on force-end', async () => {
    const session = await support.createSupportSession({
      actor,
      organizationId: orgId,
      tenantUserId: adminId,
      reason: 'Investigate test support access',
    });
    const notices = await scoped.withTenantDb(orgId, (tx) =>
      tx.notification.findMany({ where: { entityId: session.supportSessionId } })
    );
    expect(notices.map((n) => n.userId)).toEqual([adminId]);
    const launch = await support.consumeSupportLaunchTicket({
      launchToken: session.launchToken,
      organizationId: orgId,
    });
    await expect(
      support.consumeSupportLaunchTicket({
        launchToken: session.launchToken,
        organizationId: orgId,
      })
    ).rejects.toMatchObject({ status: 401 });
    const request = new Request('http://support.localhost', {
      headers: { cookie: `${support.SUPPORT_SESSION_COOKIE}=${launch.token}` },
    });
    expect(await support.getSupportSession(request)).toMatchObject({
      supportSessionId: session.supportSessionId,
      tenantUserRole: 'ADMIN',
    });
    const otherOperator = { ...actor, id: 'wha1598_other_operator' };
    await support.forceEndSupportSession({
      actor: otherOperator,
      supportSessionId: session.supportSessionId,
      reason: 'End completed investigation',
    });
    expect(await support.getSupportSession(request)).toBeNull();
    await support.forceEndSupportSession({
      actor: otherOperator,
      supportSessionId: session.supportSessionId,
      reason: 'Repeated end investigation',
    });
    const audits = await scoped.withPlatformDb((tx) =>
      tx.platformAuditLog.findMany({ where: { targetId: session.supportSessionId } })
    );
    expect(audits.find((a) => a.action === 'support.session.launched')?.actorPlatformUserId).toBe(
      actor.id
    );
    expect(audits.filter((a) => a.action === 'support.session.force_ended')).toHaveLength(1);
    expect(
      audits.find((a) => a.action === 'support.session.force_ended')?.actorPlatformUserId
    ).toBe(otherOperator.id);
    const stored = await scoped.withPlatformDb((tx) =>
      tx.platformSupportSession.findUniqueOrThrow({ where: { id: session.supportSessionId } })
    );
    expect(stored).toMatchObject({ status: 'ENDED', tokenCiphertext: null, launchTokenHash: null });
  });
  it('cannot persist credentials or elevate members through support tRPC callers', async () => {
    const { organizationAdminRouter } = await import('@/server/routers/organization-admin');
    const { apiTokensRouter } = await import('@/server/routers/api-tokens');
    const grant = await support.createSupportSession({
      actor,
      organizationId: orgId,
      tenantUserId: adminId,
      reason: 'Verify support inspection scope',
    });
    const launch = await support.consumeSupportLaunchTicket({
      launchToken: grant.launchToken,
      organizationId: orgId,
    });
    const identity = await support.getSupportSession(
      new Request('http://support.localhost', {
        headers: { cookie: `${support.SUPPORT_SESSION_COOKIE}=${launch.token}` },
      })
    );
    expect(identity).not.toBeNull();
    await scoped.withTenantDb(orgId, async (tx) => {
      const before = await tx.user.findUniqueOrThrow({ where: { id: employeeId } });
      const membersBefore = await tx.user.count();
      const tokensBefore = await tx.apiToken.count();
      const ctx = {
        db: tx,
        support: identity,
        session: {
          expires: grant.expiresAt.toISOString(),
          user: {
            id: adminId,
            organizationId: orgId,
            role: 'ADMIN',
            status: 'ACTIVE',
            isSupportSession: true,
          },
        },
        organization: { id: orgId },
        entitlements: {},
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      } as unknown as import('@/server/trpc').TRPCContext;
      const admin = organizationAdminRouter.createCaller(ctx);
      await expect(
        admin.createMember({
          name: 'Escape',
          email: 'escape@example.test',
          password: 'Temporary-123456',
          role: 'ADMIN',
          title: 'Admin',
          department: 'ADMINISTRATION',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        admin.updateMember({
          id: employeeId,
          role: 'ADMIN',
          status: 'ACTIVE',
          department: 'ADMINISTRATION',
          title: 'Admin',
          organizationRoleId: null,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        admin.resetMemberPassword({ id: employeeId, password: 'Temporary-123456' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        apiTokensRouter.createCaller(ctx).create({ name: 'Escape', scopes: ['*'] })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await tx.user.findUniqueOrThrow({ where: { id: employeeId } })).toEqual(before);
      expect(await tx.user.count()).toBe(membersBefore);
      expect(await tx.apiToken.count()).toBe(tokensBefore);
    });
  });
  it('keeps real support callers read-only without minting persistent credentials or changing members', async () => {
    const { apiTokensRouter } = await import('@/server/routers/api-tokens');
    const { organizationAdminRouter } = await import('@/server/routers/organization-admin');
    const { teamRouter } = await import('@/server/routers/team');
    const { router } = await import('@/server/trpc');
    type Context = import('@/server/trpc').TRPCContext;
    const routes = router({
      apiTokens: apiTokensRouter,
      organizationAdmin: organizationAdminRouter,
      team: teamRouter,
    });
    const opened = await support.createSupportSession({
      actor,
      organizationId: orgId,
      tenantUserId: adminId,
      reason: 'Investigate read scope regression',
    });
    const launch = await support.consumeSupportLaunchTicket({
      launchToken: opened.launchToken,
      organizationId: orgId,
    });
    const request = new Request('http://support.localhost', {
      headers: { cookie: `${support.SUPPORT_SESSION_COOKIE}=${launch.token}` },
    });
    const identity = await support.getSupportSession(request);
    expect(identity).not.toBeNull();
    const ctx = {
      db: scoped.createTenantDb(orgId, adminId),
      entitlements: {
        enabledModules: ['api', 'identity'],
        modules: [],
        organizationId: orgId,
        seatLimit: 10,
        activeSeats: 2,
        limits: {},
      },
      session: {
        expires: identity!.expiresAt.toISOString(),
        user: {
          id: adminId,
          organizationId: orgId,
          role: 'ADMIN',
          status: 'ACTIVE',
          department: 'ADMINISTRATION',
          isSupportSession: true,
        },
      },
      organization: null,
      support: identity,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as Context;
    const caller = routes.createCaller(ctx);
    await expect(caller.apiTokens.list()).resolves.toEqual([]);
    await expect(
      caller.apiTokens.create({ name: 'Support escape', scopes: ['*'] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.organizationAdmin.createMember({
        name: 'Escape',
        email: 'escape@example.test',
        password: 'Temporary-123456',
        title: 'Admin',
        role: 'ADMIN',
        department: 'ADMINISTRATION',
        organizationRoleId: null,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.organizationAdmin.updateMember({
        id: employeeId,
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationRoleId: null,
        title: 'Admin',
        department: 'ADMINISTRATION',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.organizationAdmin.createScimToken({ name: 'Support escape', expiresAt: null })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.team.inviteMember({
        name: 'Escape invite',
        email: 'invite-escape@example.test',
        role: 'ADMIN',
        department: 'ADMINISTRATION',
        title: 'Admin',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const state = await scoped.withTenantDb(orgId, async (tx) => ({
      tokens: await tx.apiToken.count(),
      members: await tx.user.count(),
      employee: await tx.user.findUnique({ where: { id: employeeId }, select: { role: true } }),
      scim: await tx.organizationScimToken.count(),
    }));
    expect(state).toEqual({ tokens: 0, members: 2, employee: { role: 'EMPLOYEE' }, scim: 0 });
    // The same real administrator retains token creation outside impersonation.
    const normal = routes.createCaller({
      ...ctx,
      support: null,
      session: { ...ctx.session!, user: { ...ctx.session!.user, isSupportSession: false } },
    });
    const created = await normal.apiTokens.create({ name: 'Normal administrator', scopes: ['*'] });
    expect(created.id).toBeTruthy();
    await normal.apiTokens.revoke({ id: created.id });
    ctx.support = { ...identity!, expiresAt: new Date(Date.now() - 1) };
    await expect(caller.apiTokens.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await support.forceEndSupportSession({
      actor,
      supportSessionId: opened.supportSessionId,
      reason: 'Finish read scope regression',
    });
    expect(await support.getSupportSession(request)).toBeNull();
  });

  it('preserves support history by refusing organization deletion', async () => {
    await expect(
      scoped.withPlatformDb((tx) => tx.organization.delete({ where: { id: orgId } }))
    ).rejects.toThrow();
    const history = await scoped.withPlatformDb((tx) =>
      tx.platformSupportSession.count({ where: { organizationId: orgId } })
    );
    expect(history).toBeGreaterThan(0);
    const fk = await db.$queryRaw<
      Array<{ confdeltype: string }>
    >`SELECT confdeltype::text FROM pg_constraint WHERE conname = 'platform_support_sessions_organizationId_fkey'`;
    expect(fk).toEqual([{ confdeltype: 'r' }]);
  });
  it('keeps global support rows invisible to tenant-scoped queries', async () => {
    expect(await scoped.withTenantDb(orgId, (tx) => tx.platformSupportSession.count())).toBe(0);
  });
});
