/**
 * WHA-1563 — the real-PostgreSQL acceptance battery for the scheduled pharmacy
 * owner digest (WHA-1534 `processDueOwnerDigests`).
 *
 * The WHA-1534/WHA-1539 source-double suite (`owner-digest.test.ts`, 39 cases)
 * already pins the composition, rendering and clock arithmetic against in-memory
 * doubles. NONE of those cases are replayed here. What a double structurally
 * cannot decide is the part of this scheduler that is a DATABASE contract:
 *
 *   - the compare-and-set claim is only "exactly once" because `updateMany`
 *     takes a real row lock held to tenant commit, so competing workers serialize
 *     on PostgreSQL rather than on a mock's call order;
 *   - a `throw` out of `withTenantDb` is only a rollback because the claim, the
 *     anomaly refresh and the capture share ONE interactive transaction;
 *   - the tenant/branch/module/permission negatives are only meaningful under
 *     FORCE ROW LEVEL SECURITY with a role that cannot bypass it.
 *
 * Every case therefore drives the ACTUAL exported `processDueOwnerDigests` against
 * migrated PostgreSQL. Nothing is mocked — not the database, not the permission
 * decision, not the lock outcome, not the transaction commit. Contention is
 * created with separate pooled connections and settled with a WITNESSED lock
 * barrier (`pg_blocking_pids`), never a sleep. The only external channel seam
 * (`WhatsAppChannel`) is never configured and never reached: `processDueOwnerDigests`
 * captures internally through `CaptureChannel` and that is all this asserts.
 *
 * ── Runtime prerequisites (fail closed; NEVER falls back to DATABASE_URL) ──
 *
 *   PHARMACY_DIGEST_TEST_RUNTIME_DATABASE_URL (or the shared TEST_DATABASE_URL)
 *       A migrated, DISPOSABLE database reached through a restricted role that is
 *       neither SUPERUSER nor BYPASSRLS. `beforeAll` asserts that role before any
 *       isolation claim is made. The whole file skips when this is unset — it is
 *       never silently passed, and it never borrows the developer/demo database.
 *
 *   PHARMACY_DIGEST_TEST_OWNER_DATABASE_URL
 *       OPTIONAL, and required only by the after-claim rollback case. Injecting a
 *       genuine mid-transaction failure needs a table-owning role, so that one case
 *       creates a per-run BEFORE INSERT trigger on `pharmacy_owner_digest_captures`,
 *       scoped by `WHEN (NEW."organizationId" = <this run's org>)` so no concurrent
 *       suite can observe it, and drops it in a `finally`. This is TEST-LOCAL DDL on
 *       a disposable database only: it is not a migration, it is not production DDL,
 *       and it must never be pointed at a shared or long-lived database. The case
 *       skips rather than degrades when the URL is absent, and refuses to run if the
 *       owner URL is the same as the restricted runtime URL (a runtime role that can
 *       DDL its own tables would invalidate the restriction this suite depends on).
 *
 * The connection pool must allow at least 5 concurrent connections: the lock-order
 * case deliberately holds one tenant transaction open while a second transaction
 * blocks on it and a third witnesses the block.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL =
  process.env.PHARMACY_DIGEST_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const OWNER_DATABASE_URL = process.env.PHARMACY_DIGEST_TEST_OWNER_DATABASE_URL;

// The provider seam must stay unconfigured: this battery asserts internal capture
// only, and a configured provider would be a claim this suite has not earned.
delete process.env.PHARMACY_WHATSAPP_PROVIDER;
delete process.env.PHARMACY_WHATSAPP_ACCESS_TOKEN;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const itIfOwner = OWNER_DATABASE_URL ? it : it.skip;

const suffix = randomBytes(6).toString('hex');
/** Primary tenant. Every case gets its OWN owner/branch/setting inside it. */
const ORG_A = `org_wha1563_a_${suffix}`;
/** Isolation witness only — never scheduled. */
const ORG_B = `org_wha1563_b_${suffix}`;
/** Module-entitlement negatives only: revoking a module is organization-wide, so
 * it is quarantined here and can never perturb ORG_A's cases. */
const ORG_C = `org_wha1563_c_${suffix}`;

