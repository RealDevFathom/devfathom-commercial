// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PlatformIdentity } from '@/lib/platform/auth';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.TEST_DATABASE_URL;
const suffix = randomUUID();
const actor: PlatformIdentity = {
  id: `wha1598_operator_${suffix}`,
  sessionId: 'wha1598_session',
  name: 'Support Test',
  email: `support_${suffix}@example.test`,
  role: 'SUPPORT',
  mfaEnabled: true,
  expiresAt: new Date(Date.now() + 600000),
};
const otherOperator = {
  ...actor,
  id: `wha1598_other_operator_${suffix}`,
  email: `other_support_${suffix}@example.test`,
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
      for (const operator of [actor, otherOperator]) {
        await tx.platformUser.create({
          data: {
            id: operator.id,
            name: operator.name,
            email: operator.email,
            role: operator.role,
            passwordHash: 'fixture',
          },
        });
      }
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
