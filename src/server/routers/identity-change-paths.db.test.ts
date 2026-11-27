/**
 * @vitest-environment node
 *
 * DEV-974: every path that changes a member's sign-in identity (email, password,
 * sign-in method, approval authenticator, PIN) refuses an administrator acting on
 * someone with equal or higher access, while still allowing the legitimate change
 * on a member below them.
 *
 * Requires TEST_DATABASE_URL for a disposable, migrated PostgreSQL database accessed
 * as the restricted runtime role (no SUPERUSER, no BYPASSRLS): every query runs under
 * tenant row-level security.
 */
import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
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
// Module licensing is not under test here: every module is licensed.
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  hasModule: () => true,
}));

import { createHash } from 'node:crypto';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '@/server/trpc';
import { teamRouter } from '@/server/routers/team';
import { organizationAdminRouter } from '@/server/routers/organization-admin';
import { approvalAuthenticatorRouter } from '@/server/routers/approval-authenticator';
import { pharmacyPinRouter } from '@/server/routers/pharmacy-pin';
import { restaurantStaffRouter } from '@/server/routers/restaurant-staff';
import { buildPeopleTools } from '@/lib/ai/tools/people';
import type { AssistantHelpers } from '@/lib/ai/context';
import { provisionIdentityUser } from '@/lib/sso';
import { PATCH, PUT } from '@/app/api/scim/v2/Users/[id]/route';
import { PATCH as PATCH_GROUP } from '@/app/api/scim/v2/Groups/[id]/route';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const app = router({
  team: teamRouter,
  organizationAdmin: organizationAdminRouter,
  approvalAuthenticator: approvalAuthenticatorRouter,
  pharmacyPin: pharmacyPinRouter,
  accountPin: pharmacyPinRouter,
  restaurantStaff: restaurantStaffRouter,
});
const suffix = randomBytes(6).toString('hex');
const organizations: string[] = [];
let organizationId: string;
let client: pg.Client;
let passwordHash: string;
const PASSWORD = 'Member-original-passphrase-1';
const NEW_PASSWORD = 'Administrator-chosen-pass-1';

const ids = () => ({
  owner: `${organizationId}_owner`,
  admin: `${organizationId}_admin`,
  admin2: `${organizationId}_admin2`,
  staff: `${organizationId}_staff`,
});

function context(db: ScopedDb, actorId: string): TRPCContext {
  return {
    db,
    entitlements: {
      organizationId,
      enabledModules: ['admin', 'hr', 'restaurant-core', 'pharmacy'],
      modules: [],
      activeSeats: 1,
      seatLimit: 20,
      limits: { 'restaurant.operators.max': 50 },
    },
    session: {
      expires: 'later',
      user: {
        id: actorId,
        organizationId,
        role: 'ADMIN',
        status: 'ACTIVE',
        department: 'ENGINEERING',
      },
    },
    organization: { id: organizationId, isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

const asAdmin = <T>(run: (caller: ReturnType<typeof app.createCaller>) => Promise<T>) =>
  withTenantDb(organizationId, (db) => run(app.createCaller(context(db, ids().admin))));

async function insertUser(
  id: string,
  email: string,
  role: string,
  organizationRoleId: string | null
) {
  await client.query(
    `INSERT INTO users (id, "organizationId", "organizationRoleId", name, email, password, role,
       department, title, status, "updatedAt")
     VALUES ($1, $2, $3, $1, $4, $5, $6, 'ENGINEERING', 'Member', 'ACTIVE', now())`,
    [id, organizationId, organizationRoleId, email, passwordHash, role]
  );
}

async function userRow(id: string) {
  return withTenantDb(organizationId, (db) =>
    db.user.findUnique({ where: { id }, select: { email: true, password: true, status: true } })
  );
}

async function scim(method: 'PUT' | 'PATCH', userId: string, body: unknown, token: string) {
  const handler = method === 'PUT' ? PUT : PATCH;
  const response = await handler(
    new Request(`https://test.invalid/api/scim/v2/Users/${userId}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: userId }) }
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function scimGroupRequest(roleId: string, body: unknown, token: string) {
  return PATCH_GROUP(
    new Request(`https://test.invalid/api/scim/v2/Groups/${roleId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: roleId }) }
  );
}

const patchUserName = (value: string) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'replace', path: 'userName', value }],
});

