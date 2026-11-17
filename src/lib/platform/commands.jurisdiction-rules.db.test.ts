/**
 * DEV-99 — jurisdiction rule publication against real PostgreSQL.
 *
 * Runs the production command (`executePlatformCommand` → `withPlatformDb`) as
 * the non-owner NOSUPERUSER NOBYPASSRLS runtime role, so the migrations'
 * row-level security, effective-window exclusion constraint and append-only
 * trigger are all in play. Every fixture uses its own TEST_ONLY jurisdiction
 * code: these are made-up storage values, never legal rules, and the suite
 * never publishes a successor of pk_pb_provisional_v1.
 *
 * Rule sets and platform audits are append-only, so fixtures stay in the
 * disposable database under unique names; the fixture operators are
 * deactivated afterwards.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PlatformIdentity } from '@/lib/platform/auth';
import { testOnlyRules } from '@/lib/test-support/jurisdiction-rules';

const url = process.env.TEST_DATABASE_URL;
if (url) {
  process.env.DATABASE_URL = url;
  // A TEST_ONLY key for encrypting the fixture operator's TOTP secret.
  process.env.PLATFORM_ENCRYPTION_KEY ||= 'test-only-dev99-jurisdiction-rules-key';
}
const describeIfDatabase = url ? describe : describe.skip;

type Modules = {
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  executePlatformCommand: (typeof import('@/lib/platform/commands'))['executePlatformCommand'];
  encryptSecret: (typeof import('@/lib/secret-crypto'))['encryptSecret'];
  disconnect: () => Promise<void>;
};
let modules: Modules;

const suffix = randomBytes(5).toString('hex');
const superAdmin = { id: `op_dev99_sa_${suffix}`, role: 'SUPER_ADMIN' } as PlatformIdentity;
const unenrolled = { id: `op_dev99_nomfa_${suffix}`, role: 'SUPER_ADMIN' } as PlatformIdentity;
// TEST_ONLY base32 TOTP secret ("Hello!\xde\xad\xbe\xef").
const totpSecret = 'JBSWY3DPEHPK3PXP';
const day = 24 * 60 * 60 * 1000;
/** UTC midnight `days` from today: publications start on a day boundary. */
function midnightIn(days: number) {
  return new Date(Math.floor(Date.now() / day) * day + days * day);
}
let fixtureCount = 0;