/** UTC+5, no DST: local-day arithmetic is decidable by inspection. */
const TIMEZONE = 'Asia/Karachi';
/** 08:00 local. */
const TIME_MINUTES = 480;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  processDueOwnerDigests: (typeof import('./owner-digest'))['processDueOwnerDigests'];
};

let deps: Deps;

const inOrg = <T>(organizationId: string, run: (db: ScopedDb) => Promise<T>) =>
  deps.withTenantDb(organizationId, run);

/** Organization + department catalog + (optionally) the `pharmacy-reports` grant. */
async function createOrganization(organizationId: string, options: { module: boolean }) {
  await deps.withPlatformDb(async (tx) => {
    await tx.organization.create({
      data: {
        id: organizationId,
        slug: organizationId.replace(/_/g, '-'),
        legalName: `WHA-1563 ${organizationId}`,
        displayName: 'WHA-1563 Digest',
        status: 'ACTIVE',
        vertical: 'PHARMACY',
        timezone: TIMEZONE,
      },
    });
    await seedDepartments(tx, [organizationId], ['LEADERSHIP']);
    if (!options.module) return;
    const reports = await ensurePlatformModule(tx, 'pharmacy-reports', {
      name: 'Pharmacy Reports',
      category: 'Reports',
    });
    await tx.organizationModule.create({
      data: { organizationId, moduleId: reports.id },
    });
  });
}

/**
 * One owner (ADMIN + ACTIVE) on one active branch, holding EXACTLY the two
 * capabilities `readAuthorizedDigestSetting` demands. `reports:operational` and
 * `reports:financial` carry no static policy, so they are default-deny and must
 * come from a real organization role — the same DB path production uses.
 */
async function createOwner(organizationId: string, tag: string) {
  const branchId = `branch_${tag}_${suffix}`;
  const userId = `user_${tag}_${suffix}`;
  const roleId = `role_${tag}_${suffix}`;
  await inOrg(organizationId, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: branchId,
        name: `Branch ${tag}`,
        addressLine: '1 Digest Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    await db.organizationRole.create({
      data: {
        id: roleId,
        key: `digest_${tag}_${suffix}`,
        name: `Digest Owner ${tag}`,
        permissions: {
          create: [
            { capability: 'reports:operational', effect: 'ALLOW' },
            { capability: 'reports:financial', effect: 'ALLOW' },
          ],
        },
      },
    });
    await db.user.create({
      data: {
        id: userId,
        name: `Owner ${tag}`,
        email: `${tag}_${suffix}@wha1563.test.local`,
        department: 'LEADERSHIP',
        title: 'Owner',
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationRoleId: roleId,
      },
    });
  });
  return { organizationId, branchId, userId, roleId, tag };
}

type Owner = Awaited<ReturnType<typeof createOwner>>;

/** An enabled digest setting due at `nextDueAt`. */
async function createSetting(owner: Owner, nextDueAt: Date) {
  return inOrg(owner.organizationId, (db) =>
    db.pharmacyOwnerDigestSetting.create({
      data: {
        userId: owner.userId,
        branchId: owner.branchId,
        enabled: true,
        timeMinutes: TIME_MINUTES,
        nextDueAt,
      },
      select: { id: true, nextDueAt: true, updatedAt: true, enabled: true },
    })
  );
}

const readSetting = (owner: Owner, id: string) =>
  inOrg(owner.organizationId, (db) =>
    db.pharmacyOwnerDigestSetting.findUniqueOrThrow({
      where: { id },
      select: { enabled: true, nextDueAt: true, timeMinutes: true },
    })
  );

const readCaptures = (owner: Owner) =>
  inOrg(owner.organizationId, (db) =>
    db.pharmacyOwnerDigestCapture.findMany({
      where: { userId: owner.userId, branchId: owner.branchId },
      select: { id: true, businessDate: true, rendered: true, metrics: true },
      orderBy: { capturedAt: 'asc' },
    })
  );

/**
 * Leave a setting un-due so a later case's platform-wide due scan cannot pick it
 * up. `processDueOwnerDigests` scans every organization, so cases that end with a
 * still-due row must retire it explicitly rather than rely on ordering.
 */
const retire = (owner: Owner, id: string) =>
  inOrg(owner.organizationId, (db) =>
    db.pharmacyOwnerDigestSetting.update({
      where: { id },
      data: { enabled: false, nextDueAt: null },
    })
  );

