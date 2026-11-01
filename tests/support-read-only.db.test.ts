// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from 'next-auth';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

// Only outbound email is replaced. Actor resolution, support tickets, ABAC,
// tRPC middleware, routers, password/token hashing and RLS all run for real.
vi.mock('@/lib/email', () => ({
  appUrl: () => 'http://support.localhost',
  sendEmail: vi.fn(async () => undefined),
  templates: { inviteMember: () => ({ subject: 'Test invitation', text: 'Test', html: 'Test' }) },
}));

const url = process.env.TEST_DATABASE_URL;
let db: typeof import('@/lib/db').db;
let scoped: typeof import('@/lib/tenancy/scoped-db');
let support: typeof import('@/lib/tenancy/support-session');
let tenancy: typeof import('@/lib/tenancy/tenant-actor');
let trpc: typeof import('@/server/trpc');
let adminRouter: typeof import('@/server/routers/organization-admin').organizationAdminRouter;
let tokenRouter: typeof import('@/server/routers/api-tokens').apiTokensRouter;
let teamRouter: typeof import('@/server/routers/team').teamRouter;
let invitationRouter: typeof import('@/server/routers/invitations').invitationsRouter;
let organization: NonNullable<
  Awaited<ReturnType<typeof import('@/lib/tenancy/host').resolveOrganizationById>>
>;
let adminId: string;
let employeeId: string;
let normalSession: Session;
let cookie: string;
let supportSessionId: string;
let expiry: Date;
const slug = `support-security-${randomUUID()}`;
const password = 'Disposable-Test-Password-123!';
const memberInput = {
  name: 'Created Admin',
  email: 'created@example.test',
  password,
  title: 'Admin',
  role: 'ADMIN' as const,
  department: 'ADMINISTRATION',
  organizationRoleId: null,
};

function request(path: string, method = 'GET', withSupport = true) {
  return new Request(`http://${slug}.localhost${path}`, {
    method,
    headers: { host: `${slug}.localhost`, ...(withSupport ? { cookie } : {}) },
  });
}

async function context(withSupport = true) {
  const actor = await tenancy.resolveTenantActor({
    request: request('/api/trpc/probe', 'POST', withSupport),
    session: normalSession,
  });
  expect(actor).not.toBeNull();
  return trpc.createTRPCContext({
    session: actor!.session,
    organization: actor!.organization,
    support: actor!.support,
  });
}

async function snapshot() {
  return scoped.withTenantDb(organization.id, async (tx) => ({
    users: await tx.user.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        role: true,
        password: true,
        mustChangePassword: true,
        tokenVersion: true,
      },
    }),
    apiTokens: await tx.apiToken.count(),
    scimTokens: await tx.organizationScimToken.count(),
    invitations: await tx.invitation.count(),
  }));
}

