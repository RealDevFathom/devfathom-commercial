// @vitest-environment node
// Deliberately required: no env gate or skipped substitute for PostgreSQL.
import { randomBytes, createHash } from 'node:crypto';
import { compare } from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssistantHelpers } from '@/lib/ai/context';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/email', () => ({
  appUrl: () => 'https://example.test',
  templates: {
    passwordReset: vi.fn(({ resetUrl }: { resetUrl: string }) => ({
      subject: 'Reset',
      html: resetUrl,
      text: resetUrl,
    })),
  },
  sendEmail: vi.fn(async () => undefined),
}));
import { sendEmail } from '@/lib/email';
import { withTenantDb, withPlatformDb } from '@/lib/tenancy/scoped-db';
import { initiateAdminPasswordReset } from './password-reset';
import { passwordResetRouter } from '@/server/routers/password-reset';
import { invitationsRouter } from '@/server/routers/invitations';
import { buildPeopleTools } from '@/lib/ai/tools/people';

const suffix = randomBytes(6).toString('hex');
const userId = `h4_${suffix}`;
const otherId = `h4_other_${suffix}`;
const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');
let org: string;
let otherOrg: string;
const resetCaller = (db: unknown) =>
  passwordResetRouter.createCaller({ db, requestMeta: { ip: '203.0.113.91' } } as never);