function totp(at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const digest = createHmac('sha1', Buffer.from('48656c6c6f21deadbeef', 'hex'))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

/** A fresh, open, non-placeholder TEST_ONLY jurisdiction at version 1. */
async function predecessor() {
  fixtureCount += 1;
  const code = `TEST_ONLY_DEV99_${suffix}_${fixtureCount}`;
  return modules.withPlatformDb((db) =>
    db.jurisdictionRuleSet.create({
      data: {
        id: `test_only_dev99_${suffix}_${fixtureCount}_v1`,
        code,
        version: 1,
        effectiveFrom: new Date(Date.now() - day),
        ...testOnlyRules,
      },
    })
  );
}

function publish(
  previousId: string,
  overrides: Record<string, unknown> = {},
  actor: PlatformIdentity = superAdmin
) {
  return modules.executePlatformCommand(
    actor,
    'jurisdiction.rules.publish',
    {
      ...testOnlyRules,
      previousId,
      effectiveFrom: midnightIn(1).toISOString(),
      reviewerName: 'TEST_ONLY reviewer',
      reviewerRole: 'TEST_ONLY reviewer role',
      reason: 'TEST_ONLY reviewed publication',
      evidenceRef: 'TEST_ONLY evidence',
      authenticationCode: totp(),
      ...overrides,
    },
    new Request('https://platform.test/api/platform/control', { method: 'POST' })
  );
}

function versionsOf(code: string) {
  return modules.withPlatformDb((db) =>
    db.jurisdictionRuleSet.findMany({ where: { code }, orderBy: { version: 'asc' } })
  );
}

function successAudits(targetIds: string[]) {
  return modules.withPlatformDb((db) =>
    db.platformAuditLog.findMany({
      where: { action: 'jurisdiction.rules.publish', success: true, targetId: { in: targetIds } },
    })
  );
}

async function auditsBy(actorId: string) {
  return modules.withPlatformDb((db) =>
    db.platformAuditLog.findMany({
      where: { action: 'jurisdiction.rules.publish', actorPlatformUserId: actorId },
      orderBy: { createdAt: 'asc' },
    })
  );
}

describeIfDatabase('jurisdiction.rules.publish on PostgreSQL (TEST_ONLY rules)', () => {
  beforeAll(async () => {
    const scoped = await import('@/lib/tenancy/scoped-db');
    const commands = await import('@/lib/platform/commands');
    const crypto = await import('@/lib/secret-crypto');
    const { db } = await import('@/lib/db');
    modules = {
      withPlatformDb: scoped.withPlatformDb,
      executePlatformCommand: commands.executePlatformCommand,
      encryptSecret: crypto.encryptSecret,
      disconnect: () => db.$disconnect(),
    };
    await modules.withPlatformDb(async (tx) => {
      // The production protections must hold for the restricted runtime role,
      // not because the test connects as an owner or a superuser.
      const [role] = await tx.$queryRawUnsafe<
        Array<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>
      >(
        `SELECT r.rolsuper, r.rolbypassrls,
                (t.tableowner = current_user) AS owns
           FROM pg_roles r, pg_tables t
          WHERE r.rolname = current_user AND t.tablename = 'pharmacy_jurisdiction_rule_sets'`
      );
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owns: false });
      const [rls] = await tx.$queryRawUnsafe<
        Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = 'pharmacy_jurisdiction_rule_sets'`
      );
      expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      for (const operator of [superAdmin, unenrolled]) {
        await tx.platformUser.create({
          data: {
            id: operator.id,
            name: `TEST_ONLY ${operator.id}`,
            email: `${operator.id}@example.test`,
            passwordHash: 'TEST_ONLY not a password hash',
            role: 'SUPER_ADMIN',
            active: true,
            ...(operator === superAdmin
              ? { encryptedTotpSecret: modules.encryptSecret(totpSecret), mfaEnabledAt: new Date() }
              : {}),
          },
        });
      }
    });
  });

  afterAll(async () => {
    if (!modules) return;
    await modules.withPlatformDb((tx) =>
      tx.platformUser.updateMany({
        where: { id: { in: [superAdmin.id, unenrolled.id] } },
        data: { active: false },
      })
    );
    await modules.disconnect();
  });

  it('closes the predecessor, inserts the successor and audits both in one commit', async () => {
    const before = await predecessor();
    const effectiveFrom = midnightIn(2);
    const permittedSchedules = { values: ['G', 'TEST_ONLY_SCHEDULE'], provisional: false };
    const pharmacistCoverageRule = {
      values: {
        presenceHours: {
          timeZone: 'Asia/Karachi',
          windows: [
            { days: [1], start: '20:00', end: '24:00' },
            { days: [2], start: '00:00', end: '08:00' },
          ],
        },
      },
      provisional: false,
    };
    const result = await publish(before.id, {
      effectiveFrom: effectiveFrom.toISOString(),
      permittedSchedules,
      pharmacistCoverageRule,
    });
    expect(result).toMatchObject({ version: 2 });

    const [closed, successor] = await versionsOf(before.code);
    expect(closed).toEqual({ ...before, effectiveTo: effectiveFrom });
    expect(successor).toMatchObject({
      id: (result as { id: string }).id,
      code: before.code,
      version: 2,
      effectiveFrom,
      effectiveTo: null,
      isPlaceholder: false,
      permittedSchedules,
      pharmacistCoverageRule,
      licenceCategories: testOnlyRules.licenceCategories,
    });

    const audits = await successAudits([successor!.id]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorPlatformUserId: superAdmin.id,
      targetType: 'JurisdictionRuleSet',
      targetId: successor!.id,
      reason: 'TEST_ONLY reviewed publication',
      before: { id: before.id, effectiveTo: null },
      after: {
        ruleSet: { id: successor!.id, version: 2 },
        previous: { id: before.id, effectiveTo: effectiveFrom.toISOString() },
        reviewerName: 'TEST_ONLY reviewer',
        reviewerRole: 'TEST_ONLY reviewer role',
        evidenceRef: 'TEST_ONLY evidence',
      },
    });
    expect(JSON.stringify(audits[0])).not.toContain('authenticationCode');
  });

  it('rolls back the predecessor closure when PostgreSQL rejects the successor insert', async () => {
    const before = await predecessor();
    // JSONB refuses a NUL character, so the INSERT fails after the closing UPDATE.
    await expect(
      publish(before.id, {
        licenceCategories: { values: ['TEST_ONLY\u0000LICENCE'], provisional: false },
      })
    ).rejects.toThrow();
    expect(await versionsOf(before.code)).toEqual([before]);
  });

  it('rolls back the closure and the successor when PostgreSQL rejects the audit', async () => {
    const before = await predecessor();
    // The reviewer name is written only to the audit row, so only the audit INSERT fails.
    await expect(publish(before.id, { reviewerName: 'TEST_ONLY\u0000reviewer' })).rejects.toThrow();
    expect(await versionsOf(before.code)).toEqual([before]);
  });

  it('lets only one of two concurrent publishers succeed', async () => {
    const before = await predecessor();
    const results = await Promise.allSettled([
      publish(before.id, { effectiveFrom: midnightIn(3).toISOString() }),
      publish(before.id, { effectiveFrom: midnightIn(4).toISOString() }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
    const versions = await versionsOf(before.code);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[0]!.effectiveTo).toEqual(versions[1]!.effectiveFrom);
    expect(await successAudits([versions[1]!.id])).toHaveLength(1);
  });

  it('keeps published values immutable in the database', async () => {
    const before = await predecessor();
    await publish(before.id);
    const [closed, successor] = await versionsOf(before.code);
    const rewrite = (id: string, data: Record<string, unknown>) =>
      modules.withPlatformDb((db) => db.jurisdictionRuleSet.update({ where: { id }, data }));
    await expect(
      rewrite(successor!.id, {
        licenceCategories: { values: ['TEST_ONLY_REWRITE'], provisional: false },
      })
    ).rejects.toThrow(/append-only/);
    await expect(rewrite(successor!.id, { version: 9 })).rejects.toThrow(/append-only/);
    await expect(
      rewrite(closed!.id, { effectiveTo: new Date(Date.now() + 9 * day) })
    ).rejects.toThrow(/append-only/);
    // No DELETE policy exists, so row-level security leaves nothing to delete
    // (and the append-only trigger backs it up for an owner).
    await expect(
      modules.withPlatformDb((db) => db.jurisdictionRuleSet.delete({ where: { id: closed!.id } }))
    ).rejects.toThrow();
    expect(await versionsOf(before.code)).toEqual([closed, successor]);
  });

  it('refuses rule writes outside the platform-admin scope', async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO pharmacy_jurisdiction_rule_sets
             (id, code, version, "effectiveFrom", "licenceCategories", "permittedSchedules",
              "prescriptionOnlyClasses", "prescriptionRetentionDays", "controlledRegisterFlags",
              "pharmacistCoverageRule", "recordRetentionByClass")
           VALUES ($1, $1, 1, now(), '{}', '{}', '{}', '{}', '{}', '{}', '{}')`,
          [`test_only_dev99_unscoped_${suffix}`]
        )
      ).rejects.toThrow(/row-level security/);
    } finally {
      await client.end();
    }
  });

  it.each([
    ['a non-SuperAdmin', { role: 'OPERATIONS' }, {}],
    ['a stale MFA code', {}, { authenticationCode: totp(Date.now() - 5 * 60 * 1000) }],
    ['a malformed MFA code', {}, { authenticationCode: '12345' }],
  ] as const)('refuses %s without writing', async (_label, actorOverride, overrides) => {
    const before = await predecessor();
    await expect(
      publish(before.id, overrides, { ...superAdmin, ...actorOverride } as PlatformIdentity)
    ).rejects.toMatchObject({ status: 403 });
    expect(await versionsOf(before.code)).toEqual([before]);
  });

  it('refuses a SuperAdmin with no MFA enrolment without writing', async () => {
    const before = await predecessor();
    await expect(publish(before.id, {}, unenrolled)).rejects.toMatchObject({ status: 403 });
    expect(await versionsOf(before.code)).toEqual([before]);
    const failures = await auditsBy(unenrolled.id);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((audit) => audit.success === false)).toBe(true);
  });

  it('refuses to persist outstanding review or empty sections as confirmed', async () => {
    const before = await predecessor();
    const outstanding = 'TEST_ONLY outstanding counsel review';
    await expect(
      publish(before.id, {
        licenceCategories: { values: [], toConfirm: outstanding, provisional: false },
        permittedSchedules: { values: [], toConfirm: outstanding, provisional: false },
        prescriptionOnlyClasses: { values: [], toConfirm: outstanding, provisional: false },
        prescriptionRetentionDays: { values: {}, toConfirm: outstanding, provisional: false },
        controlledRegisterFlags: { values: {}, toConfirm: outstanding, provisional: false },
        pharmacistCoverageRule: { values: {}, toConfirm: outstanding, provisional: false },
        recordRetentionByClass: { values: {}, toConfirm: outstanding, provisional: false },
      })
    ).rejects.toThrow();
    expect(await versionsOf(before.code)).toEqual([before]);
  });

  it('never touches or confirms the provisional Punjab rule set', async () => {
    const [provisional] = await modules.withPlatformDb((db) =>
      db.jurisdictionRuleSet.findMany({ where: { id: 'pk_pb_provisional_v1' } })
    );
    // Seeded by the 20260902130000 migration; the editor only ever adds successors.
    expect(provisional).toBeDefined();
    const { RULE_FIELDS } = await import('@/lib/platform/jurisdiction-rules');
    for (const field of RULE_FIELDS) {
      expect(provisional![field]).toMatchObject({ provisional: true });
    }
  });
});
