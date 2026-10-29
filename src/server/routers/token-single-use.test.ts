/**
 * Single use of an invitation / reset token, against a REAL PostgreSQL.
 *
 * A mock cannot establish what this file is for. The old code read the token,
 * then wrote — two statements — so two requests could both pass the read and
 * both proceed. Whether that is actually prevented is decided by PostgreSQL row
 * locking under concurrent transactions, so the test has to run there.
 *
 * Each concurrent attempt opens its OWN `withTenantDb` transaction, exactly as a
 * separate HTTP request would; running them inside one shared transaction would
 * quietly test nothing.
 *
 * Requires TEST_DATABASE_URL (a migrated, seeded, throwaway database — the same
 * variable `test:rls` uses, and never DATABASE_URL). Without it the suite
 * reports itself skipped rather than passing vacuously.
 *
 * DELIBERATELY DOES NOT CALL `assertRlsEnforcingRole` (#39). The property under
 * test is PostgreSQL row locking under concurrency, not tenancy: there is one
 * organization, and every read goes through `withTenantDb(organizationId)` for
 * that same one. A role that bypassed row level security would see exactly the
 * same rows, so the guard would protect nothing. Add it here the day a
 * cross-tenant token case is added — not before.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const inviteHashGate = vi.hoisted(() => {
  let started!: () => void;
  let release!: () => void;
  return {
    started: new Promise<void>((resolve) => (started = resolve)),
    release: new Promise<void>((resolve) => (release = resolve)),
    signalStarted: () => started(),
    signalRelease: () => release(),
  };
});

// Hold one acceptance precisely inside the password hash so the resend race is
// deterministic rather than dependent on bcrypt duration or scheduler timing.
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  return {
    ...actual,
    hash: async (...args: Parameters<typeof actual.hash>) => {
      if (args[0] === 'Rac3!Passw0rd') {
        inviteHashGate.signalStarted();
        await inviteHashGate.release;
      }
      return actual.hash(...args);
    },
  };
});

// The routers reach `@/server/trpc`, which reaches Auth.js, which cannot load
// outside a Next server runtime. Nothing under test uses it: these procedures
// are public, and the context here is built by hand. The database, the routers
// and the scoped-db transactions are all real.
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/email', () => ({
  appUrl: () => 'https://example.test',
  sendEmail: vi.fn(async () => undefined),
  templates: { passwordReset: () => ({ subject: '', html: '', text: '' }) },
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CONCURRENCY = 8;

// The client in `@/lib/db` reads DATABASE_URL when its module is evaluated, so
// this must happen before the dynamic imports below.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const suffix = randomBytes(6).toString('hex');
const id = (prefix: string) => `${prefix}_single_use_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  invitationsRouter: (typeof import('./invitations'))['invitationsRouter'];
  passwordResetRouter: (typeof import('./password-reset'))['passwordResetRouter'];
  INVITATION_GENERIC_MESSAGE: string;
  RESET_GENERIC_MESSAGE: string;
};

let deps: Deps;
let organizationId: string;
let inviteToken: string;
let resetToken: string;

/** The public procedures use only `db` and `requestMeta` from the context. */
const caller = <R extends { createCaller: (ctx: never) => unknown }>(router: R, db: unknown) =>
  router.createCaller({
    db,
    requestMeta: { ip: '203.0.113.9', userAgent: null },
  } as never) as ReturnType<R['createCaller']>;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('token single use, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    deps = {
      withTenantDb: scopedDb.withTenantDb,
      withPlatformDb: scopedDb.withPlatformDb,
      invitationsRouter: (await import('./invitations')).invitationsRouter,
      passwordResetRouter: (await import('./password-reset')).passwordResetRouter,
      ...(await import('@/lib/auth/anonymous-access')),
    };

    // This suite files its users under an existing organization's department, so
    // it needs one whose WHA-278 catalog actually exists. Picking whichever row
    // came back first selected, on a shared test database, an organization some
    // other battery had inserted directly without a department catalog — the
    // fixture then died in `beforeAll` and reported all nine tests as skipped,
    // which reads as a missing env gate rather than a broken fixture. Require
    // the department catalog in the query, and order by id so the choice is
    // deterministic across runs.
    const organization = await deps.withPlatformDb((db) =>
      db.organization.findFirst({
        where: { departments: { some: { active: true } } },
        orderBy: { id: 'asc' },
        select: { id: true },
      })
    );
    if (!organization) {
      throw new Error(
        'TEST_DATABASE_URL points at a database with no organization holding an active department catalog; run migrations and the seed first.'
      );
    }
    organizationId = organization.id;

    inviteToken = randomBytes(32).toString('base64url');
    resetToken = randomBytes(32).toString('base64url');

    await deps.withTenantDb(organizationId, async (db) => {
      const department = await db.organizationDepartment.findFirst({
        where: { organizationId, active: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true },
      });
      if (!department) {
        throw new Error(
          `Organization ${organizationId} has no active department; seed its catalog before running this suite.`
        );
      }

      await db.user.create({
        data: {
          id: id('user_invitee'),
          organizationId,
          email: `invitee.${suffix}@example.test`,
          name: 'Single Use Invitee',
          title: 'Engineer',
          department: department.key,
          role: 'EMPLOYEE',
          status: 'INVITED',
        },
      });
      await db.user.create({
        data: {
          id: id('user_resend'),
          organizationId,
          email: `resend.${suffix}@example.test`,
          name: 'Resent Invitee',
          title: 'Engineer',
          department: department.key,
          role: 'EMPLOYEE',
          status: 'INVITED',
        },
      });
      await db.user.create({
        data: {
          id: id('user_resetter'),
          organizationId,
          email: `resetter.${suffix}@example.test`,
          name: 'Single Use Resetter',
          title: 'Engineer',
          department: department.key,
          role: 'EMPLOYEE',
          status: 'ACTIVE',
          password: 'not-a-real-hash',
        },
      });
      await db.invitation.create({
        data: {
          id: id('inv'),
          organizationId,
          userId: id('user_invitee'),
          email: `invitee.${suffix}@example.test`,
          tokenHash: hashToken(inviteToken),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      await db.invitation.create({
        data: {
          id: id('inv_resend'),
          organizationId,
          userId: id('user_resend'),
          email: `resend.${suffix}@example.test`,
          tokenHash: hashToken(`${inviteToken}-old`),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      await db.passwordResetToken.create({
        data: {
          id: id('prt'),
          organizationId,
          userId: id('user_resetter'),
          tokenHash: hashToken(resetToken),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
    });
  }, 60_000);

  afterAll(async () => {
    if (!organizationId) return;
    await deps.withTenantDb(organizationId, async (db) => {
      await db.invitation.deleteMany({ where: { id: { in: [id('inv'), id('inv_resend')] } } });
      await db.passwordResetToken.deleteMany({ where: { id: id('prt') } });
      await db.user.deleteMany({
        where: {
          id: { in: [id('user_invitee'), id('user_resetter'), id('user_resend')] },
        },
      });
    });
  }, 60_000);

  it('reads a pending invitation with a valid token', async () => {
    const result = await deps.withTenantDb(organizationId, (db) =>
      caller(deps.invitationsRouter, db).get({ token: inviteToken })
    );

    expect(result.email).toBe(`invitee.${suffix}@example.test`);
  });

  it('reports a valid reset token as usable', async () => {
    const result = await deps.withTenantDb(organizationId, (db) =>
      caller(deps.passwordResetRouter, db).validate({ token: resetToken })
    );

    expect(result).toEqual({ valid: true });
  });

  it.each([
    ['an unknown token', () => 'no-such-token-at-all'],
    ['a token from the other flow', () => resetToken],
  ])('rejects invitations.get for %s with the generic message', async (_label, token) => {
    await expect(
      deps.withTenantDb(organizationId, (db) =>
        caller(deps.invitationsRouter, db).get({ token: token() })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: deps.INVITATION_GENERIC_MESSAGE });
  });

  it('reports an unknown reset token as unusable rather than erroring', async () => {
    const result = await deps.withTenantDb(organizationId, (db) =>
      caller(deps.passwordResetRouter, db).validate({ token: 'no-such-token-at-all' })
    );

    expect(result).toEqual({ valid: false });
  });

  it('accepts an invitation exactly once under real concurrency', async () => {
    const attempts = Array.from({ length: CONCURRENCY }, (_unused, index) =>
      deps.withTenantDb(organizationId, (db) =>
        caller(deps.invitationsRouter, db).accept({
          token: inviteToken,
          password: 'Str0ng!Passw0rd',
          phone: `+1555000${index}`,
        })
      )
    );

    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENCY - 1);
    // Every loser — whether it lost the read or lost the conditional update —
    // says the same thing, so a race is not observable from outside.
    for (const failure of rejected) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({
        code: 'NOT_FOUND',
        message: deps.INVITATION_GENERIC_MESSAGE,
      });
    }

    const [invitation, user] = await deps.withTenantDb(organizationId, async (db) => [
      await db.invitation.findUnique({ where: { id: id('inv') } }),
      await db.user.findUnique({ where: { id: id('user_invitee') } }),
    ]);
    expect(invitation?.acceptedAt).toBeInstanceOf(Date);
    expect(user?.status).toBe('ACTIVE');
    expect(user?.password).toBeTruthy();
  }, 120_000);

  it('does not let an old-token acceptance consume an invitation resent during hashing', async () => {
    const oldToken = `${inviteToken}-old`;
    const newToken = `${inviteToken}-new`;
    const acceptance = deps.withTenantDb(organizationId, (db) =>
      caller(deps.invitationsRouter, db).accept({
        token: oldToken,
        password: 'Rac3!Passw0rd',
        phone: '+15550888',
      })
    );

    await inviteHashGate.started;
    await deps.withTenantDb(organizationId, (db) =>
      db.invitation.update({
        where: { id: id('inv_resend') },
        data: { tokenHash: hashToken(newToken), acceptedAt: null },
      })
    );
    inviteHashGate.signalRelease();

    await expect(acceptance).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: deps.INVITATION_GENERIC_MESSAGE,
    });

    const [invitation, user] = await deps.withTenantDb(organizationId, async (db) => [
      await db.invitation.findUnique({ where: { id: id('inv_resend') } }),
      await db.user.findUnique({ where: { id: id('user_resend') } }),
    ]);
    expect(invitation).toMatchObject({ tokenHash: hashToken(newToken), acceptedAt: null });
    expect(user).toMatchObject({ status: 'INVITED', password: null });
  }, 120_000);

  it('refuses to replay a consumed invitation', async () => {
    await expect(
      deps.withTenantDb(organizationId, (db) =>
        caller(deps.invitationsRouter, db).accept({
          token: inviteToken,
          password: 'Str0ng!Passw0rd',
          phone: '+15550999',
        })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: deps.INVITATION_GENERIC_MESSAGE });
  });

  it('consumes a reset token exactly once under real concurrency', async () => {
    const before = await deps.withTenantDb(organizationId, (db) =>
      db.user.findUnique({
        where: { id: id('user_resetter') },
        select: { tokenVersion: true },
      })
    );

    const attempts = Array.from({ length: CONCURRENCY }, () =>
      deps.withTenantDb(organizationId, (db) =>
        caller(deps.passwordResetRouter, db).reset({
          token: resetToken,
          newPassword: 'An0ther!Passw0rd',
        })
      )
    );

    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const failure of settled.filter((r) => r.status === 'rejected')) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({
        code: 'BAD_REQUEST',
        message: deps.RESET_GENERIC_MESSAGE,
      });
    }

    const [token, after] = await deps.withTenantDb(organizationId, async (db) => [
      await db.passwordResetToken.findUnique({ where: { id: id('prt') } }),
      await db.user.findUnique({
        where: { id: id('user_resetter') },
        select: { tokenVersion: true, password: true },
      }),
    ]);
    expect(token?.usedAt).toBeInstanceOf(Date);
    // AUTH-01: exactly ONE revocation bump. More than one would mean the
    // password was written more than once.
    expect(after?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);
    expect(after?.password).not.toBe('not-a-real-hash');
  }, 120_000);

  it('refuses to replay a consumed reset token', async () => {
    await expect(
      deps.withTenantDb(organizationId, (db) =>
        caller(deps.passwordResetRouter, db).reset({
          token: resetToken,
          newPassword: 'Y3tAnother!Passw0rd',
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: deps.RESET_GENERIC_MESSAGE });
  });
});