const read = () => withTenantDb(org, (db) => db.user.findUniqueOrThrow({ where: { id: userId } }));
const capturedToken = () => {
  const mail = vi.mocked(sendEmail).mock.calls.at(-1)![0];
  return mail.text!.split('/').at(-1)!;
};
async function credentials(raw: string) {
  await withTenantDb(org, async (db) => {
    await db.passwordResetToken.create({
      data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 3600_000) },
    });
    await db.apiToken.create({
      data: {
        userId,
        name: 'Reset regression',
        prefix: suffix,
        tokenHash: `api_${randomBytes(16).toString('hex')}`,
        scopes: [],
      },
    });
    await db.tenantSsoTicket.create({
      data: {
        userId,
        tokenHash: `sso_${randomBytes(16).toString('hex')}`,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
  });
}
async function expectRevoked() {
  await withTenantDb(org, async (db) => {
    expect(await db.apiToken.count({ where: { userId } })).toBe(0);
    expect(await db.tenantSsoTicket.count({ where: { userId } })).toBe(0);
  });
}

describe('H4/M14 recovery lifecycle against local PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
    const organizations = await withPlatformDb(async (db) => {
      const roles = await db.$queryRaw<
        Array<{ rolsuper: boolean; rolbypassrls: boolean }>
      >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(roles[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      return db.organization.findMany({
        where: { isDemo: false, departments: { some: { active: true } } },
        take: 2,
        orderBy: { id: 'asc' },
        select: { id: true },
      });
    });
    expect(organizations).toHaveLength(2);
    [org, otherOrg] = organizations.map((o) => o.id);
    for (const [organizationId, id] of [
      [org, userId],
      [otherOrg, otherId],
    ]) {
      await withTenantDb(organizationId, async (db) => {
        const department = await db.organizationDepartment.findFirstOrThrow({
          where: { active: true },
        });
        await db.user.create({
          data: {
            id,
            name: 'Reset Member',
            email: `${id}@example.test`,
            title: 'Engineer',
            department: department.key,
            password: 'original-hash',
            tokenVersion: 7,
            mustChangePassword: true,
          },
        });
      });
    }
  });
  afterAll(async () => {
    for (const [organizationId, id] of [
      [org, userId],
      [otherOrg, otherId],
    ]) {
      if (!organizationId) continue;
      await withTenantDb(organizationId, (db) => db.user.deleteMany({ where: { id } }));
    }
  });

  it('approved AI action emails a hashed-at-rest link, revokes prior credentials, preserves password until completion', async () => {
    const old = `old_${suffix}`;
    await credentials(old);
    const before = await read();
    const audit = vi.fn();
    const result = await withTenantDb(org, async (db) => {
      const h = {
        db,
        isAdmin: true,
        isAdminOrHr: true,
        ctx: { organizationId: org, userId: 'admin' },
        audit,
        can: async () => true,
        resolvePerson: async () => ({ kind: 'found', value: { id: userId } }),
      } as unknown as AssistantHelpers;
      const tool = buildPeopleTools(h).resetMemberPassword;
      expect(tool.needsApproval).toBe(true);
      return tool.execute!({ name: 'Reset Member' }, {} as never);
    });
    expect(result).toMatchObject({ success: true, emailSent: true });
    const raw = capturedToken();
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(raw);
    const after = await read();
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    expect(after.password).toBe(before.password);
    expect(after.passwordChangedAt).toBe(before.passwordChangedAt);
    await expectRevoked();
    await withTenantDb(org, async (db) => {
      const tokens = await db.passwordResetToken.findMany({ where: { userId, usedAt: null } });
      expect(tokens).toHaveLength(1);
      expect(tokens[0].tokenHash).toBe(hashToken(raw));
      expect(tokens[0].tokenHash).not.toBe(raw);
      expect(await resetCaller(db).validate({ token: old })).toEqual({ valid: false });
      expect(await resetCaller(db).validate({ token: raw })).toEqual({ valid: true });
    });
  });

  it('completion revokes credentials issued since initiation, consumes sibling links, and accepts only one concurrent link', async () => {
    const first = capturedToken();
    const sibling = `sibling_${suffix}`;
    await credentials(sibling);
    const before = await read();
    const passwords = ['MemberChosen123!', 'SiblingChosen123!'];
    const settled = await Promise.allSettled(
      [first, sibling].map((token, index) =>
        withTenantDb(org, (db) => resetCaller(db).reset({ token, newPassword: passwords[index] }))
      )
    );
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (settled.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason
    ).toMatchObject({ code: 'BAD_REQUEST' });
    const after = await read();
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    expect(after.passwordChangedAt).toBeInstanceOf(Date);
    expect(after.mustChangePassword).toBe(false);
    const winner = settled.findIndex((r) => r.status === 'fulfilled');
    expect(await compare(passwords[winner], after.password!)).toBe(true);
    expect(await compare(passwords[1 - winner], after.password!)).toBe(false);
    await expectRevoked();
    for (const token of [first, sibling]) {
      await expect(
        withTenantDb(org, (db) =>
          resetCaller(db).reset({ token, newPassword: 'ReplayAttempt123!' })
        )
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect((await read()).tokenVersion).toBe(after.tokenVersion);
  });

  it('fails closed across tenants without altering the other member or their tokens', async () => {
    const before = await withTenantDb(otherOrg, (db) =>
      db.user.findUniqueOrThrow({ where: { id: otherId } })
    );
    const token = `other_${suffix}`;
    await withTenantDb(otherOrg, (db) =>
      db.passwordResetToken.create({
        data: {
          userId: otherId,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      })
    );
    expect(
      await withTenantDb(org, (db) => initiateAdminPasswordReset(db, org, otherId))
    ).toBeNull();
    await expect(
      withTenantDb(org, (db) => resetCaller(db).reset({ token, newPassword: 'CrossTenant123!' }))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(
      await withTenantDb(otherOrg, (db) => db.user.findUniqueOrThrow({ where: { id: otherId } }))
    ).toEqual(before);
    expect(await withTenantDb(otherOrg, (db) => resetCaller(db).validate({ token }))).toEqual({
      valid: true,
    });
  });

  it('revokes a pending invitation and lets its owner complete recovery without reactivating inactive users', async () => {
    const invite = `invite_${suffix}`;
    await withTenantDb(org, async (db) => {
      await db.user.update({ where: { id: userId }, data: { status: 'INVITED', password: null } });
      await db.invitation.create({
        data: {
          userId,
          email: `${userId}@example.test`,
          tokenHash: hashToken(invite),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      expect(await initiateAdminPasswordReset(db, org, userId)).toMatchObject({ emailSent: true });
    });
    const raw = capturedToken();
    await withTenantDb(org, (db) =>
      resetCaller(db).reset({ token: raw, newPassword: 'InvitedOwner123!' })
    );
    expect((await read()).status).toBe('ACTIVE');
    await expect(
      withTenantDb(org, (db) =>
        invitationsRouter
          .createCaller({ db } as never)
          .accept({ token: invite, password: 'StolenInvite123!', phone: '+15550000' })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await compare('InvitedOwner123!', (await read()).password!)).toBe(true);
    await withTenantDb(org, async (db) => {
      await db.user.update({ where: { id: userId }, data: { status: 'INACTIVE' } });
      await initiateAdminPasswordReset(db, org, userId);
    });
    await withTenantDb(org, (db) =>
      resetCaller(db).reset({ token: capturedToken(), newPassword: 'InactiveOwner123!' })
    );
    expect((await read()).status).toBe('INACTIVE');
  });

  it('preserves generic self-service requests without letting anonymous callers revoke sessions', async () => {
    await withTenantDb(org, (db) =>
      db.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } })
    );
    await credentials(`self_old_${suffix}`);
    const before = await read();
    const result = await withTenantDb(org, (db) =>
      resetCaller(db).request({ email: `${userId}@example.test` })
    );
    expect(result).toEqual({ success: true });
    const raw = capturedToken();
    expect((await read()).tokenVersion).toBe(before.tokenVersion);
    expect(await withTenantDb(org, (db) => db.apiToken.count({ where: { userId } }))).toBe(1);
    expect(
      await withTenantDb(org, (db) =>
        resetCaller(db).request({ email: `unknown_${suffix}@example.test` })
      )
    ).toEqual(result);
    await expect(
      withTenantDb(org, (db) => resetCaller(db).reset({ token: raw, newPassword: 'weak' }))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await read()).password).toBe(before.password);
    await withTenantDb(org, (db) =>
      resetCaller(db).reset({ token: raw, newPassword: 'SelfService123!' })
    );
    expect(await compare('SelfService123!', (await read()).password!)).toBe(true);
    await expectRevoked();
  });

  it('returns only delivery failure status while retaining revocation, and can retry', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('provider payload must not escape'));
    const before = await read();
    const result = await withTenantDb(org, (db) => initiateAdminPasswordReset(db, org, userId));
    expect(result?.emailSent).toBe(false);
    expect((await read()).tokenVersion).toBe(before.tokenVersion + 1);
    expect(
      await withTenantDb(org, (db) => initiateAdminPasswordReset(db, org, userId))
    ).toMatchObject({ emailSent: true });
  });
});
