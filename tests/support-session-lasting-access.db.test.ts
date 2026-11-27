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
 * It is also refused the owner's connected mailbox (listing, reading, syncing, sending) and
 * both halves of the public password reset, so it cannot ask for a reset link, read it out
 * of the mailbox and set a password it knows. The owner and an anonymous visitor still can.
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

const mail = vi.hoisted(() => ({ send: vi.fn(), sync: vi.fn() }));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
// The mail provider is the outside world: sending and syncing are captured, never performed.
vi.mock('@/lib/email/adapter', () => ({
  adapterForMailbox: () => ({ sendMessage: mail.send, getMessage: vi.fn(async () => null) }),
}));
vi.mock('@/lib/email/sync', () => ({ syncMailbox: mail.sync }));
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

import { hashInviteToken } from '@/lib/invite-token';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { SUPPORT_SESSION_REFUSED_MESSAGE } from '@/lib/tenancy/support-session-rule';
import { flushAuditWritesForTest } from '@/server/audit';
import { router, type TRPCContext } from '@/server/trpc';
import { apiTokensRouter } from '@/server/routers/api-tokens';
import { emailRouter } from '@/server/routers/email';
import { organizationAdminRouter } from '@/server/routers/organization-admin';
import { passwordResetRouter } from '@/server/routers/password-reset';
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
  email: emailRouter,
  organizationAdmin: organizationAdminRouter,
  passwordReset: passwordResetRouter,
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
const MAILBOX = `${organizationId}_mailbox`;
const RESET_MAIL = `${organizationId}_reset_mail`;
/** Synthetic one-time links. Only their hashes are stored. */
const SUPPORT_RESET_LINK = `support-${randomBytes(24).toString('hex')}`;
const VISITOR_RESET_LINK = `visitor-${randomBytes(24).toString('hex')}`;
const VISITOR_PASSWORD = 'Visitor-chosen-passphrase-1';

let client: pg.Client;

type Actor = 'support' | 'owner' | 'visitor';