describe.skipIf(!databaseUrl)('DEV-974 identity-change paths against PostgreSQL', () => {
  let scimToken: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
    passwordHash = await hash(PASSWORD, 4);
  });

  const scimGroup = (roleId: string, body: unknown) => scimGroupRequest(roleId, body, scimToken);

  beforeEach(async () => {
    sent.length = 0;
    organizationId = `ident_${suffix}_${organizations.length}`;
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
    await insertUser(ids().owner, 'owner@test.invalid', 'ADMIN', ownerRole);
    await insertUser(ids().admin, 'admin@test.invalid', 'ADMIN', null);
    await insertUser(ids().admin2, 'admin2@test.invalid', 'ADMIN', null);
    await insertUser(ids().staff, 'staff@test.invalid', 'EMPLOYEE', null);
    scimToken = `scim_${randomBytes(24).toString('hex')}`;
    await client.query(
      `INSERT INTO organization_scim_tokens (id, "organizationId", name, prefix, "tokenHash")
       VALUES ($1, $2, 'Directory', $3, $4)`,
      [
        `${organizationId}_scim`,
        organizationId,
        scimToken.slice(0, 12),
        createHash('sha256').update(scimToken).digest('hex'),
      ]
    );
  });

  afterAll(async () => {
    if (!client) return;
    // Audit rows are retention-locked by the database, so the organizations that hold
    // them stay behind in the disposable test database; everything else is removed.
    try {
      for (const table of [
        'organization_scim_events',
        'organization_scim_tokens',
        'restaurant_operator_credentials',
        'restaurant_staff_profiles',
        'user_permission_overrides',
        'password_reset_tokens',
        'invitations',
      ]) {
        await client.query(`DELETE FROM ${table} WHERE "organizationId" = ANY($1)`, [
          organizations,
        ]);
      }
    } finally {
      await client.end();
    }
  });

  it('team page: the password reset refuses the owner and another administrator, allows staff', async () => {
    for (const target of [ids().owner, ids().admin2]) {
      await expect(
        asAdmin((caller) =>
          caller.team.adminResetPassword({ id: target, newPassword: NEW_PASSWORD })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await asAdmin((caller) =>
      caller.team.adminResetPassword({ id: ids().staff, newPassword: NEW_PASSWORD })
    );
    expect((await userRow(ids().owner))?.password).toBe(passwordHash);
    expect((await userRow(ids().staff))?.password).not.toBe(passwordHash);
  });

  it('organization admin page: the password reset refuses the owner and another administrator', async () => {
    for (const target of [ids().owner, ids().admin2]) {
      await expect(
        asAdmin((caller) =>
          caller.organizationAdmin.resetMemberPassword({ id: target, password: NEW_PASSWORD })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await asAdmin((caller) =>
      caller.organizationAdmin.resetMemberPassword({ id: ids().staff, password: NEW_PASSWORD })
    );
    expect((await userRow(ids().admin2))?.password).toBe(passwordHash);
  });

  it('assistant: the password reset tool refuses the owner and allows staff', async () => {
    const run = (targetId: string) =>
      withTenantDb(organizationId, (db) => {
        const helpers = {
          db,
          isAdmin: true,
          isHr: false,
          isAdminOrHr: true,
          ctx: { organizationId, userId: ids().admin, name: 'Admin' },
          can: vi.fn(async () => true),
          audit: vi.fn(),
          activity: vi.fn(),
          resolvePerson: vi.fn(async () => ({
            kind: 'found',
            value: { id: targetId, name: targetId },
            interpreted: false,
          })),
        } as unknown as AssistantHelpers;
        const tool = buildPeopleTools(helpers).resetMemberPassword as unknown as {
          execute: (input: { name: string }) => Promise<Record<string, unknown>>;
        };
        return tool.execute({ name: targetId });
      });
    expect(await run(ids().owner)).toMatchObject({ error: expect.stringMatching(/owner/i) });
    expect((await userRow(ids().owner))?.password).toBe(passwordHash);
    expect(await run(ids().staff)).toMatchObject({ success: true });
  });

  it('SCIM: userName changes refuse the owner and administrators, and confirm staff from the new address', async () => {
    for (const target of [ids().owner, ids().admin2]) {
      const patched = await scim(
        'PATCH',
        target,
        patchUserName('taken@attacker.invalid'),
        scimToken
      );
      expect(patched.status).toBe(403);
      const replaced = await scim(
        'PUT',
        target,
        { userName: 'taken@attacker.invalid', displayName: 'Owner', active: true },
        scimToken
      );
      expect(replaced.status).toBe(403);
      expect((await userRow(target))?.email).not.toBe('taken@attacker.invalid');
    }

    // A pending reset for staff is cancelled by the change.
    await withTenantDb(organizationId, (db) =>
      db.passwordResetToken.create({
        data: {
          userId: ids().staff,
          tokenHash: `pending_${organizationId}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      })
    );
    const patched = await scim(
      'PATCH',
      ids().staff,
      patchUserName('Staff.New@Test.Invalid'),
      scimToken
    );
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ userName: 'staff.new@test.invalid', active: false });
    expect(await userRow(ids().staff)).toEqual({
      email: 'staff.new@test.invalid',
      password: null,
      status: 'INVITED',
    });
    const audit = await withTenantDb(organizationId, async (db) => ({
      log: await db.auditLog.findFirst({
        where: { action: 'scim.user.email', targetId: ids().staff },
        select: { changes: true, metadata: true },
      }),
      pending: await db.passwordResetToken.count({
        where: { userId: ids().staff, usedAt: null },
      }),
    }));
    expect(audit.pending).toBe(0);
    expect(audit.log).toMatchObject({
      changes: { email: { before: 'staff@test.invalid', after: 'staff.new@test.invalid' } },
      metadata: { emailChange: { changedBy: { scimTokenId: `${organizationId}_scim` } } },
    });
    expect(sent.map((mail) => mail.to).sort()).toEqual(
      ['staff.new@test.invalid', 'staff@test.invalid'].sort()
    );
  });

  it('assistant: re-inviting an administrator whose email the owner changed is refused', async () => {
    await withTenantDb(organizationId, (db) =>
      app
        .createCaller(context(db, ids().owner))
        .team.adminUpdateMember({ id: ids().admin2, email: 'admin2.new@test.invalid' })
    );
    sent.length = 0;
    const result = await withTenantDb(organizationId, (db) => {
      const helpers = {
        db,
        isAdmin: true,
        isHr: false,
        isAdminOrHr: true,
        ctx: { organizationId, userId: ids().admin, name: 'Admin' },
        can: vi.fn(async () => true),
        audit: vi.fn(),
        activity: vi.fn(),
      } as unknown as AssistantHelpers;
      const tool = buildPeopleTools(helpers).inviteMember as unknown as {
        execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      return tool.execute({
        name: 'Admin Two',
        email: 'admin2.new@test.invalid',
        role: 'ADMIN',
        department: 'ENGINEERING',
        title: 'Admin',
      });
    });
    expect(result).toMatchObject({ error: 'Only the owner can re-send this invitation.' });
    expect(sent).toEqual([]);
  });

  it('SCIM groups: a directory cannot grant or remove owner-level access', async () => {
    const staffRole = `${organizationId}_staff_role`;
    await client.query(
      `INSERT INTO organization_roles (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'cashier', 'Cashier', now())`,
      [staffRole, organizationId]
    );
    const patch = (roleId: string, op: string, userId: string) =>
      PATCH_GROUP(
        new Request(`https://test.invalid/api/scim/v2/Groups/${roleId}`, {
          method: 'PATCH',
          headers: {
            authorization: `Bearer ${scimToken}`,
            'content-type': 'application/scim+json',
          },
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op, path: 'members', value: [{ value: userId }] }],
          }),
        }),
        { params: Promise.resolve({ id: roleId }) }
      );
    const ownerRole = `${organizationId}_owner_role`;
    // Nobody is added to, or removed from, the owner role by a directory.
    expect((await patch(ownerRole, 'add', ids().admin)).status).toBe(403);
    expect((await patch(ownerRole, 'remove', ids().owner)).status).toBe(403);
    // The owner cannot be moved out of the owner role into another one.
    expect((await patch(staffRole, 'add', ids().owner)).status).toBe(403);
    // Ordinary role membership still syncs.
    expect((await patch(staffRole, 'add', ids().staff)).status).toBe(200);
    const roles = await withTenantDb(organizationId, (db) =>
      db.user.findMany({
        where: { id: { in: [ids().owner, ids().admin, ids().staff] } },
        select: { id: true, organizationRoleId: true },
        orderBy: { id: 'asc' },
      })
    );
    expect(Object.fromEntries(roles.map((row) => [row.id, row.organizationRoleId]))).toEqual({
      [ids().owner]: ownerRole,
      [ids().admin]: null,
      [ids().staff]: staffRole,
    });
  });

  it('SCIM groups: a replace cannot clear a restricted wildcard holder into live owner access', async () => {
    // An administrator with a `*` ALLOW override, held back by a DENY on their custom role:
    // not live owner-level today. Clearing that role would remove the DENY.
    const restricted = `${organizationId}_restricted_role`;
    await client.query(
      `INSERT INTO organization_roles (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'restricted', 'Restricted', now())`,
      [restricted, organizationId]
    );
    await client.query(
      `INSERT INTO organization_role_permissions (id, "organizationId", "organizationRoleId", capability, effect)
       VALUES ($1, $2, $3, 'finance:read', 'DENY')`,
      [`${restricted}_deny`, organizationId, restricted]
    );
    await client.query(
      `INSERT INTO user_permission_overrides (id, "organizationId", "userId", capability, effect, reason, "updatedAt")
       VALUES ($1, $2, $3, '*', 'ALLOW', 'break glass', now())`,
      [`${organizationId}_wildcard`, organizationId, ids().admin2]
    );
    await client.query(`UPDATE users SET "organizationRoleId" = $1 WHERE id = $2`, [
      restricted,
      ids().admin2,
    ]);
    const members = (op: string, userId: string) => ({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op, path: 'members', value: [{ value: userId }] }],
    });
    expect((await scimGroup(restricted, members('remove', ids().admin2))).status).toBe(403);
    expect((await scimGroup(restricted, members('replace', ids().staff))).status).toBe(403);
    const after = await withTenantDb(organizationId, (db) =>
      db.user.findMany({
        where: { id: { in: [ids().admin2, ids().staff] } },
        select: { id: true, organizationRoleId: true },
        orderBy: { id: 'asc' },
      })
    );
    expect(Object.fromEntries(after.map((row) => [row.id, row.organizationRoleId]))).toEqual({
      [ids().admin2]: restricted,
      [ids().staff]: null,
    });
  });

  it('SCIM groups: a PATCH is all or nothing, and a refused one is still recorded', async () => {
    const staffRole = `${organizationId}_bulk_role`;
    await client.query(
      `INSERT INTO organization_roles (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'bulk', 'Bulk', now())`,
      [staffRole, organizationId]
    );
    const response = await scimGroup(staffRole, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'add', path: 'members', value: [{ value: ids().staff }] },
        { op: 'add', path: 'members', value: [{ value: ids().owner }] },
      ],
    });
    expect(response.status).toBe(403);
    const state = await withTenantDb(organizationId, async (db) => ({
      staff: await db.user.findUnique({
        where: { id: ids().staff },
        select: { organizationRoleId: true },
      }),
      events: await db.organizationScimEvent.findMany({
        where: { resourceType: 'Group', operation: 'PATCH' },
        select: { status: true, error: true },
      }),
    }));
    expect(state.staff?.organizationRoleId).toBeNull();
    expect(state.events).toEqual([
      { status: 'FAILED', error: 'Owner access can only be changed by the owner in DevFathom.' },
    ]);
  });

  it('SCIM groups: outside a pharmacy a racing owner edit is serialised with the write (DEV-1004)', async () => {
    const staffRole = `${organizationId}_locked_role`;
    const ownerRole = `${organizationId}_owner_role`;
    await client.query(
      `INSERT INTO organization_roles (id, "organizationId", key, name, "updatedAt")
       VALUES ($1, $2, 'locked', 'Locked', now())`,
      [staffRole, organizationId]
    );
    // The owner's edit holds the organisation row lock, as the team screen's role change does.
    const owner = new pg.Client({ connectionString: databaseUrl });
    await owner.connect();
    let open = false;
    try {
      await owner.query('BEGIN');
      open = true;
      await owner.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await owner.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [organizationId]);
      // The directory moves the member into another group meanwhile.
      const pending = scimGroup(staffRole, {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'add', path: 'members', value: [{ value: ids().staff }] }],
      });
      await new Promise((resolve) => setTimeout(resolve, 750));
      // The owner makes the member an owner and commits.
      await owner.query('UPDATE users SET "organizationRoleId" = $1 WHERE id = $2', [
        ownerRole,
        ids().staff,
      ]);
      await owner.query('COMMIT');
      open = false;
      // The directory's write ran after the owner's edit and judged the member as they now are.
      const response = await pending;
      expect(response.status).toBe(403);
    } finally {
      if (open) await owner.query('ROLLBACK').catch(() => {});
      await owner.end();
    }
    expect(
      (await client.query('SELECT "organizationRoleId" FROM users WHERE id = $1', [ids().staff]))
        .rows[0]
    ).toEqual({ organizationRoleId: ownerRole });
  });

  it('single sign-on: an unconfirmed changed email cannot sign in through the identity provider', async () => {
    await asAdmin((caller) =>
      caller.team.adminUpdateMember({ id: ids().staff, email: 'staff.sso@test.invalid' })
    );
    const connection = {
      id: `${organizationId}_idp`,
      organizationId,
      domains: [],
      allowJit: false,
      configuration: null,
      roleMappings: null,
    } as unknown as Parameters<typeof provisionIdentityUser>[0];
    await expect(
      provisionIdentityUser(connection, { email: 'staff.sso@test.invalid', email_verified: true })
    ).rejects.toThrow(/inactive/i);
  });

  it('approval authenticator: an administrator cannot reset the owner or another administrator', async () => {
    for (const target of [ids().owner, ids().admin2]) {
      await expect(
        asAdmin((caller) =>
          caller.approvalAuthenticator.resetForMember({ userId: target, currentPassword: PASSWORD })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('pharmacy PIN: an administrator cannot reset the owner or another administrator', async () => {
    for (const target of [ids().owner, ids().admin2]) {
      await expect(
        asAdmin((caller) =>
          caller.pharmacyPin.resetForMember({ userId: target, currentPassword: PASSWORD })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('protects a linked member’s credentials in a restaurant licensed for pharmacy', async () => {
    const mixed = <T>(
      actorId: string,
      run: (caller: ReturnType<typeof app.createCaller>) => Promise<T>
    ) =>
      withTenantDb(organizationId, (db) => {
        const ctx = context(db, actorId);
        ctx.entitlements.enabledModules = ['restaurant-core', 'pharmacy-core'];
        return run(app.createCaller(ctx));
      });
    const { admin, staff } = ids();
    await client.query(
      `INSERT INTO user_permission_overrides (id, "organizationId", "userId", capability, effect, reason, "updatedAt")
       VALUES ($1,$2,$3,'staff:manage','ALLOW','test staff manager',now()),
              ($4,$2,$3,'restaurant:configure','ALLOW','test manager',now())`,
      [admin + '_manage', organizationId, admin, admin + '_configure']
    );
    const profileId = staff + '_profile';
    await client.query(
      `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName","updatedAt")
       VALUES ($1,$2,$3,'Test member',now())`,
      [profileId, organizationId, staff]
    );
    const ownerProfile = ids().owner + '_profile';
    await client.query(
      'INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName","updatedAt") VALUES ($1,$2,$3,$3,now())',
      [ownerProfile, organizationId, ids().owner]
    );
    await expect(
      mixed(admin, (c) =>
        c.restaurantStaff.issueCredential({
          staffProfileId: profileId,
          type: 'PIN',
          secret: '582917',
          currentPassword: PASSWORD,
        })
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only the member can set their approval PIN. Use Settings, Your PIN to reset it.',
    });
    await expect(
      mixed(admin, (c) =>
        c.restaurantStaff.issueCredential({
          staffProfileId: ownerProfile,
          type: 'BADGE',
          secret: 'synthetic-badge',
          currentPassword: PASSWORD,
        })
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: "Only the owner can reset this person's PIN.",
    });
    // A synthetic, pre-existing restaurant badge is recoverable only after reauthentication.
    const badge = await withTenantDb(organizationId, (db) =>
      db.restaurantOperatorCredential.create({
        data: { staffProfileId: profileId, type: 'BADGE', credentialHash: 'unused-fixture-hash' },
        select: { id: true },
      })
    );
    const revokeBadge = (currentPassword: string) =>
      mixed(admin, (c) =>
        c.restaurantStaff.revokeCredential({ credentialId: badge.id, currentPassword })
      );
    await expect(revokeBadge('wrong')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(revokeBadge(PASSWORD)).resolves.toMatchObject({
      id: badge.id,
      revokedAt: expect.any(Date),
    });
    await revokeBadge(PASSWORD);
    expect(
      await withTenantDb(organizationId, (db) =>
        db.notification.count({ where: { userId: staff, type: 'operator_credential_reset' } })
      )
    ).toBe(1);
    const self = (currentPassword: string) =>
      mixed(staff, (c) =>
        c.pharmacyPin.setMine({ pin: '582917', confirmPin: '582917', currentPassword })
      );
    await expect(self('incorrect')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(self(PASSWORD)).resolves.toEqual({ action: 'created', state: 'SET' });
    const { id: credentialId } = await withTenantDb(organizationId, (db) =>
      db.restaurantOperatorCredential.findFirstOrThrow({
        where: { staffProfileId: profileId, type: 'PIN' },
        select: { id: true },
      })
    );
    await expect(
      mixed(admin, (c) =>
        c.restaurantStaff.rotateCredential({
          credentialId,
          secret: '382917',
          currentPassword: PASSWORD,
        })
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only the member can set their approval PIN. Use Settings, Your PIN to reset it.',
    });
    await expect(
      mixed(admin, (c) =>
        c.restaurantStaff.revokeCredential({ credentialId, currentPassword: PASSWORD })
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Manage this approval PIN in Settings under Your PIN.',
    });
    await expect(
      mixed(admin, (c) =>
        c.pharmacyPin.resetForMember({ userId: staff, currentPassword: PASSWORD })
      )
    ).resolves.toEqual({ reset: true });
    const state = await withTenantDb(organizationId, async (db) => ({
      pin: await db.restaurantOperatorCredential.findUniqueOrThrow({
        where: { id: credentialId },
        select: { revokedAt: true },
      }),
      notices: await db.notification.count({
        where: { userId: staff, type: 'approval_pin_reset', entityId: admin },
      }),
    }));
    expect(state).toEqual({ pin: { revokedAt: expect.any(Date) }, notices: 1 });
  });

  it('clears the historical change requirement only after the member sets a PIN with their password', async () => {
    const userId = ids().staff;
    await withTenantDb(organizationId, async (db) => {
      for (const displayName of ['First historical profile', 'Other historical profile']) {
        const profile = await db.restaurantStaffProfile.create({ data: { displayName, userId } });
        await db.restaurantOperatorCredential.create({
          data: {
            staffProfileId: profile.id,
            type: 'PIN',
            credentialHash: 'unused-historical-hash',
            approvalPinMustChange: true,
          },
        });
      }
    });
    const run = <T>(action: (caller: ReturnType<typeof app.createCaller>) => Promise<T>) =>
      withTenantDb(organizationId, (db) => {
        const ctx = context(db, userId);
        ctx.entitlements.enabledModules = ['restaurant-core'];
        return action(app.createCaller(ctx));
      });
    const save = (currentPassword: string) =>
      run((c) => c.accountPin.setMine({ pin: '582931', confirmPin: '582931', currentPassword }));
    await expect(run((c) => c.accountPin.status())).resolves.toMatchObject({
      state: 'MUST_CHANGE',
    });
    await expect(save('incorrect')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(run((c) => c.accountPin.status())).resolves.toMatchObject({
      state: 'MUST_CHANGE',
    });
    await expect(save(PASSWORD)).resolves.toEqual({ action: 'changed', state: 'SET' });
    await expect(run((c) => c.accountPin.status())).resolves.toMatchObject({ state: 'SET' });
    const remaining = await withTenantDb(organizationId, (db) =>
      db.restaurantOperatorCredential.count({
        where: { staffProfile: { userId }, approvalPinMustChange: true },
      })
    );
    expect(remaining).toBe(0);
  });

  it.each(
    (['self', 'owner', 'second owner', 'administrator'] as const).flatMap((actor) =>
      (['PIN', 'BADGE'] as const).map((type) => ({ actor, type }))
    )
  )('linked $type recovery by $actor', async ({ actor, type }) => {
    const { owner, admin, staff } = ids();
    const target = actor === 'self' ? staff : owner;
    const actorId =
      actor === 'second owner'
        ? organizationId + '_second_owner'
        : actor === 'administrator'
          ? admin
          : target;
    if (actor === 'second owner')
      await insertUser(
        actorId,
        'other-owner@test.invalid',
        'ADMIN',
        organizationId + '_owner_role'
      );
    const credential = await withTenantDb(organizationId, async (db) => {
      const profile = await db.restaurantStaffProfile.create({
        data: { displayName: 'Test member', userId: target },
      });
      const device =
        type === 'PIN'
          ? await db.restaurantRegisteredDevice.create({
              data: {
                name: 'Test register',
                deviceSecretHash: randomBytes(32).toString('hex'),
                branch: { create: { name: 'Recovery branch' } },
              },
            })
          : null;
      return db.restaurantOperatorCredential.create({
        data: {
          staffProfileId: profile.id,
          type,
          deviceId: device?.id,
          credentialHash: 'unused-synthetic-hash',
        },
      });
    });
    const run = (password: string) =>
      withTenantDb(organizationId, (db) => {
        const caller = app.createCaller(context(db, actorId));
        const input = { credentialId: credential.id, currentPassword: password };
        return actorId === target
          ? caller.restaurantStaff.revokeMyTerminalCredential(input)
          : caller.restaurantStaff.revokeCredential(input);
      });
    if (actor === 'administrator') {
      await client.query(
        `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt") VALUES ($1,$2,$3,'staff:manage','ALLOW','test',now()),($4,$2,$3,'restaurant:configure','ALLOW','test',now())`,
        [admin + '_manage', organizationId, admin, admin + '_configure']
      );
      await expect(run(PASSWORD)).rejects.toMatchObject({
        message: "Only the owner can reset this person's PIN.",
      });
    } else {
      await expect(run('wrong')).rejects.toMatchObject({
        message: 'Your current password is incorrect.',
      });
      await expect(run(PASSWORD)).resolves.toMatchObject({
        id: credential.id,
        revokedAt: expect.any(Date),
      });
    }
    expect(
      await withTenantDb(organizationId, (db) =>
        db.notification.count({ where: { userId: target, type: 'operator_credential_reset' } })
      )
    ).toBe(actor === 'second owner' ? 1 : 0);
  });

  it('restaurant PIN: an administrator cannot set the PIN of, or link a profile to, the owner', async () => {
    // Restaurant staff management is granted by role or override, not by base role.
    await client.query(
      `INSERT INTO user_permission_overrides (id, "organizationId", "userId", capability, effect, reason, "updatedAt")
       VALUES ($1, $2, $3, 'staff:manage', 'ALLOW', 'restaurant manager', now()),
              ($4, $2, $3, 'restaurant:configure', 'ALLOW', 'restaurant manager', now())`,
      [
        `${organizationId}_staff_manage`,
        organizationId,
        ids().admin,
        `${organizationId}_restaurant_configure`,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_staff_profiles (id, "organizationId", "userId", "displayName", "updatedAt")
       VALUES ($1, $2, $3, 'Owner', now()), ($4, $2, $5, 'Staff', now()), ($6, $2, NULL, 'Spare', now())`,
      [
        `${organizationId}_p_owner`,
        organizationId,
        ids().owner,
        `${organizationId}_p_staff`,
        ids().staff,
        `${organizationId}_p_spare`,
      ]
    );
    await expect(
      asAdmin((caller) =>
        caller.restaurantStaff.issueCredential({
          staffProfileId: `${organizationId}_p_owner`,
          type: 'PIN',
          secret: '482913',
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A spare profile with a PIN the administrator knows cannot be linked to the owner.
    await asAdmin((caller) =>
      caller.restaurantStaff.issueCredential({
        staffProfileId: `${organizationId}_p_spare`,
        type: 'PIN',
        secret: '573920',
      })
    );
    await expect(
      asAdmin((caller) =>
        caller.restaurantStaff.update({ id: `${organizationId}_p_spare`, userId: ids().admin2 })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A staff member below the administrator still gets a PIN.
    const device = await withTenantDb(organizationId, async (db) => {
      const branch = await db.restaurantBranch.create({ data: { name: 'Test branch' } });
      return db.restaurantRegisteredDevice.create({
        data: {
          name: 'Test register',
          branchId: branch.id,
          deviceSecretHash: randomBytes(32).toString('hex'),
        },
      });
    });
    await asAdmin((caller) =>
      caller.restaurantStaff.issueCredential({
        staffProfileId: `${organizationId}_p_staff`,
        type: 'PIN',
        secret: '691358',
        confirmPin: '691358',
        deviceId: device.id,
        currentPassword: PASSWORD,
      })
    );
    const credentials = await withTenantDb(organizationId, (db) =>
      db.restaurantOperatorCredential.findMany({ select: { staffProfileId: true } })
    );
    expect(credentials.map((row) => row.staffProfileId).sort()).toEqual(
      [`${organizationId}_p_spare`, `${organizationId}_p_staff`].sort()
    );
  });
});
