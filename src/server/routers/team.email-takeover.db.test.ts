/**
 * @vitest-environment node
 *
 * DEV-974: an administrator who is not the owner must not be able to take over the
 * owner's account by changing the owner's email and completing a password reset.
 *
 * Requires TEST_DATABASE_URL for a disposable, migrated PostgreSQL database accessed
 * as the restricted runtime role (no SUPERUSER, no BYPASSRLS), so every query below
 * runs under tenant row-level security.
 */
import { randomBytes } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
const sent: Array<{ to: string; subject: string; text: string }> = [];
vi.mock('@/lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  appUrl: () => 'https://test.invalid',
  sendEmail: vi.fn(async (mail: { to: { email: string }; subject: string; text: string }) => {
    sent.push({ to: mail.to.email, subject: mail.subject, text: mail.text });
  }),
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { runPasswordResetJob } from '@/lib/auth/password-reset-request';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { ACTIVE_STATUSES } from '@/lib/abac';
import { router, type TRPCContext } from '../trpc';
import { teamRouter } from './team';
import { passwordResetRouter } from './password-reset';
import { invitationsRouter } from './invitations';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const app = router({
  team: teamRouter,
  passwordReset: passwordResetRouter,
  invitations: invitationsRouter,
});
const suffix = randomBytes(6).toString('hex');
const organizations: string[] = [];
let organizationId: string;
let client: pg.Client;
let ownerPasswordHash: string;

const OWNER_EMAIL = 'owner@owner.test.invalid';
const ATTACKER_EMAIL = 'attacker@attacker.test.invalid';
const OWNER_PASSWORD = 'Owner-original-passphrase-1';
const ATTACKER_PASSWORD = 'Attacker-chosen-passphrase-1';

const ids = () => ({
  owner: `${organizationId}_owner`,
  admin: `${organizationId}_admin`,
  admin2: `${organizationId}_admin2`,
  staff: `${organizationId}_staff`,
});

function context(db: ScopedDb, actorId: string | null): TRPCContext {
  return {
    db,
    entitlements: { enabledModules: ['admin', 'hr'], modules: [], activeSeats: 1, seatLimit: 20 },
    session: actorId
      ? {
          expires: 'later',
          user: {
            id: actorId,
            organizationId,
            role: 'ADMIN',
            status: 'ACTIVE',
            department: 'ENGINEERING',
          },
        }
      : null,
    organization: { id: organizationId, isDemo: false },
    support: null,
    requestMeta: { ip: `10.0.${Math.floor(Math.random() * 250)}.1`, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

/** The credential check sign-in performs (src/lib/auth.ts authorize): the tenant
 * member found by email, an ACTIVE/ON_LEAVE status and a matching bcrypt password. */
async function signInAs(email: string, password: string): Promise<string | null> {
  return withTenantDb(organizationId, async (db) => {
    const user = await db.user.findFirst({
      where: { email, organizationId },
      select: { id: true, password: true, status: true },
    });
    if (!user?.password || !ACTIVE_STATUSES.has(user.status)) return null;
    return (await compare(password, user.password)) ? user.id : null;
  });
}

function linkToken(to: string, path: 'reset-password' | 'invite'): string | null {
  const pattern = new RegExp(`https://test\\.invalid/${path}/([A-Za-z0-9_-]+)`);
  for (const mail of [...sent].reverse()) {
    if (mail.to !== to) continue;
    const match = pattern.exec(mail.text);
    if (match) return match[1]!;
  }
  return null;
}

/** Process only this fixture's admitted request through the real worker handler. */
async function requestAndDeliverReset(email: string) {
  await withTenantDb(organizationId, (db) =>
    app.createCaller(context(db, null)).passwordReset.request({ email })
  );
  const job = await withPlatformDb((db) =>
    db.platformJob.findFirstOrThrow({
      where: {
        organizationId,
        type: 'PASSWORD_RESET_REQUEST_V1',
        payload: { path: ['email'], equals: email },
      },
    })
  );
  await runPasswordResetJob(job);
}

async function insertUser(
  id: string,
  email: string,
  role: 'ADMIN' | 'HR' | 'EMPLOYEE',
  organizationRoleId: string | null = null
) {
  await client.query(
    `INSERT INTO users (id, "organizationId", "organizationRoleId", name, email, password, role,
       department, title, status, "updatedAt")
     VALUES ($1, $2, $3, $1, $4, $5, $6, 'ENGINEERING', 'Member', 'ACTIVE', now())`,
    [id, organizationId, organizationRoleId, email, ownerPasswordHash, role]
  );
}

describe.skipIf(!databaseUrl)('DEV-974 email change takeover against PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('AUTH_SECRET', 'synthetic-password-reset-test-key');
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
    ownerPasswordHash = await hash(OWNER_PASSWORD, 4);
  });

  beforeEach(async () => {
    sent.length = 0;
    organizationId = `email_${suffix}_${organizations.length}`;
    organizations.push(organizationId);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", "seatLimit", "updatedAt")
       VALUES ($1, $1, $1, $1, 20, now())`,
      [organizationId]
    );
    await client.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'ENGINEERING', 'Engineering', now())`,
      [`${organizationId}_department`, organizationId]
    );
    const ownerRole = `${organizationId}_owner_role`;
    await client.query(
      `INSERT INTO organization_roles (id, "organizationId", key, name, "isSystem", "updatedAt")
       VALUES ($1, $2, 'owner', 'Owner', true, now())`,
      [ownerRole, organizationId]
    );
    await client.query(
      `INSERT INTO organization_role_permissions (id, "organizationId", "organizationRoleId", capability, effect)
       VALUES ($1, $2, $3, '*', 'ALLOW')`,
      [`${ownerRole}_all`, organizationId, ownerRole]
    );
    await insertUser(ids().owner, OWNER_EMAIL, 'ADMIN', ownerRole);
    await insertUser(ids().admin, 'admin@test.invalid', 'ADMIN');
    await insertUser(ids().admin2, 'admin2@test.invalid', 'ADMIN');
    await insertUser(ids().staff, 'staff@test.invalid', 'EMPLOYEE');
  });

  afterAll(async () => {
    if (!client) return;
    try {
      for (const table of ['password_reset_tokens', 'invitations', 'users']) {
        await client.query(`DELETE FROM ${table} WHERE "organizationId" = ANY($1)`, [
          organizations,
        ]);
      }
      await client.query(
        'DELETE FROM organization_role_permissions WHERE "organizationId" = ANY($1)',
        [organizations]
      );
      await client.query('DELETE FROM organization_roles WHERE "organizationId" = ANY($1)', [
        organizations,
      ]);
      await client.query('DELETE FROM organization_departments WHERE "organizationId" = ANY($1)', [
        organizations,
      ]);
      await client.query('DELETE FROM organizations WHERE id = ANY($1)', [organizations]);
    } finally {
      await client.end();
      vi.unstubAllEnvs();
    }
  });

  it("refuses the full takeover: admin changes the owner's email, resets the password, signs in", async () => {
    // 1. A non-owner administrator changes the owner's email to an address they control.
    const change = await withTenantDb(organizationId, (db) =>
      app
        .createCaller(context(db, ids().admin))
        .team.adminUpdateMember({ id: ids().owner, email: ATTACKER_EMAIL })
        .then(
          () => 'CHANGED',
          (error: { code?: string }) => error.code ?? 'ERROR'
        )
    );
    // 2. They ask for a password reset to that address.
    await requestAndDeliverReset(ATTACKER_EMAIL);
    const resetToken = linkToken(ATTACKER_EMAIL, 'reset-password');
    // 3. They complete the reset with a password they choose.
    const reset = resetToken
      ? await withTenantDb(organizationId, (db) =>
          app
            .createCaller(context(db, null))
            .passwordReset.reset({ token: resetToken, newPassword: ATTACKER_PASSWORD })
            .then(
              () => 'RESET',
              () => 'REFUSED'
            )
        )
      : 'NO_LINK';
    // 4. They sign in as the owner.
    const signedInAs = await signInAs(ATTACKER_EMAIL, ATTACKER_PASSWORD);

    const owner = await withTenantDb(organizationId, (db) =>
      db.user.findUnique({ where: { id: ids().owner }, select: { email: true } })
    );
    expect({ change, reset, signedInAs, ownerEmail: owner?.email }).toEqual({
      change: 'FORBIDDEN',
      reset: 'NO_LINK',
      signedInAs: null,
      ownerEmail: OWNER_EMAIL,
    });
    // The owner still signs in with their own password.
    expect(await signInAs(OWNER_EMAIL, OWNER_PASSWORD)).toBe(ids().owner);
  });

  it('refuses an administrator changing the email of another administrator', async () => {
    await expect(
      withTenantDb(organizationId, (db) =>
        app
          .createCaller(context(db, ids().admin))
          .team.adminUpdateMember({ id: ids().admin2, email: ATTACKER_EMAIL })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const admin2 = await withTenantDb(organizationId, (db) =>
      db.user.findUnique({ where: { id: ids().admin2 }, select: { email: true } })
    );
    expect(admin2?.email).toBe('admin2@test.invalid');
    expect(sent).toEqual([]);
  });

  it('refuses another administrator re-inviting an administrator whose email the owner changed', async () => {
    await withTenantDb(organizationId, (db) =>
      app
        .createCaller(context(db, ids().owner))
        .team.adminUpdateMember({ id: ids().admin2, email: 'admin2.new@test.invalid' })
    );
    // The pending confirmation would hand a fresh sign-in link to the caller.
    await expect(
      withTenantDb(organizationId, (db) =>
        app.createCaller(context(db, ids().admin)).team.inviteMember({
          name: 'Admin Two',
          email: 'admin2.new@test.invalid',
          role: 'ADMIN',
          department: 'ENGINEERING',
          title: 'Admin',
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A pending staff invitation is still re-sent by an administrator.
    const staffInvite = {
      name: 'New Staff',
      email: 'new.staff@test.invalid',
      department: 'ENGINEERING',
      title: 'Staff',
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sent = await withTenantDb(organizationId, (db) =>
        app.createCaller(context(db, ids().admin)).team.inviteMember(staffInvite)
      );
      expect(sent.inviteUrl).toMatch(/\/invite\//);
    }
  });

  it('lets an administrator correct the email of a member below them, pending confirmation', async () => {
    // A reset link the member asked for earlier must not survive the change.
    await requestAndDeliverReset('staff@test.invalid');
    const earlierReset = linkToken('staff@test.invalid', 'reset-password');
    expect(earlierReset).not.toBeNull();

    const ctx = await withTenantDb(organizationId, async (db) => {
      const ctx = context(db, ids().admin);
      const updated = await app
        .createCaller(ctx)
        .team.adminUpdateMember({ id: ids().staff, email: 'Staff.New@Test.Invalid' });
      expect(updated.email).toBe('staff.new@test.invalid');
      return ctx;
    });

    // Audited: who (the session actor), for whom, old and new address.
    expect(ctx.audit.detail).toMatchObject({
      targetId: ids().staff,
      metadata: {
        emailChange: {
          from: 'staff@test.invalid',
          to: 'staff.new@test.invalid',
          changedById: ids().admin,
          confirmationRequired: true,
        },
      },
    });
    // Both addresses are told; only the new one gets the confirmation link.
    expect(
      sent.some((mail) => mail.to === 'staff@test.invalid' && /changed/i.test(mail.subject))
    ).toBe(true);
    const confirmation = linkToken('staff.new@test.invalid', 'invite');
    expect(confirmation).not.toBeNull();
    expect(linkToken('staff@test.invalid', 'invite')).toBeNull();

    // The earlier reset link is cancelled.
    await expect(
      withTenantDb(organizationId, (db) =>
        app
          .createCaller(context(db, null))
          .passwordReset.reset({ token: earlierReset!, newPassword: ATTACKER_PASSWORD })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Until the new address confirms, it can neither sign in nor receive a reset.
    expect(await signInAs('staff.new@test.invalid', OWNER_PASSWORD)).toBeNull();
    expect(await signInAs('staff@test.invalid', OWNER_PASSWORD)).toBeNull();
    sent.length = 0;
    await requestAndDeliverReset('staff.new@test.invalid');
    expect(linkToken('staff.new@test.invalid', 'reset-password')).toBeNull();

    // Confirming from the new address restores sign-in with a password the member chose.
    await withTenantDb(organizationId, (db) =>
      app.createCaller(context(db, null)).invitations.accept({
        token: confirmation!,
        password: 'Member-chosen-passphrase-1',
        phone: '+923000000000',
      })
    );
    expect(await signInAs('staff.new@test.invalid', 'Member-chosen-passphrase-1')).toBe(
      ids().staff
    );
  });

  it('lets the owner correct an administrator email, and refuses their own change without the current password', async () => {
    await withTenantDb(organizationId, (db) =>
      app
        .createCaller(context(db, ids().owner))
        .team.adminUpdateMember({ id: ids().admin, email: 'admin.fixed@test.invalid' })
    );
    const admin = await withTenantDb(organizationId, (db) =>
      db.user.findUnique({ where: { id: ids().admin }, select: { email: true, status: true } })
    );
    expect(admin).toEqual({ email: 'admin.fixed@test.invalid', status: 'INVITED' });

    await expect(
      withTenantDb(organizationId, (db) =>
        app
          .createCaller(context(db, ids().owner))
          .team.adminUpdateMember({ id: ids().owner, email: 'owner.new@owner.test.invalid' })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      withTenantDb(organizationId, (db) =>
        app.createCaller(context(db, ids().owner)).team.adminUpdateMember({
          id: ids().owner,
          email: 'owner.new@owner.test.invalid',
          currentPassword: 'not-the-password',
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    sent.length = 0;
    await withTenantDb(organizationId, (db) =>
      app.createCaller(context(db, ids().owner)).team.adminUpdateMember({
        id: ids().owner,
        email: 'owner.new@owner.test.invalid',
        currentPassword: OWNER_PASSWORD,
      })
    );
    // The owner proved it is them, so they keep signing in; the old address is told.
    expect(await signInAs('owner.new@owner.test.invalid', OWNER_PASSWORD)).toBe(ids().owner);
    expect(sent.map((mail) => mail.to).sort()).toEqual(
      ['owner.new@owner.test.invalid', OWNER_EMAIL].sort()
    );
  });
});
