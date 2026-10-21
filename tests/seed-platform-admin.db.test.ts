/**
 * `PLATFORM_ADMIN_PASSWORD` rotation, against a REAL PostgreSQL.
 *
 * The seed's platform-administrator upsert carried `update: { active, role }`
 * with no `passwordHash`, so a rotated password only ever reached a platform
 * administrator that did not exist yet. Every staging redeploy after the first
 * therefore reported a successful seed while leaving the old hash in place, and
 * the smoke login failed with credentials the deployment had just "rotated".
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped rather than
 * passing vacuously.
 *
 * DELIBERATELY DOES NOT CALL `assertRlsEnforcingRole`: nothing here is DECIDED
 * BY row level security. Every read and write goes through `withPlatformDb`
 * (which sets `app.is_platform_admin` on purpose, as the seed's own transaction
 * does), the administrator's email is unique per run, and every query filters
 * by it — wider visibility cannot reach the asserted row.
 */
import { randomBytes } from 'node:crypto';

import { compare, hash } from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// `@/lib/db` reads DATABASE_URL when its module is evaluated, so this must
// happen before the dynamic imports in `beforeAll`.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const suffix = randomBytes(6).toString('hex');
const EXISTING_EMAIL = `rotate-${suffix}@platform.invalid`;
const NEW_EMAIL = `created-${suffix}@platform.invalid`;
const ORIGINAL_PASSWORD = `original-${suffix}`;
const ROTATED_PASSWORD = `rotated-${suffix}`;

type Deps = {
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  upsertPlatformAdmin: (typeof import('../prisma/platform-admin'))['upsertPlatformAdmin'];
};

let deps: Deps;

const readHash = (email: string) =>
  deps.withPlatformDb(async (db) => {
    const row = await db.platformUser.findUnique({
      where: { email },
      select: { passwordHash: true, role: true, active: true },
    });
    return row;
  });

/** Runs the helper exactly as the seed's transaction does. */
const runSeedUpsert = (email: string | undefined, password: string | undefined) =>
  deps.withPlatformDb(async (db) => {
    const previousEmail = process.env.PLATFORM_ADMIN_EMAIL;
    const previousPassword = process.env.PLATFORM_ADMIN_PASSWORD;
    if (email === undefined) delete process.env.PLATFORM_ADMIN_EMAIL;
    else process.env.PLATFORM_ADMIN_EMAIL = email;
    if (password === undefined) delete process.env.PLATFORM_ADMIN_PASSWORD;
    else process.env.PLATFORM_ADMIN_PASSWORD = password;
    try {
      await deps.upsertPlatformAdmin(db);
    } finally {
      if (previousEmail === undefined) delete process.env.PLATFORM_ADMIN_EMAIL;
      else process.env.PLATFORM_ADMIN_EMAIL = previousEmail;
      if (previousPassword === undefined) delete process.env.PLATFORM_ADMIN_PASSWORD;
      else process.env.PLATFORM_ADMIN_PASSWORD = previousPassword;
    }
  });

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('seed platform administrator credentials, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    const platformAdmin = await import('../prisma/platform-admin');
    deps = {
      withPlatformDb: scopedDb.withPlatformDb,
      upsertPlatformAdmin: platformAdmin.upsertPlatformAdmin,
    };

    // The administrator this deployment inherits: already present, demoted and
    // deactivated by an operator, holding the previous password.
    await deps.withPlatformDb(async (db) =>
      db.platformUser.create({
        data: {
          name: 'Platform Administrator',
          email: EXISTING_EMAIL,
          passwordHash: await hash(ORIGINAL_PASSWORD, 12),
          role: 'AUDITOR',
          active: false,
        },
      })
    );
  }, 60_000);

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb((db) =>
      db.platformUser.deleteMany({ where: { email: { in: [EXISTING_EMAIL, NEW_EMAIL] } } })
    );
  }, 60_000);

  it('rewrites an existing administrator hash so the rotated password verifies', async () => {
    const before = await readHash(EXISTING_EMAIL);
    expect(before).not.toBeNull();
    expect(await compare(ORIGINAL_PASSWORD, before!.passwordHash)).toBe(true);

    await runSeedUpsert(EXISTING_EMAIL, ROTATED_PASSWORD);

    const after = await readHash(EXISTING_EMAIL);
    expect(after!.passwordHash).not.toBe(before!.passwordHash);
    expect(await compare(ROTATED_PASSWORD, after!.passwordHash)).toBe(true);
    // The stale hash is the defect's signature: it used to survive the upsert.
    expect(await compare(ORIGINAL_PASSWORD, after!.passwordHash)).toBe(false);
    expect(after).toMatchObject({ role: 'SUPER_ADMIN', active: true });
  }, 60_000);

  it('leaves the hash untouched when neither variable is set', async () => {
    const before = await readHash(EXISTING_EMAIL);

    await runSeedUpsert(undefined, undefined);

    expect((await readHash(EXISTING_EMAIL))!.passwordHash).toBe(before!.passwordHash);
  }, 60_000);

  it('still creates an administrator that does not exist yet', async () => {
    expect(await readHash(NEW_EMAIL)).toBeNull();

    await runSeedUpsert(NEW_EMAIL.toUpperCase(), ROTATED_PASSWORD);

    const created = await readHash(NEW_EMAIL);
    expect(created).toMatchObject({ role: 'SUPER_ADMIN', active: true });
    expect(await compare(ROTATED_PASSWORD, created!.passwordHash)).toBe(true);
  }, 60_000);

  it('refuses a half-configured administrator rather than seeding silently', async () => {
    await expect(runSeedUpsert(EXISTING_EMAIL, undefined)).rejects.toThrow(
      /PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD/
    );
    await expect(runSeedUpsert(undefined, ROTATED_PASSWORD)).rejects.toThrow(
      /PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD/
    );
  }, 60_000);
});