describe.skipIf(!url)('support read-only authority on actual restricted PostgreSQL', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    vi.stubEnv('DATABASE_URL', url!);
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'support-security-disposable-encryption-key');
    ({ db } = await import('@/lib/db'));
    scoped = await import('@/lib/tenancy/scoped-db');
    support = await import('@/lib/tenancy/support-session');
    tenancy = await import('@/lib/tenancy/tenant-actor');
    trpc = await import('@/server/trpc');
    ({ organizationAdminRouter: adminRouter } =
      await import('@/server/routers/organization-admin'));
    ({ apiTokensRouter: tokenRouter } = await import('@/server/routers/api-tokens'));
    ({ teamRouter } = await import('@/server/routers/team'));
    ({ invitationsRouter: invitationRouter } = await import('@/server/routers/invitations'));
    expect(
      await db.$queryRaw`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await scoped.withPlatformDb(async (tx) => {
      await tx.platformUser.create({
        data: {
          id: `operator_${slug}`,
          name: 'Support',
          email: `${slug}@example.test`,
          passwordHash: 'unused',
          role: 'SUPPORT',
          active: true,
        },
      });
      const org = await tx.organization.create({
        data: {
          slug,
          displayName: 'Support security test',
          legalName: 'Support security test',
          status: 'ACTIVE',
          seatLimit: 50,
        },
      });
      organization = org;
      await tx.organizationDepartment.create({
        data: { organizationId: org.id, key: 'ADMINISTRATION', name: 'Administration' },
      });
      for (const key of ['admin', 'api', 'identity', 'team']) {
        await tx.platformModule.upsert({
          where: { key },
          create: { key, name: key, category: 'test', band: 'BASELINE' },
          update: { active: true, band: 'BASELINE' },
        });
      }
      for (const role of ['ADMIN', 'EMPLOYEE'] as const) {
        const user = await tx.user.create({
          data: {
            organizationId: org.id,
            name: role,
            email: `${role.toLowerCase()}@example.test`,
            role,
            department: 'ADMINISTRATION',
            title: role,
            status: 'ACTIVE',
          },
        });
        if (role === 'ADMIN') adminId = user.id;
        else employeeId = user.id;
      }
    });
    normalSession = {
      expires: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        id: adminId,
        organizationId: organization.id,
        role: 'ADMIN',
        department: 'ADMINISTRATION',
        status: 'ACTIVE',
      },
    } as Session;
    const created = await support.createSupportSession({
      actor: {
        id: `operator_${slug}`,
        sessionId: 'platform_test',
        name: 'Support',
        email: 'support@example.test',
        role: 'SUPPORT',
        mfaEnabled: true,
        expiresAt: new Date(Date.now() + 3600_000),
      },
      organizationId: organization.id,
      reason: 'Investigate read-only security regression',
      durationMinutes: 5,
    });
    supportSessionId = created.supportSessionId;
    expiry = created.expiresAt;
    const launched = await support.consumeSupportLaunchTicket({
      launchToken: created.launchToken,
      organizationId: organization.id,
    });
    cookie = `${support.SUPPORT_SESSION_COOKIE}=${launched.token}`;
  }, 60_000);

  afterAll(async () => {
    const { flushAuditWritesForTest } = await import('@/server/audit');
    await flushAuditWritesForTest();
    await db?.$disconnect();
    vi.unstubAllEnvs();
  });

  it('keeps the support identity and absolute expiry when a normal admin JWT is also present', async () => {
    const ctx = await trpc.createTRPCContext({
      req: request('/api/trpc/apiTokens.list'),
      session: normalSession,
    });
    expect(ctx.session?.user.isSupportSession).toBe(true);
    expect(ctx.session?.expires).toBe(expiry.toISOString());
    expect(ctx.support?.supportSessionId).toBe(supportSessionId);
    await expect(tokenRouter.createCaller(ctx).list()).resolves.toEqual([]);
    await expect(adminRouter.createCaller(ctx).departments()).resolves.toHaveLength(1);
  });

  it('blocks every durable authority escape before any tenant credentials or membership change', async () => {
    const ctx = await context();
    const before = await snapshot();
    const admin = adminRouter.createCaller(ctx);
    const team = teamRouter.createCaller(ctx);
    const tokens = tokenRouter.createCaller(ctx);
    const attempts = [
      () => tokens.create({ name: 'Durable wildcard token', scopes: ['*'] }),
      () =>
        tokens.create({
          name: 'Other user token',
          scopes: ['*'],
          userId: employeeId,
          expiresInDays: 365,
        }),
      () => admin.createMember(memberInput),
      () =>
        admin.updateMember({
          id: employeeId,
          role: 'ADMIN',
          status: 'ACTIVE',
          title: 'Elevated',
          department: 'ADMINISTRATION',
          organizationRoleId: null,
        }),
      () => admin.resetMemberPassword({ id: adminId, password }),
      () => admin.createScimToken({ name: 'Durable SCIM', expiresAt: null }),
      () =>
        team.inviteMember({
          name: 'Invited Admin',
          email: 'invited@example.test',
          role: 'ADMIN',
          title: 'Admin',
          department: 'ADMINISTRATION',
        }),
      () => team.changePassword({ currentPassword: password, newPassword: password }),
      () =>
        invitationRouter
          .createCaller(ctx)
          .accept({ token: 'a'.repeat(64), password, phone: '+15555550123' }),
    ];
    for (const attempt of attempts)
      await expect(attempt()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Support access is read-only.',
      });
    expect(await snapshot()).toEqual(before);
  });

  it('blocks alternate raw HTTP handlers before parsing, storage or credential issuance', async () => {
    const { POST: upload } = await import('@/app/api/upload/route');
    const { GET: realtime } = await import('@/app/api/ably-token/route');
    const { POST: enroll } = await import('@/app/api/restaurant/devices/browser-enroll/route');
    expect((await upload(request('/api/upload', 'POST'))).status).toBe(401);
    expect((await realtime(request('/api/ably-token'))).status).toBe(401);
    const req = request('/api/restaurant/devices/browser-enroll', 'POST');
    req.headers.set('origin', `http://${slug}.localhost`);
    expect((await enroll(req)).status).toBe(401);
    expect((await snapshot()).apiTokens).toBe(0);
  });

  it('preserves normal admin token creation, invitation, elevation and temporary passwords', async () => {
    const ctx = await context(false);
    const admin = adminRouter.createCaller(ctx);
    const created = await admin.createMember(memberInput);
    await admin.updateMember({
      id: employeeId,
      role: 'ADMIN',
      status: 'ACTIVE',
      title: 'Elevated',
      department: 'ADMINISTRATION',
      organizationRoleId: null,
    });
    await admin.resetMemberPassword({ id: created.id, password });
    const token = await tokenRouter
      .createCaller(ctx)
      .create({ name: 'Normal admin wildcard', scopes: ['*'] });
    expect(token.token.startsWith('df_')).toBe(true);
    expect(token.expiresAt).toBeNull();
    await admin.createScimToken({ name: 'Normal admin SCIM', expiresAt: null });
    await teamRouter.createCaller(ctx).inviteMember({
      name: 'Invited Admin',
      email: 'invited@example.test',
      role: 'ADMIN',
      title: 'Admin',
      department: 'ADMINISTRATION',
    });
    const state = await snapshot();
    expect(state.apiTokens).toBe(1);
    expect(state.scimTokens).toBe(1);
    expect(state.invitations).toBe(1);
    expect(state.users.find((u) => u.id === employeeId)?.role).toBe('ADMIN');
    const member = state.users.find((u) => u.id === created.id)!;
    expect(member.mustChangePassword).toBe(true);
    expect(member.password).not.toBe(password);
    expect(member.tokenVersion).toBeGreaterThan(0);
  });

  it('rejects expiration and revocation without falling back to the admin JWT', async () => {
    const ctx = await context();
    ctx.session!.expires = new Date(Date.now() - 1).toISOString();
    await expect(tokenRouter.createCaller(ctx).list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await scoped.withPlatformDb((tx) =>
      tx.platformSupportSession.update({
        where: { id: supportSessionId },
        data: { expiresAt: new Date(Date.now() - 1) },
      })
    );
    await expect(
      tenancy.resolveTenantActor({
        request: request('/api/trpc/apiTokens.create', 'POST'),
        session: normalSession,
      })
    ).resolves.toBeNull();
    await scoped.withPlatformDb((tx) =>
      tx.platformSupportSession.update({
        where: { id: supportSessionId },
        data: { expiresAt: expiry, status: 'ENDED' },
      })
    );
    await expect(
      tenancy.resolveTenantActor({
        request: request('/api/upload', 'POST'),
        session: normalSession,
      })
    ).resolves.toBeNull();
  });
});
