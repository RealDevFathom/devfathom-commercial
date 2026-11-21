// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { PlatformIdentity } from '@/lib/platform/auth';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.TEST_DATABASE_URL;
let actor: PlatformIdentity;
let supervisor: PlatformIdentity;
let execute: typeof import('@/lib/platform/commands').executePlatformCommand;
let scoped: typeof import('@/lib/tenancy/scoped-db');
let support: typeof import('@/lib/tenancy/support-session');
let db: typeof import('@/lib/db').db;
let adminId: string;
let employeeId: string;
let orgId: string;

let secondOrgId: string;
const reason = 'Investigate test support access';

async function makeOperator(
  role: PlatformIdentity['role'],
  enrolled = true
): Promise<PlatformIdentity> {
  return scoped.withPlatformDb(async (tx) => {
    const user = await tx.platformUser.create({
      data: {
        name: 'Support QA',
        email: `support-${randomUUID()}@example.test`,
        role,
        passwordHash: 'disposable-fixture',
        mfaEnabledAt: enrolled ? new Date() : null,
        encryptedTotpSecret: enrolled ? 'disposable-fixture' : null,
      },
    });
    const expiresAt = new Date(Date.now() + 600000);
    const session = await tx.platformSession.create({
      data: { platformUserId: user.id, tokenHash: randomUUID(), expiresAt },
    });
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role,
      sessionId: session.id,
      expiresAt,
      mfaEnabled: enrolled,
    };
  });
}

function issue(operator: PlatformIdentity, organizationId: string) {
  return support.createSupportSession({ actor: operator, organizationId, reason });
}

function revoke(operator: PlatformIdentity, kind: string) {
  const request = new Request('http://admin.localhost/api/platform/control');
  if (kind === 'MFA reset') {
    return execute(
      supervisor,
      'operator.mfa.reset',
      { id: operator.id, reason: 'Reset fixture authenticator' },
      request
    );
  }
  return execute(
    supervisor,
    'operator.upsert',
    {
      id: operator.id,
      name: operator.name,
      email: operator.email,
      active: kind !== 'disabled',
      mfaRequired: true,
      // Keep support capability across the role change to exercise session invalidation itself.
      role: kind === 'role changed' ? 'OPERATIONS' : operator.role,
      password: kind === 'password changed' ? 'fixture-password-change' : undefined,
    },
    request
  );
}

