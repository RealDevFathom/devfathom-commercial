/**
 * @vitest-environment node
 *
 * DEV-1053: a platform support session cannot create lasting access, against migrated
 * PostgreSQL as the restricted runtime role (no SUPERUSER, no BYPASSRLS), so every query
 * runs under tenant row-level security.
 *
 * The support session acts as the business owner, the strongest member there is. It is
 * refused a new administrator, a password reset, an API token and a SCIM token; nothing is
 * written; each refusal is a real audit row naming the platform operator. The owner's own
 * session does the same things, and the support session still reads and fixes ordinary data.
 *
 * Nothing that decides is mocked: real routers, real ABAC, the real audit writer. Email and
 * notifications are stubbed (side effects), and every module is licensed.
 *
 * Skipped unless TEST_DATABASE_URL names a disposable database.
 */
import { randomBytes } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  appUrl: () => 'https://test.invalid',
  sendEmail: vi.fn(async () => undefined),
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  hasModule: () => true,
}));

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { SUPPORT_SESSION_REFUSED_MESSAGE } from '@/lib/tenancy/support-session-rule';
import { flushAuditWritesForTest } from '@/server/audit';
import { router, type TRPCContext } from '@/server/trpc';
import { apiTokensRouter } from '@/server/routers/api-tokens';
import { organizationAdminRouter } from '@/server/routers/organization-admin';
import { teamRouter } from '@/server/routers/team';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (databaseUrl) {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!/(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i.test(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must name a dedicated disposable database (test, e2e, tmp, or disposable).'
    );
  }
  process.env.DATABASE_URL = databaseUrl;
}
const describeIfDatabase = databaseUrl ? describe : describe.skip;

const app = router({
  apiTokens: apiTokensRouter,
  organizationAdmin: organizationAdminRouter,
  team: teamRouter,
});

const suffix = randomBytes(6).toString('hex');
const organizationId = `dev1053_${suffix}`;
const OWNER = `${organizationId}_owner`;
const STAFF = `${organizationId}_staff`;
const SUPPORT_SESSION = `support_session_${suffix}`;
const OPERATOR = `platform_operator_${suffix}`;
/** Synthetic; this database is disposable. */
const ORIGINAL_PASSWORD = 'Member-original-passphrase-1';
const OPERATOR_PASSWORD = 'Operator-chosen-passphrase-1';
const REFUSED = { code: 'FORBIDDEN', message: SUPPORT_SESSION_REFUSED_MESSAGE };

let client: pg.Client;

