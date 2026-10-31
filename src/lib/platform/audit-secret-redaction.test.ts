/**
 * Audit redaction, against a REAL PostgreSQL (#10).
 *
 * The defect was in what reaches storage, so every assertion here reads the
 * persisted row back. A mock of the Prisma client would only prove what the
 * command *tried* to write, and the two bugs were both about the value that
 * arrived: a live SCIM bearer token written to `platform_audit_logs.after` in
 * cleartext, and a settings row whose ciphertext was replaced with the literal
 * '[REDACTED]' before `upsert`.
 *
 * `encryptSecret` is wrapped, not replaced: the real implementation runs and
 * its exact output is recorded, so "byte-identical" can be asserted against
 * what the command actually produced while `decryptSecret` stays real.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped rather than
 * passing vacuously.
 *
 * The failure-path assertions depend on a transaction rollback followed by a
 * separate durable write. The suite therefore refuses a SUPERUSER/BYPASSRLS
 * runtime role instead of allowing privileged test behavior to stand in for
 * the production boundary.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const recorder = vi.hoisted(() => ({ ciphertexts: [] as string[] }));

// The real cipher, with a tap on its output. Nothing else in the module is
// substituted: `decryptSecret` below is the production implementation.
vi.mock('@/lib/secret-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/secret-crypto')>();
  return {
    ...actual,
    encryptSecret: (value: string) => {
      const ciphertext = actual.encryptSecret(value);
      recorder.ciphertexts.push(ciphertext);
      return ciphertext;
    },
  };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// `@/lib/db` reads DATABASE_URL when its module is evaluated, so this must
// happen before the dynamic imports in `beforeAll`.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const suffix = randomBytes(6).toString('hex');
const id = (name: string) => `${name}_audit_redaction_${suffix}`;

const ORGANIZATION = id('org');
const OPERATOR = id('operator');
const SETTING_SENSITIVE = `audit.redaction.secret.${suffix}`;
const SETTING_PLAIN = `audit.redaction.plain.${suffix}`;

type Deps = {
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  executePlatformCommand: (typeof import('./commands'))['executePlatformCommand'];
  auditProjection: (typeof import('./commands'))['auditProjection'];
  decryptSecret: (typeof import('@/lib/secret-crypto'))['decryptSecret'];
  assertRlsEnforcingRole: (typeof import('@/lib/testing/rls-role-guard'))['assertRlsEnforcingRole'];
};

let deps: Deps;

const actor = (role: 'SUPER_ADMIN' | 'AUDITOR' = 'SUPER_ADMIN') => ({
  sessionId: id('session'),
  id: OPERATOR,
  name: 'Redaction Operator',
  email: `${OPERATOR}@example.test`,
  role,
  expiresAt: new Date(Date.now() + 3_600_000),
  mfaEnabled: true,
});

const request = () =>
  new Request('https://platform.example.test/api/platform/control', {
    method: 'POST',
    headers: { 'x-devfathom-request-id': id('request'), 'user-agent': 'vitest' },
  });

const run = (action: string, payload: unknown, role: 'SUPER_ADMIN' | 'AUDITOR' = 'SUPER_ADMIN') =>
  deps.executePlatformCommand(actor(role), action, payload, request());

const latestAudit = (action: string, targetId?: string) =>
  deps.withPlatformDb((db) =>
    db.platformAuditLog.findFirst({
      where: { action, ...(targetId ? { targetId } : {}) },
      orderBy: { createdAt: 'desc' },
    })
  );

/** Rows anywhere in the ledger or the credential table that carry this text. */
const occurrences = async (needle: string) =>
  deps.withPlatformDb(async (db) => {
    const [{ count }] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT (
        (SELECT count(*) FROM platform_audit_logs
          WHERE strpos(coalesce(before::text, '') || coalesce(after::text, '') ||
                       coalesce(metadata::text, ''), ${needle}) > 0)
        +
        (SELECT count(*) FROM organization_scim_tokens
          WHERE strpos("tokenHash" || "prefix" || "name", ${needle}) > 0)
      ) AS count`;
    return Number(count);
  });

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('platform audit redaction, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    const commands = await import('./commands');
    deps = {
      withPlatformDb: scopedDb.withPlatformDb,
      executePlatformCommand: commands.executePlatformCommand,
      auditProjection: commands.auditProjection,
      decryptSecret: (await import('@/lib/secret-crypto')).decryptSecret,
      assertRlsEnforcingRole: (await import('@/lib/testing/rls-role-guard')).assertRlsEnforcingRole,
    };

    await deps.assertRlsEnforcingRole(deps.withPlatformDb);

    await deps.withPlatformDb((db) =>
      db.platformUser.create({
        data: {
          id: OPERATOR,
          name: actor().name,
          email: actor().email,
          role: 'SUPER_ADMIN',
          passwordHash: 'fixture',
        },
      })
    );

    await deps.withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: ORGANIZATION,
          slug: ORGANIZATION.replaceAll('_', '-'),
          legalName: 'Audit Redaction',
          displayName: 'Audit Redaction',
          status: 'ACTIVE',
        },
      })
    );
  }, 60_000);

  // The audit rows and the organization stay: platform_audit_logs is
  // append-only (20261019212000), and deleting the organization would SET NULL
  // on those rows, which the same trigger refuses. Every id is per run.
  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(async (db) => {
      await db.platformSetting.deleteMany({
        where: { key: { in: [SETTING_SENSITIVE, SETTING_PLAIN] } },
      });
      await db.organizationScimToken.deleteMany({ where: { organizationId: ORGANIZATION } });
    });
  }, 60_000);

  it('writes no plaintext SCIM token to the audit row it persists', async () => {
    const issued = (await run('organization.scim.token', {
      organizationId: ORGANIZATION,
      name: 'Provisioning',
      reason: 'Verify persisted credential redaction',
    })) as { id: string; token: string; prefix: string };

    expect(issued.token).toMatch(/^scim_/);

    const row = await latestAudit('organization.scim.token');
    expect(row).not.toBeNull();
    expect(row!.targetId).toBe(issued.id);

    const after = row!.after as Record<string, unknown>;
    expect(JSON.stringify(after)).not.toContain(issued.token);
    expect(Object.keys(after)).not.toContain('token');
    expect(Object.keys(after)).not.toContain('tokenHash');
    // The identity of the credential still has to be there, or the ledger
    // cannot answer "which token was issued".
    expect(after.id).toBe(issued.id);
    expect(after.prefix).toBe(issued.prefix);
  });

  it('reveals the token once and never stores it anywhere readable afterwards', async () => {
    const issued = (await run('organization.scim.token', {
      organizationId: ORGANIZATION,
      name: 'Reveal once',
      reason: 'Verify persisted credential redaction',
    })) as { id: string; token: string };

    expect(issued.token).toMatch(/^scim_/);
    expect(await occurrences(issued.token)).toBe(0);

    const stored = await deps.withPlatformDb((db) =>
      db.organizationScimToken.findUniqueOrThrow({ where: { id: issued.id } })
    );
    expect(Object.values(stored)).not.toContain(issued.token);

    const revoked = (await run('organization.scim.revoke', {
      id: issued.id,
      reason: 'Verify revocation remains redacted',
    })) as Record<string, unknown>;
    expect(Object.keys(revoked)).not.toContain('token');
    expect(JSON.stringify(revoked)).not.toContain(issued.token);
    expect(await occurrences(issued.token)).toBe(0);
  });

  it('stores the exact ciphertext encryptSecret produced', async () => {
    recorder.ciphertexts.length = 0;
    await run('setting.upsert', {
      key: SETTING_SENSITIVE,
      category: 'integrations',
      value: { apiKey: 'sk-live-not-a-real-key' },
      sensitive: true,
    });

    expect(recorder.ciphertexts).toHaveLength(1);
    const stored = await deps.withPlatformDb((db) =>
      db.platformSetting.findUniqueOrThrow({ where: { key: SETTING_SENSITIVE } })
    );
    expect((stored.value as { encrypted: string }).encrypted).toBe(recorder.ciphertexts[0]);
  });

  it('round-trips a stored sensitive setting back to its original value', async () => {
    const value = { apiKey: 'sk-live-round-trip', region: 'eu-west-1' };
    await run('setting.upsert', {
      key: SETTING_SENSITIVE,
      category: 'integrations',
      value,
      sensitive: true,
    });

    const stored = await deps.withPlatformDb((db) =>
      db.platformSetting.findUniqueOrThrow({ where: { key: SETTING_SENSITIVE } })
    );
    const decrypted = deps.decryptSecret((stored.value as { encrypted: string }).encrypted);
    expect(JSON.parse(decrypted)).toEqual(value);

    // The audit row records that it changed, without the ciphertext.
    const row = await latestAudit('setting.upsert');
    const after = row!.after as Record<string, unknown>;
    expect(after.key).toBe(SETTING_SENSITIVE);
    expect(after.sensitive).toBe(true);
    expect(Object.keys(after)).not.toContain('value');
    expect(JSON.stringify(after)).not.toContain(
      (stored.value as { encrypted: string }).encrypted.slice(0, 24)
    );
  });

  it('keeps ordinary, non-sensitive audit content intact', async () => {
    await run('organization.update', { id: ORGANIZATION, displayName: 'Audit Redaction Renamed' });

    const row = await latestAudit('organization.update');
    expect(row).not.toBeNull();
    expect(row!.action).toBe('organization.update');
    expect(row!.targetType).toBe('Organization');
    expect(row!.targetId).toBe(ORGANIZATION);
    expect(row!.actorPlatformUserId).toBe(OPERATOR);
    expect(row!.success).toBe(true);
    expect(row!.organizationId).toBe(ORGANIZATION);

    const before = row!.before as Record<string, unknown>;
    const after = row!.after as Record<string, unknown>;
    expect(before.displayName).toBe('Audit Redaction');
    expect(after.displayName).toBe('Audit Redaction Renamed');
    expect(after.slug).toBe(ORGANIZATION.replaceAll('_', '-'));
    expect(after.status).toBe('ACTIVE');

    const saved = (await run('setting.upsert', {
      key: SETTING_PLAIN,
      category: 'defaults',
      value: { retentionDays: 30 },
      sensitive: false,
    })) as { id: string };
    const plain = await latestAudit('setting.upsert', saved.id);
    expect((plain!.after as { value: unknown }).value).toEqual({ retentionDays: 30 });
  });

  it('persists sanitized durable rows when a command is denied or fails', async () => {
    const auditRowsBefore = await deps.withPlatformDb((db) =>
      db.platformAuditLog.count({ where: { actorPlatformUserId: OPERATOR } })
    );

    // Denied: an AUDITOR has no organizations:write capability.
    await expect(
      run('organization.scim.token', { organizationId: ORGANIZATION, name: 'Denied' }, 'AUDITOR')
    ).rejects.toThrow(/permission/i);

    // Failed after the credential was generated: the organization does not exist.
    await expect(
      run('organization.scim.token', {
        organizationId: id('missing_org'),
        name: 'Orphan',
        reason: 'Verify failed issuance is sanitized',
      })
    ).rejects.toThrow();

    const failures = await deps.withPlatformDb((db) =>
      db.platformAuditLog.findMany({
        where: {
          actorPlatformUserId: OPERATOR,
          action: 'organization.scim.token',
          success: false,
        },
        orderBy: { createdAt: 'asc' },
      })
    );
    expect(failures).toHaveLength(2);
    expect(
      await deps.withPlatformDb((db) =>
        db.platformAuditLog.count({ where: { actorPlatformUserId: OPERATOR } })
      )
    ).toBe(auditRowsBefore + 2);
    expect(failures.map((row) => row.metadata)).toEqual([
      { outcomeCategory: 'capability_denied' },
      { outcomeCategory: 'command_failed' },
    ]);
    expect(failures.map((row) => row.organizationId)).toEqual([ORGANIZATION, null]);
    expect(JSON.stringify(failures)).not.toContain('Denied');
    expect(JSON.stringify(failures)).not.toContain('Orphan');
    // Neither attempt left a credential behind either.
    expect(
      await deps.withPlatformDb((db) =>
        db.organizationScimToken.count({ where: { name: { in: ['Denied', 'Orphan'] } } })
      )
    ).toBe(0);

    // Fail closed: a result that declares no audit projection records an empty
    // object, not the reveal payload.
    const undeclared = deps.auditProjection({
      data: { token: 'scim_leaked_by_a_future_command' },
    } as never);
    expect(undeclared.after).toEqual({});
    expect(undeclared.before).toBeUndefined();
  });
});