describe.skipIf(!url)('support hardening on restricted PostgreSQL', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    vi.stubEnv('DATABASE_URL', url!);
    vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'wha1598-disposable-encryption-key');
    ({ db } = await import('@/lib/db'));
    scoped = await import('@/lib/tenancy/scoped-db');
    support = await import('@/lib/tenancy/support-session');
    ({ executePlatformCommand: execute } = await import('@/lib/platform/commands'));
    const role = await db.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    actor = await makeOperator('SUPPORT');
    supervisor = await makeOperator('SUPER_ADMIN');
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
      const secondOrg = await tx.organization.create({
        data: {
          slug: `support-${randomUUID()}`,
          displayName: 'Second QA tenant',
          legalName: 'Second QA tenant',
          status: 'ACTIVE',
        },
      });
      secondOrgId = secondOrg.id;
      await tx.organizationDepartment.create({
        data: { organizationId: secondOrgId, key: 'ADMINISTRATION', name: 'Administration' },
      });
      await tx.user.create({
        data: {
          organizationId: secondOrgId,
          name: 'Other Admin',
          email: 'admin@example.test',
          role: 'ADMIN',
          department: 'ADMINISTRATION',
          title: 'Administrator',
        },
      });
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
  it.each(['disabled', 'role changed', 'password changed', 'MFA reset', 'MFA required'])(
    'ends and audits all support access when the operator is %s',
    async (kind) => {
      if (kind === 'MFA required') {
        // Start with optional MFA, then turn it on for this specific operator.
        const previous = process.env.PLATFORM_MFA_ENFORCE;
        vi.stubEnv('PLATFORM_MFA_ENFORCE', 'false');
        onTestFinished(() => {
          vi.stubEnv('PLATFORM_MFA_ENFORCE', previous);
        });
      }
      const operator = await makeOperator('SUPPORT', kind !== 'MFA required');
      const session = await issue(operator, orgId);
      const launch = await support.consumeSupportLaunchTicket({
        organizationId: orgId,
        launchToken: session.launchToken,
      });
      const request = new Request('http://support.localhost', {
        headers: { cookie: `${support.SUPPORT_SESSION_COOKIE}=${launch.token}` },
      });
      expect(await support.getSupportSession(request)).toMatchObject({
        supportSessionId: session.supportSessionId,
      });
      const ticket = await issue(operator, secondOrgId);

      await revoke(operator, kind);
      if (kind === 'MFA required') {
        // Enrollment restores operator eligibility but must not revive the old credentials.
        await scoped.withPlatformDb((tx) =>
          tx.platformUser.update({
            where: { id: operator.id },
            data: { mfaEnabledAt: new Date(), encryptedTotpSecret: 'disposable-fixture' },
          })
        );
      }
      expect(await support.getSupportSession(request)).toBeNull();
      await expect(
        support.consumeSupportLaunchTicket({
          organizationId: secondOrgId,
          launchToken: ticket.launchToken,
        })
      ).rejects.toMatchObject({ status: 401 });
      await expect(issue(operator, orgId)).rejects.toMatchObject({ status: 403 });

      await scoped.withPlatformDb(async (tx) => {
        const sessions = await tx.platformSupportSession.findMany({
          where: { platformUserId: operator.id },
        });
        expect(sessions).toHaveLength(2);
        for (const ended of sessions) {
          expect(ended).toMatchObject({
            status: 'ENDED',
            endedAt: expect.any(Date),
            tokenCiphertext: null,
            launchTokenHash: null,
          });
          const audits = await tx.platformAuditLog.findMany({
            where: { action: 'support.session.ended', targetId: ended.id },
          });
          expect(audits).toEqual([
            expect.objectContaining({
              actorPlatformUserId: supervisor.id,
              organizationId: ended.organizationId,
              actorTenantUserId: ended.tenantUserId,
              reason:
                kind === 'MFA reset'
                  ? 'Operator MFA reset: Reset fixture authenticator'
                  : `Operator ${kind}`,
              metadata: { sessionPlatformUserId: operator.id },
            }),
          ]);
        }
      });
    }
  );

  it('preserves an enrolled operator’s session when MFA becomes required', async () => {
    const operator = await makeOperator('SUPPORT');
    const ticket = await issue(operator, orgId);
    await revoke(operator, 'MFA required');
    const launched = await support.consumeSupportLaunchTicket({
      organizationId: orgId,
      launchToken: ticket.launchToken,
    });
    const request = new Request('http://support.localhost', {
      headers: { cookie: `${support.SUPPORT_SESSION_COOKIE}=${launched.token}` },
    });
    expect(await support.getSupportSession(request)).toMatchObject({
      supportSessionId: ticket.supportSessionId,
    });
  });

  it.each(['issue first', 'revoke first'])(
    'serializes issuance and MFA reset (%s)',
    async (order) => {
      const operator = await makeOperator('SUPPORT');
      const issueSession = () => issue(operator, orgId);
      const resetMfa = () => revoke(operator, 'MFA reset');
      const [first, second] =
        order === 'issue first' ? [issueSession, resetMfa] : [resetMfa, issueSession];
      const pending: Promise<PromiseSettledResult<unknown>[]>[] = [];
      try {
        // Queue both transactions on the operator row. Observe actual PostgreSQL lock waits
        // so neither ordering depends on scheduling delays or bcrypt timing.
        await scoped.withPlatformDb(async (tx) => {
          const [holder] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid FROM platform_users WHERE id = ${operator.id} FOR UPDATE`;
          for (const start of [first, second]) {
            pending.push(Promise.allSettled([start()]));
            await expect
              .poll(
                async () => {
                  const [row] = await db.$queryRaw<{ waiting: number }[]>`
              WITH RECURSIVE blocked(pid) AS (
                SELECT ${holder.pid}::int UNION
                SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
              ) SELECT (count(*) - 1)::int AS waiting FROM blocked`;
                  return row.waiting;
                },
                { timeout: 5000 }
              )
              .toBe(pending.length);
          }
        });
      } finally {
        await Promise.all(pending);
      }
      const [[firstResult], [secondResult]] = await Promise.all(pending);
      expect(firstResult.status).toBe('fulfilled');
      if (order === 'issue first') expect(secondResult.status).toBe('fulfilled');
      else expect(secondResult).toMatchObject({ status: 'rejected', reason: { status: 403 } });
      const rows = await scoped.withPlatformDb((tx) =>
        tx.platformSupportSession.findMany({
          where: { platformUserId: operator.id },
          select: { status: true, launchTokenHash: true, tokenCiphertext: true },
        })
      );
      expect(rows).toEqual(
        order === 'issue first'
          ? [{ status: 'ENDED', launchTokenHash: null, tokenCiphertext: null }]
          : []
      );
    },
    20000
  );

  it('audits replacement and voluntary closure once per ended session', async () => {
    const operator = await makeOperator('SUPPORT');
    const replaced = await issue(operator, orgId);
    const current = await issue(operator, orgId);
    await expect(
      support.consumeSupportLaunchTicket({
        organizationId: orgId,
        launchToken: replaced.launchToken,
      })
    ).rejects.toMatchObject({ status: 401 });
    const launch = await support.consumeSupportLaunchTicket({
      organizationId: orgId,
      launchToken: current.launchToken,
    });
    const request = new Request('http://support.localhost', {
      headers: { cookie: `${support.SUPPORT_SESSION_COOKIE}=${launch.token}` },
    });
    await support.endSupportSession(request);
    await support.endSupportSession(request);
    expect(await support.getSupportSession(request)).toBeNull();
    const audits = await scoped.withPlatformDb((tx) =>
      tx.platformAuditLog.findMany({
        where: { actorPlatformUserId: operator.id, action: 'support.session.ended' },
        select: { targetId: true, reason: true },
      })
    );
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(
      expect.arrayContaining([
        { targetId: replaced.supportSessionId, reason: 'Replaced by a new support session.' },
        { targetId: current.supportSessionId, reason: 'Operator ended support access.' },
      ])
    );
  });

  it('preserves sessions on an unchanged deployment seed and revokes them on password rotation', async () => {
    const { upsertPlatformAdmin } = await import('../prisma/platform-admin');
    const { hash } = await import('bcryptjs');
    const operator = await makeOperator('SUPER_ADMIN');
    const password = 'disposable-seed-password';
    const passwordHash = await hash(password, 4);
    await scoped.withPlatformDb((tx) =>
      tx.platformUser.update({ where: { id: operator.id }, data: { passwordHash } })
    );
    const ticket = await issue(operator, orgId);
    vi.stubEnv('PLATFORM_ADMIN_EMAIL', operator.email);
    vi.stubEnv('PLATFORM_ADMIN_PASSWORD', password);
    await scoped.withPlatformDb(upsertPlatformAdmin);
    const launched = await support.consumeSupportLaunchTicket({
      organizationId: orgId,
      launchToken: ticket.launchToken,
    });
    const request = new Request('http://support.localhost', {
      headers: { cookie: `${support.SUPPORT_SESSION_COOKIE}=${launched.token}` },
    });
    expect(await support.getSupportSession(request)).toMatchObject({
      supportSessionId: ticket.supportSessionId,
    });
    const unused = await issue(operator, secondOrgId);
    vi.stubEnv('PLATFORM_ADMIN_PASSWORD', 'rotated-disposable-password');
    await scoped.withPlatformDb(upsertPlatformAdmin);
    expect(await support.getSupportSession(request)).toBeNull();
    await expect(
      support.consumeSupportLaunchTicket({
        organizationId: secondOrgId,
        launchToken: unused.launchToken,
      })
    ).rejects.toMatchObject({ status: 401 });
    await expect(issue(operator, orgId)).rejects.toMatchObject({ status: 403 });
    const audits = await scoped.withPlatformDb((tx) =>
      tx.platformAuditLog.findMany({
        where: {
          targetId: { in: [ticket.supportSessionId, unused.supportSessionId] },
          action: 'support.session.ended',
        },
      })
    );
    expect(audits).toHaveLength(2);
    for (const audit of audits)
      expect(audit).toMatchObject({
        actorPlatformUserId: null,
        reason: 'Deployment seed: Operator password changed',
      });
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
  it('revokes and audits only the suspended organization’s support sessions', async () => {
    const { processPlatformJobs } = await import('@/lib/platform/jobs');
    const first = await makeOperator('SUPPORT');
    const second = await makeOperator('SUPPORT');
    const session = await issue(first, secondOrgId);
    const launch = await support.consumeSupportLaunchTicket({
      organizationId: secondOrgId,
      launchToken: session.launchToken,
    });
    const request = new Request('http://support.localhost', {
      headers: { cookie: `${support.SUPPORT_SESSION_COOKIE}=${launch.token}` },
    });
    const pending = await issue(second, secondOrgId);
    const otherTenant = await issue(first, orgId);
    const suspensionReason = 'Synthetic organization suspension';
    const job = await scoped.withPlatformDb(async (tx) => {
      await tx.organization.update({ where: { id: secondOrgId }, data: { status: 'SUSPENDED' } });
      return tx.platformJob.create({
        data: {
          organizationId: secondOrgId,
          type: 'SUSPEND',
          requestedById: supervisor.id,
          payload: { reason: suspensionReason },
          scheduledAt: new Date('1900-01-01'),
        },
      });
    });

    await processPlatformJobs(1);
    await scoped.withPlatformDb(async (tx) => {
      expect(await tx.platformJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        status: 'SUCCEEDED',
      });
      for (const [targetId, operator] of [
        [session.supportSessionId, first],
        [pending.supportSessionId, second],
      ] as const) {
        expect(
          await tx.platformSupportSession.findUniqueOrThrow({ where: { id: targetId } })
        ).toMatchObject({
          status: 'REVOKED',
          endedAt: expect.any(Date),
          tokenCiphertext: null,
          launchTokenHash: null,
        });
        expect(
          await tx.platformAuditLog.findMany({
            where: { targetId, action: 'support.session.ended' },
          })
        ).toEqual([
          expect.objectContaining({
            organizationId: secondOrgId,
            actorPlatformUserId: supervisor.id,
            reason: `Organization suspended: ${suspensionReason}`,
            metadata: { sessionPlatformUserId: operator.id },
          }),
        ]);
      }
    });
    expect(await support.getSupportSession(request)).toBeNull();
    await expect(
      support.consumeSupportLaunchTicket({
        organizationId: secondOrgId,
        launchToken: pending.launchToken,
      })
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      support.consumeSupportLaunchTicket({
        organizationId: orgId,
        launchToken: otherTenant.launchToken,
      })
    ).resolves.toMatchObject({ token: expect.any(String) });
  });
});