function context(db: ScopedDb, actor: 'support' | 'owner'): TRPCContext {
  const support = actor === 'support';
  return {
    db,
    entitlements: {
      organizationId,
      enabledModules: ['admin', 'hr', 'identity', 'api'],
      modules: [],
      activeSeats: 2,
      seatLimit: 20,
      limits: {},
    },
    session: {
      expires: 'later',
      user: {
        id: OWNER,
        organizationId,
        name: 'Owner',
        email: 'owner@test.invalid',
        role: 'ADMIN',
        status: 'ACTIVE',
        department: 'ENGINEERING',
        ...(support
          ? { isSupportSession: true, supportSessionId: SUPPORT_SESSION, platformUserId: OPERATOR }
          : {}),
      },
    },
    organization: { id: organizationId, isDemo: false },
    support: support
      ? {
          supportSessionId: SUPPORT_SESSION,
          organizationId,
          platformUserId: OPERATOR,
          tenantUserId: OWNER,
          tenantUserRole: 'ADMIN',
          expiresAt: new Date(Date.now() + 60 * 60_000),
          reason: 'Ticket 4821: the receipt printer prints blank pages',
        }
      : null,
    requestMeta: { ip: '203.0.113.9', userAgent: 'vitest' },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

/** One request: its own tenant transaction, as the tRPC route runs it. */
const as = <T>(
  actor: 'support' | 'owner',
  run: (caller: ReturnType<typeof app.createCaller>) => Promise<T>
) => withTenantDb(organizationId, (db) => run(app.createCaller(context(db, actor))));

async function count(table: string): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE "organizationId" = $1`,
    [organizationId]
  );
  return result.rows[0].n as number;
}

async function refusalAudits(path: string) {
  await flushAuditWritesForTest();
  const result = await client.query(
    `SELECT "actorId", outcome, "errorCode", "errorMessage", input, metadata
       FROM audit_logs
      WHERE "organizationId" = $1 AND path = $2
      ORDER BY "createdAt"`,
    [organizationId, path]
  );
  return result.rows as Array<{
    actorId: string;
    outcome: string;
    errorCode: string;
    errorMessage: string;
    input: unknown;
    metadata: Record<string, unknown>;
  }>;
}

async function expectRefusedAndAudited(path: string, attempt: () => Promise<unknown>) {
  await expect(attempt()).rejects.toMatchObject(REFUSED);
  const rows = await refusalAudits(path);
  expect(rows, path).toHaveLength(1);
  expect(rows[0], path).toMatchObject({
    actorId: OWNER,
    outcome: 'FAILURE',
    errorCode: 'FORBIDDEN',
    errorMessage: SUPPORT_SESSION_REFUSED_MESSAGE,
    metadata: {
      supportSessionRefused: true,
      supportSessionId: SUPPORT_SESSION,
      platformUserId: OPERATOR,
      actingAsTenantUserId: OWNER,
    },
  });
  // The request body (a password, a key name) is never stored.
  expect(JSON.stringify(rows[0])).not.toContain(OPERATOR_PASSWORD);
  expect(rows[0].input).toBe('[skipped]');
}

describeIfDatabase('DEV-1053 a support session cannot create lasting access (PostgreSQL)', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const role = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
    const passwordHash = await hash(ORIGINAL_PASSWORD, 4);
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
      `INSERT INTO organization_role_permissions
         (id, "organizationId", "organizationRoleId", capability, effect)
       VALUES ($1, $2, $3, '*', 'ALLOW')`,
      [`${ownerRole}_all`, organizationId, ownerRole]
    );
    for (const [id, email, role, organizationRoleId] of [
      [OWNER, 'owner@test.invalid', 'ADMIN', ownerRole],
      [STAFF, 'staff@test.invalid', 'EMPLOYEE', null],
    ] as const) {
      await client.query(
        `INSERT INTO users (id, "organizationId", "organizationRoleId", name, email, password,
           role, department, title, status, "updatedAt")
         VALUES ($1, $2, $3, $1, $4, $5, $6, 'ENGINEERING', 'Member', 'ACTIVE', now())`,
        [id, organizationId, organizationRoleId, email, passwordHash, role]
      );
    }
  });

  afterAll(async () => {
    if (!client) return;
    // Audit rows are retention-locked by the database, so the organization that holds them
    // stays behind in the disposable test database; the credentials are removed.
    try {
      for (const table of ['organization_scim_tokens', 'api_tokens']) {
        await client.query(`DELETE FROM ${table} WHERE "organizationId" = $1`, [organizationId]);
      }
    } finally {
      await client.end();
    }
  });

  it('refuses a new administrator', async () => {
    await expectRefusedAndAudited('organizationAdmin.createMember', () =>
      as('support', (caller) =>
        caller.organizationAdmin.createMember({
          name: 'Operator Backdoor',
          email: 'backdoor@test.invalid',
          password: OPERATOR_PASSWORD,
          title: 'Administrator',
          role: 'ADMIN',
          department: 'ENGINEERING',
        })
      )
    );
    expect(await count('users')).toBe(2);
  });

  it('refuses an invitation', async () => {
    await expectRefusedAndAudited('team.inviteMember', () =>
      as('support', (caller) =>
        caller.team.inviteMember({
          name: 'Operator Backdoor',
          email: 'backdoor@test.invalid',
          role: 'ADMIN',
          department: 'ENGINEERING',
          title: 'Administrator',
        })
      )
    );
    expect(await count('users')).toBe(2);
    expect(await count('invitations')).toBe(0);
  });

  it('refuses both password resets and leaves the password as it was', async () => {
    await expectRefusedAndAudited('organizationAdmin.resetMemberPassword', () =>
      as('support', (caller) =>
        caller.organizationAdmin.resetMemberPassword({ id: STAFF, password: OPERATOR_PASSWORD })
      )
    );
    await expectRefusedAndAudited('team.adminResetPassword', () =>
      as('support', (caller) =>
        caller.team.adminResetPassword({ id: STAFF, newPassword: OPERATOR_PASSWORD })
      )
    );
    const row = await client.query('SELECT password FROM users WHERE id = $1', [STAFF]);
    expect(await compare(ORIGINAL_PASSWORD, row.rows[0].password)).toBe(true);
    expect(await compare(OPERATOR_PASSWORD, row.rows[0].password)).toBe(false);
  });

  it('refuses an API token and a SCIM token', async () => {
    await expectRefusedAndAudited('apiTokens.create', () =>
      as('support', (caller) =>
        caller.apiTokens.create({ name: 'operator key', scopes: ['projects:read'] })
      )
    );
    await expectRefusedAndAudited('organizationAdmin.createScimToken', () =>
      as('support', (caller) =>
        caller.organizationAdmin.createScimToken({ name: 'operator scim', expiresAt: null })
      )
    );
    expect(await count('api_tokens')).toBe(0);
    expect(await count('organization_scim_tokens')).toBe(0);
  });

  it('still lets the support session read', async () => {
    const departments = await as('support', (caller) => caller.organizationAdmin.departments());
    expect(departments.map((department) => department.key)).toContain('ENGINEERING');
    await expect(as('support', (caller) => caller.apiTokens.list())).resolves.toEqual([]);
  });

  it('still lets the support session fix ordinary data', async () => {
    const saved = await as('support', (caller) =>
      caller.organizationAdmin.updateProfile({
        displayName: 'Corrected Trading Name',
        timezone: 'Asia/Karachi',
        locale: 'en-PK',
        primaryContactName: null,
        primaryContactEmail: '',
      })
    );
    expect(saved.displayName).toBe('Corrected Trading Name');
    const department = await as('support', (caller) =>
      caller.organizationAdmin.upsertDepartment({ key: 'COUNTER', name: 'Counter' })
    );
    expect(department).toMatchObject({ key: 'COUNTER', name: 'Counter' });
    const row = await client.query('SELECT "displayName" FROM organizations WHERE id = $1', [
      organizationId,
    ]);
    expect(row.rows[0].displayName).toBe('Corrected Trading Name');
  });

  it('lets the owner do the same things from their own session', async () => {
    const token = await as('owner', (caller) =>
      caller.apiTokens.create({ name: 'owner key', scopes: ['projects:read'] })
    );
    expect(token.token).toEqual(expect.any(String));
    const scim = await as('owner', (caller) =>
      caller.organizationAdmin.createScimToken({ name: 'owner scim', expiresAt: null })
    );
    expect(scim.token).toMatch(/^scim_/);
    await as('owner', (caller) =>
      caller.organizationAdmin.resetMemberPassword({ id: STAFF, password: OPERATOR_PASSWORD })
    );
    const row = await client.query('SELECT password FROM users WHERE id = $1', [STAFF]);
    expect(await compare(OPERATOR_PASSWORD, row.rows[0].password)).toBe(true);
    expect(await count('api_tokens')).toBe(1);
    expect(await count('organization_scim_tokens')).toBe(1);
  });
});