/**
 * WITNESSED lock barrier. Polls until PostgreSQL itself reports at least one
 * backend blocked by `blockerPid`, and FAILS if that is never observed. This is a
 * wait on observed lock state, not a timed sleep: a passing assertion means the
 * contending statement genuinely queued behind a held row lock.
 */
async function waitUntilSomeoneIsBlockedBy(blockerPid: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const blocked = await deps.withPlatformDb(
      (tx) => tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))`
    );
    if (blocked.length > 0) return blocked.map((row) => row.pid);
    if (Date.now() > deadline) {
      throw new Error(
        `No backend was ever observed blocked by pid ${blockerPid}: the claim did not contend for the setting row lock.`
      );
    }
  }
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, ownerDigest] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./owner-digest'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    processDueOwnerDigests: ownerDigest.processDueOwnerDigests,
  };

  // Refuse a privileged connection rather than let the isolation cases pass vacuously.
  await assertRlsEnforcingRole(deps.withPlatformDb);

  await createOrganization(ORG_A, { module: true });
  await createOrganization(ORG_B, { module: true });
  await createOrganization(ORG_C, { module: true });
}, 180_000);

/**
 * `processDueOwnerDigests` scans EVERY organization, so one case's still-due row is
 * another case's phantom capture. The per-case `retire(...)` calls below only run on
 * the success path, which means a single failure silently contaminates every later
 * case's `captured` count and hides its real verdict. Retiring unconditionally here
 * keeps each case's failure its own.
 */
afterEach(async () => {
  if (!TEST_DATABASE_URL || !deps) return;
  await deps.withPlatformDb((tx) =>
    tx.pharmacyOwnerDigestSetting.updateMany({
      where: { organizationId: { in: [ORG_A, ORG_B, ORG_C] } },
      data: { enabled: false, nextDueAt: null },
    })
  );
}, 60_000);

describeIfDatabase('WHA-1563 pharmacy owner digest scheduler against real PostgreSQL', () => {
  it('captures a due occurrence exactly once under competing workers and a replay', async () => {
    const owner = await createOwner(ORG_A, 'race');
    // 03:00Z = 08:00 Asia/Karachi on 2026-09-10.
    const dueAt = new Date('2026-09-10T03:00:00.000Z');
    const setting = await createSetting(owner, dueAt);
    const now = new Date('2026-09-10T03:05:00.000Z');

    // Two independent workers, two pooled connections, one genuinely contended
    // compare-and-set. No ordering is imposed: PostgreSQL decides the winner.
    const [first, second] = await Promise.all([
      deps.processDueOwnerDigests(now),
      deps.processDueOwnerDigests(now),
    ]);
    // A third pass replays the same scheduler after the claim advanced the row.
    const replay = await deps.processDueOwnerDigests(now);

    const captures = await readCaptures(owner);
    expect(captures).toHaveLength(1);
    // `captured` is the scheduler's own receipt and must agree with the committed
    // row: exactly one worker may claim the occurrence, and the replay claims none.
    expect(first.captured + second.captured).toBe(1);
    expect(replay.captured).toBe(0);

    // The persisted capture carries the immutable RPT-01 detail, not a summary.
    const capture = captures[0]!;
    expect(capture.businessDate).toBe('2026-09-10');
    expect(capture.rendered).toContain(`Branch ${owner.tag}`);
    expect(capture.rendered).toContain('2026-09-10');
    const metrics = capture.metrics as Array<{ key: string; label: string; definition: string }>;
    expect(metrics).toHaveLength(13);
    expect(metrics.map((metric) => metric.key)).toContain('salesMinor');
    expect(metrics.every((metric) => typeof metric.definition === 'string')).toBe(true);

    // The claim advanced the schedule past `now`; the occurrence cannot recur.
    const after = await readSetting(owner, setting.id);
    expect(after.enabled).toBe(true);
    expect(after.nextDueAt!.getTime()).toBeGreaterThan(now.getTime());
    await retire(owner, setting.id);
  }, 180_000);

  it('lets a committed disable win over a claim that has not happened yet', async () => {
    const owner = await createOwner(ORG_A, 'disable');
    const dueAt = new Date('2026-09-11T03:00:00.000Z');
    const setting = await createSetting(owner, dueAt);
    const now = new Date('2026-09-11T03:05:00.000Z');

    await inOrg(ORG_A, (db) =>
      db.pharmacyOwnerDigestSetting.update({
        where: { id: setting.id },
        data: { enabled: false },
      })
    );

    const result = await deps.processDueOwnerDigests(now);

    expect(result.captured).toBe(0);
    expect(await readCaptures(owner)).toHaveLength(0);
    // The disable is preserved exactly: nothing re-enabled or rescheduled it.
    const after = await readSetting(owner, setting.id);
    expect(after.enabled).toBe(false);
    expect(after.nextDueAt!.getTime()).toBe(dueAt.getTime());
    await retire(owner, setting.id);
  }, 180_000);

  it('lets a committed reschedule win: the due scan no longer selects the occurrence', async () => {
    const owner = await createOwner(ORG_A, 'resched');
    const dueAt = new Date('2026-09-12T03:00:00.000Z');
    const setting = await createSetting(owner, dueAt);
    const now = new Date('2026-09-12T03:05:00.000Z');

    // The owner moves the digest later, and commits before any worker runs.
    const moved = new Date('2026-09-20T03:00:00.000Z');
    await inOrg(ORG_A, (db) =>
      db.pharmacyOwnerDigestSetting.update({
        where: { id: setting.id },
        data: { nextDueAt: moved },
      })
    );

    // Because the edit committed first, the scheduler's due scan (`nextDueAt <= now`)
    // no longer selects this row at all: the occurrence is dropped BEFORE any
    // compare-and-set is attempted. This case proves that exclusion, not a stale CAS.
    const result = await deps.processDueOwnerDigests(now);

    expect(result.captured).toBe(0);
    expect(await readCaptures(owner)).toHaveLength(0);
    const after = await readSetting(owner, setting.id);
    expect(after.nextDueAt!.getTime()).toBe(moved.getTime());
    await retire(owner, setting.id);
  }, 180_000);

  it('holds the setting row lock to commit, so a contending edit orders against the claim', async () => {
    const owner = await createOwner(ORG_A, 'lock');
    const dueAt = new Date('2026-09-13T03:00:00.000Z');
    const setting = await createSetting(owner, dueAt);
    const now = new Date('2026-09-13T03:05:00.000Z');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let editorLocked!: (pid: number) => void;
    const lockHeld = new Promise<number>((resolve) => {
      editorLocked = resolve;
    });

    // An owner edit takes the row lock FIRST and holds its transaction open.
    const editor = inOrg(ORG_A, async (db) => {
      const [{ pid }] = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid`;
      await db.pharmacyOwnerDigestSetting.update({
        where: { id: setting.id },
        data: { timeMinutes: 510 },
      });
      // Signalled only once the UPDATE has RESOLVED, so the row lock is genuinely
      // held — knowing the backend pid alone would not prove that.
      editorLocked(pid);
      await gate;
    });

    const editorPid = await lockHeld;

    const worker = deps.processDueOwnerDigests(now);
    // PostgreSQL — not this test — reports that the claim is queued behind the edit.
    // The gate is released on the failure path too, so a witness that never observes
    // the block fails the test instead of hanging behind this open transaction.
    const blocked = await waitUntilSomeoneIsBlockedBy(editorPid).finally(release);
    expect(blocked.length).toBeGreaterThan(0);

    await editor;
    const result = await worker;

    // The edit committed first, so the claim's compare-and-set no longer matches
    // the row version it read, and the occurrence is not captured on this pass.
    expect(result.captured).toBe(0);
    expect(await readCaptures(owner)).toHaveLength(0);
    const after = await readSetting(owner, setting.id);
    expect(after.timeMinutes).toBe(510);
    expect(after.nextDueAt!.getTime()).toBe(dueAt.getTime());
    await retire(owner, setting.id);
  }, 180_000);

  itIfOwner(
    'rolls the claim back with the capture when the owning transaction fails',
    async () => {
      if (OWNER_DATABASE_URL === TEST_DATABASE_URL) {
        throw new Error(
          'PHARMACY_DIGEST_TEST_OWNER_DATABASE_URL must be a distinct, table-owning role: the restricted runtime role must not be able to DDL its own tables.'
        );
      }
      const owner = await createOwner(ORG_A, 'rollback');
      const dueAt = new Date('2026-09-14T03:00:00.000Z');
      const setting = await createSetting(owner, dueAt);
      const now = new Date('2026-09-14T03:05:00.000Z');

      // Identifiers are interpolated into DDL, so prove they cannot carry SQL.
      if (!/^[a-z0-9_]+$/.test(ORG_A) || !/^[a-z0-9]+$/.test(suffix)) {
        throw new Error('Refusing to build test DDL from an unexpected identifier.');
      }
      const guard = `wha1563_block_capture_${suffix}`;

      const { Client } = await import('pg');
      const ownerClient = new Client({ connectionString: OWNER_DATABASE_URL });
      await ownerClient.connect();
      try {
        // TEST-LOCAL DDL on a disposable database. Scoped by organization so a
        // concurrently running suite can never observe it, and dropped below.
        await ownerClient.query(
          `CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN RAISE EXCEPTION 'WHA-1563 injected capture failure'; END; $$`
        );
        await ownerClient.query(
          `CREATE TRIGGER ${guard} BEFORE INSERT ON "pharmacy_owner_digest_captures"
             FOR EACH ROW WHEN (NEW."organizationId" = '${ORG_A}')
             EXECUTE FUNCTION ${guard}()`
        );

        // The failure happens AFTER the claim and after the anomaly refresh, so it
        // can only be survived by rolling the whole tenant transaction back.
        await expect(deps.processDueOwnerDigests(now)).rejects.toThrow(
          /WHA-1563 injected capture failure/
        );
      } finally {
        await ownerClient
          .query(`DROP TRIGGER IF EXISTS ${guard} ON "pharmacy_owner_digest_captures"`)
          .catch(() => undefined);
        await ownerClient.query(`DROP FUNCTION IF EXISTS ${guard}()`).catch(() => undefined);
        await ownerClient.end();
      }

      // Nothing committed: no capture, and the schedule did NOT advance, so the
      // occurrence is still owed rather than silently consumed by a failed run.
      expect(await readCaptures(owner)).toHaveLength(0);
      const after = await readSetting(owner, setting.id);
      expect(after.enabled).toBe(true);
      expect(after.nextDueAt!.getTime()).toBe(dueAt.getTime());

      // With the guard gone the same occurrence is still claimable and captures.
      const retried = await deps.processDueOwnerDigests(now);
      expect(retried.captured).toBe(1);
      expect(await readCaptures(owner)).toHaveLength(1);
      await retire(owner, setting.id);
    },
    180_000
  );

  it('bills a delayed retry to the scheduled business date, not the day it ran', async () => {
    const owner = await createOwner(ORG_A, 'delayed');
    // 20:00Z on 2026-09-15 is 01:00 Asia/Karachi on 2026-09-16: the local day the
    // occurrence belongs to differs from its UTC day, so a UTC shortcut would fail.
    const dueAt = new Date('2026-09-15T20:00:00.000Z');
    const setting = await createSetting(owner, dueAt);
    // The worker is four days late.
    const now = new Date('2026-09-19T11:00:00.000Z');

    const result = await deps.processDueOwnerDigests(now);

    expect(result.captured).toBe(1);
    const captures = await readCaptures(owner);
    expect(captures).toHaveLength(1);
    expect(captures[0]!.businessDate).toBe('2026-09-16');
    expect(captures[0]!.businessDate).not.toBe('2026-09-19');
    expect(captures[0]!.rendered).toContain('2026-09-16');
    await retire(owner, setting.id);
  }, 180_000);

  it('isolates settings and captures across tenants under forced row level security', async () => {
    const ownerA = await createOwner(ORG_A, 'isoa');
    const ownerB = await createOwner(ORG_B, 'isob');
    const dueAt = new Date('2026-09-17T03:00:00.000Z');
    const settingA = await createSetting(ownerA, dueAt);
    // ORG_B's setting is never due, so only ORG_A's occurrence is scheduled.
    const settingB = await createSetting(ownerB, new Date('2026-12-01T03:00:00.000Z'));
    const now = new Date('2026-09-17T03:05:00.000Z');

    expect((await deps.processDueOwnerDigests(now)).captured).toBe(1);

    await inOrg(ORG_A, async (db) => {
      // The isolation claims below are only load-bearing under a role that is
      // subject to row level security.
      const role = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      // Positive control, then the isolation assertion on the same connection.
      expect(await db.pharmacyOwnerDigestSetting.count({ where: { id: settingA.id } })).toBe(1);
      expect(await db.pharmacyOwnerDigestSetting.count({ where: { id: settingB.id } })).toBe(0);
      expect(await db.pharmacyOwnerDigestCapture.count({ where: { userId: ownerA.userId } })).toBe(
        1
      );
      expect(await db.pharmacyOwnerDigestCapture.count({ where: { userId: ownerB.userId } })).toBe(
        0
      );
    });
    await inOrg(ORG_B, async (db) => {
      expect(await db.pharmacyOwnerDigestSetting.count({ where: { id: settingB.id } })).toBe(1);
      expect(await db.pharmacyOwnerDigestSetting.count({ where: { id: settingA.id } })).toBe(0);
      // ORG_A's capture is invisible here even though the scheduler just wrote it.
      expect(await db.pharmacyOwnerDigestCapture.count()).toBe(0);
    });

    await retire(ownerA, settingA.id);
    await retire(ownerB, settingB.id);
  }, 180_000);

  it('refuses and disables a digest whose module or permission authority is gone', async () => {
    const revoked = await createOwner(ORG_A, 'revoked');
    const unlicensed = await createOwner(ORG_C, 'unlic');
    const control = await createOwner(ORG_C, 'ctrl');
    const dueAt = new Date('2026-09-18T03:00:00.000Z');
    const now = new Date('2026-09-18T03:05:00.000Z');

    // Positive control FIRST: this fixture does capture while authority is intact,
    // so the negatives below cannot pass merely because the fixture is inert.
    const controlSetting = await createSetting(control, dueAt);
    expect((await deps.processDueOwnerDigests(now)).captured).toBe(1);
    expect(await readCaptures(control)).toHaveLength(1);
    await retire(control, controlSetting.id);

    // (1) Permission revoked by a committed DENY override on one capability.
    const revokedSetting = await createSetting(revoked, dueAt);
    await inOrg(ORG_A, (db) =>
      db.userPermissionOverride.create({
        data: {
          userId: revoked.userId,
          capability: 'reports:financial',
          effect: 'DENY',
          reason: 'WHA-1563 authority revocation fixture',
        },
      })
    );
    expect((await deps.processDueOwnerDigests(now)).captured).toBe(0);
    expect(await readCaptures(revoked)).toHaveLength(0);
    // Authority loss is not a retry: the scheduler disables the setting outright.
    const afterRevoke = await readSetting(revoked, revokedSetting.id);
    expect(afterRevoke.enabled).toBe(false);
    expect(afterRevoke.nextDueAt).toBeNull();

    // (2) Module entitlement withdrawn organization-wide.
    const unlicensedSetting = await createSetting(unlicensed, dueAt);
    await deps.withPlatformDb((tx) =>
      tx.organizationModule.updateMany({
        where: { organizationId: ORG_C },
        data: { status: 'DISABLED' },
      })
    );
    expect((await deps.processDueOwnerDigests(now)).captured).toBe(0);
    expect(await readCaptures(unlicensed)).toHaveLength(0);
    const afterUnlicensed = await readSetting(unlicensed, unlicensedSetting.id);
    expect(afterUnlicensed.enabled).toBe(false);
    expect(afterUnlicensed.nextDueAt).toBeNull();

    await deps.withPlatformDb((tx) =>
      tx.organizationModule.updateMany({
        where: { organizationId: ORG_C },
        data: { status: 'ENABLED' },
      })
    );
  }, 180_000);
});

afterAll(async () => {
  if (!TEST_DATABASE_URL || !deps) return;
  // Leave no due row behind for anything else sharing this disposable database.
  await deps.withPlatformDb((tx) =>
    tx.pharmacyOwnerDigestSetting.updateMany({
      where: { organizationId: { in: [ORG_A, ORG_B, ORG_C] } },
      data: { enabled: false, nextDueAt: null },
    })
  );
}, 60_000);