function context(db: ScopedDb, actor: Actor): TRPCContext {
  const support = actor === 'support';
  // A visitor has no session at all: the public reset pages before sign-in.
  if (actor === 'visitor') {
    return {
      db,
      entitlements: { organizationId, enabledModules: [], modules: [], limits: {} },
      session: null,
      organization: { id: organizationId, isDemo: false },
      support: null,
      requestMeta: { ip: '203.0.113.10', userAgent: 'vitest' },
      audit: { detail: {} },
    } as unknown as TRPCContext;
  }
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
const as = <T>(actor: Actor, run: (caller: ReturnType<typeof app.createCaller>) => Promise<T>) =>
  withTenantDb(organizationId, (db) => run(app.createCaller(context(db, actor))));

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
      for (const table of [
        'organization_scim_tokens',
        'api_tokens',
        'password_reset_tokens',
        'mailboxes',
        'platform_jobs',
      ]) {
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

  describe('the owner\u2019s mailbox and the password reset', () => {
    const resetJobs = async () =>
      (
        await client.query(
          `SELECT count(*)::int AS n FROM platform_jobs
            WHERE type = 'password.reset.request.v1' AND "organizationId" = $1`,
          [organizationId]
        )
      ).rows[0].n as number;
    const ownerPassword = async () =>
      (await client.query('SELECT password FROM users WHERE id = $1', [OWNER])).rows[0]
        .password as string;

    beforeAll(async () => {
      // The owner connected the mailbox their sign-in mail arrives in, and a reset link is
      // already sitting in it.
      await client.query(
        `INSERT INTO mailboxes (id, "organizationId", "userId", type, "emailAddress",
           credentials, status, "updatedAt")
         VALUES ($1, $2, $3, 'GMAIL', 'owner@test.invalid', 'synthetic-ciphertext', 'active', now())`,
        [MAILBOX, organizationId, OWNER]
      );
      await client.query(
        `INSERT INTO email_messages (id, "organizationId", "mailboxId", "providerMessageId",
           "fromAddr", "toAddrs", subject, snippet, "bodyText", "sentAt")
         VALUES ($1, $2, $3, 'provider-1', 'no-reply@test.invalid', '["owner@test.invalid"]',
           'Reset your password', 'Use this link', $4, now())`,
        [
          RESET_MAIL,
          organizationId,
          MAILBOX,
          `https://test.invalid/reset?token=${SUPPORT_RESET_LINK}`,
        ]
      );
      for (const [id, link] of [
        ['support', SUPPORT_RESET_LINK],
        ['visitor', VISITOR_RESET_LINK],
      ]) {
        await client.query(
          `INSERT INTO password_reset_tokens (id, "organizationId", "userId", "tokenHash", "expiresAt")
           VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
          [`${organizationId}_reset_${id}`, organizationId, OWNER, hashInviteToken(link)]
        );
      }
    });

    it('refuses the support session every read of the mailbox', async () => {
      await expectRefusedAndAudited('email.listMailboxes', () =>
        as('support', (caller) => caller.email.listMailboxes())
      );
      await expectRefusedAndAudited('email.listMessages', () =>
        as('support', (caller) => caller.email.listMessages({ mailboxId: MAILBOX }))
      );
      await expectRefusedAndAudited('email.getMessage', () =>
        as('support', (caller) => caller.email.getMessage({ id: RESET_MAIL }))
      );
    });

    it('refuses the support session syncing, sending and marking mail read', async () => {
      await expectRefusedAndAudited('email.refresh', () =>
        as('support', (caller) => caller.email.refresh({ mailboxId: MAILBOX }))
      );
      await expectRefusedAndAudited('email.sendMessage', () =>
        as('support', (caller) =>
          caller.email.sendMessage({
            mailboxId: MAILBOX,
            to: ['operator@test.invalid'],
            subject: 'Forwarded',
            html: '<p>reset link</p>',
          })
        )
      );
      await expectRefusedAndAudited('email.markRead', () =>
        as('support', (caller) => caller.email.markRead({ id: RESET_MAIL }))
      );
      expect(mail.sync).not.toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
      const row = await client.query('SELECT "isRead" FROM email_messages WHERE id = $1', [
        RESET_MAIL,
      ]);
      expect(row.rows[0].isRead).toBe(false);
    });

    it('refuses the support session a password reset request and queues nothing', async () => {
      const tokensBefore = await count('password_reset_tokens');
      await expectRefusedAndAudited('passwordReset.request', () =>
        as('support', (caller) => caller.passwordReset.request({ email: 'owner@test.invalid' }))
      );
      expect(await resetJobs()).toBe(0);
      expect(await count('password_reset_tokens')).toBe(tokensBefore);
    });

    it('refuses the support session completing a reset with a real link', async () => {
      await expectRefusedAndAudited('passwordReset.reset', () =>
        as('support', (caller) =>
          caller.passwordReset.reset({ token: SUPPORT_RESET_LINK, newPassword: OPERATOR_PASSWORD })
        )
      );
      expect(await compare(ORIGINAL_PASSWORD, await ownerPassword())).toBe(true);
      expect(await compare(OPERATOR_PASSWORD, await ownerPassword())).toBe(false);
      const token = await client.query(
        'SELECT "usedAt" FROM password_reset_tokens WHERE "tokenHash" = $1',
        [hashInviteToken(SUPPORT_RESET_LINK)]
      );
      expect(token.rows[0].usedAt).toBeNull();
    });

    it('lets the owner read, sync and send from their own mailbox', async () => {
      const mailboxes = await as('owner', (caller) => caller.email.listMailboxes());
      expect(mailboxes.map((mailbox) => mailbox.id)).toEqual([MAILBOX]);
      const messages = await as('owner', (caller) => caller.email.listMessages());
      expect(messages.map((message) => message.id)).toEqual([RESET_MAIL]);
      const message = await as('owner', (caller) => caller.email.getMessage({ id: RESET_MAIL }));
      expect(message.bodyText).toContain(SUPPORT_RESET_LINK);

      mail.sync.mockResolvedValue(3);
      await expect(
        as('owner', (caller) => caller.email.refresh({ mailboxId: MAILBOX }))
      ).resolves.toEqual({ synced: 3 });
      await as('owner', (caller) =>
        caller.email.sendMessage({
          mailboxId: MAILBOX,
          to: ['supplier@test.invalid'],
          subject: 'Order',
          html: '<p>Order attached</p>',
        })
      );
      expect(mail.send).toHaveBeenCalledTimes(1);
      await as('owner', (caller) => caller.email.markRead({ id: RESET_MAIL }));
      const row = await client.query('SELECT "isRead" FROM email_messages WHERE id = $1', [
        RESET_MAIL,
      ]);
      expect(row.rows[0].isRead).toBe(true);
    });

    it('lets the owner and a visitor request a reset, and a visitor complete one', async () => {
      await expect(
        as('owner', (caller) => caller.passwordReset.request({ email: 'owner@test.invalid' }))
      ).resolves.toEqual({ success: true });
      expect(await resetJobs()).toBe(1);
      await expect(
        as('visitor', (caller) => caller.passwordReset.request({ email: 'owner@test.invalid' }))
      ).resolves.toEqual({ success: true });
      expect(await resetJobs()).toBe(2);

      await expect(
        as('visitor', (caller) =>
          caller.passwordReset.reset({ token: VISITOR_RESET_LINK, newPassword: VISITOR_PASSWORD })
        )
      ).resolves.toEqual({ success: true });
      expect(await compare(VISITOR_PASSWORD, await ownerPassword())).toBe(true);
    });
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
