/**
 * DEV-1055 — the operator PIN lockout cannot be raced, against a REAL PostgreSQL.
 *
 * `authenticateOperator` used to read the failed-attempt counter, compare the
 * PIN, and only then write the counter back. Guesses sent at the same moment all
 * read the same count, were all compared, and all wrote "1": the five-attempt
 * lockout never engaged, so a PIN could be brute-forced in parallel. The attempt
 * is now charged in one UPDATE on the credential row BEFORE any compare, so
 * concurrent guesses queue on the row and only five are ever compared.
 *
 * Only a database can show this: the property is the row lock and the
 * re-evaluated WHERE clause, and each guess runs in its own tenant transaction
 * exactly as each terminal request does. Requires TEST_DATABASE_URL (a migrated,
 * throwaway database reached as the restricted runtime role, so row level
 * security is in force); without it the suite reports itself skipped.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const compares = vi.hoisted(() => ({ count: 0 }));

// Count every real bcrypt compare; the compare itself is unchanged.
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  const compare = (async (...args: Parameters<typeof actual.compare>) => {
    compares.count += 1;
    return actual.compare(...args);
  }) as typeof actual.compare;
  return { ...actual, compare, default: { ...actual, compare } };
});

const suffix = randomBytes(6).toString('hex');
const orgId = `org_dev1055_${suffix}`;
const otherOrgId = `org_dev1055_other_${suffix}`;
const branchId = `branch_dev1055_${suffix}`;
const PIN = '482915';
const WRONG_PIN = '000000';

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  authenticateOperator: (typeof import('@/lib/restaurant/terminal-auth'))['authenticateOperator'];
  hash: (typeof import('@/lib/restaurant/operator-credentials'))['hashOperatorCredential'];
};
let deps: Deps;
let staffSeq = 0;

/** A fresh ACTIVE operator with one organization-wide PIN. */
async function newOperator(): Promise<{ staffProfileId: string; credentialId: string }> {
  const staffProfileId = `staff_dev1055_${suffix}_${++staffSeq}`;
  const credentialHash = await deps.hash('PIN', PIN);
  const credential = await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantStaffProfile.create({
      data: {
        id: staffProfileId,
        displayName: staffProfileId,
        status: 'ACTIVE',
        primaryBranchId: branchId,
      },
    });
    return tx.restaurantOperatorCredential.create({
      data: { staffProfileId, type: 'PIN', credentialHash },
      select: { id: true },
    });
  });
  return { staffProfileId, credentialId: credential.id };
}

/** One sign-in attempt in its own tenant transaction, as one request makes it. */
function attempt(staffProfileId: string, secret: string, now = new Date(), organization = orgId) {
  return deps.withTenantDb(organization, (tx) =>
    deps.authenticateOperator(tx, { staffProfileId, type: 'PIN', secret, now })
  );
}

function credentialState(credentialId: string) {
  return deps.withTenantDb(orgId, (tx) =>
    tx.restaurantOperatorCredential.findUniqueOrThrow({
      where: { id: credentialId },
      select: { failedAttempts: true, lockedUntil: true },
    })
  );
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, credentials, terminalAuth] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/lib/restaurant/terminal-auth'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    authenticateOperator: terminalAuth.authenticateOperator,
    hash: credentials.hashOperatorCredential,
  };

  await scopedDb.withPlatformDb(async (tx) => {
    // The suite must be exercising row level security, not bypassing it.
    const [role] = await tx.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (role.rolsuper || role.rolbypassrls) {
      throw new Error('TEST_DATABASE_URL must name a NOSUPERUSER NOBYPASSRLS runtime role.');
    }
    for (const id of [orgId, otherOrgId]) {
      await tx.organization.create({
        data: {
          id,
          slug: id.replaceAll('_', '-'),
          legalName: 'Lockout Race Test Co',
          displayName: 'Lockout Race Test',
          status: 'ACTIVE',
        },
      });
    }
  });
  await deps.withTenantDb(orgId, (tx) =>
    tx.restaurantBranch.create({ data: { id: branchId, name: 'Lockout race' } })
  );
});

beforeEach(() => {
  compares.count = 0;
});

describeIfDatabase('DEV-1055: operator PIN lockout under concurrent guesses (real DB)', () => {
  it('compares at most 5 of 20 parallel wrong PINs and leaves the credential locked', async () => {
    const operator = await newOperator();
    const now = new Date();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => attempt(operator.staffProfileId, WRONG_PIN, now))
    );

    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.filter((r) => !r.ok && r.reason === 'INVALID')).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === 'LOCKED')).toHaveLength(15);
    expect(compares.count).toBe(5);

    const state = await credentialState(operator.credentialId);
    expect(state.lockedUntil).not.toBeNull();
    expect(state.lockedUntil!.getTime()).toBe(now.getTime() + 15 * 60 * 1000);
    expect(state.failedAttempts).toBe(0);

    // While locked, even the correct PIN is refused without a compare.
    compares.count = 0;
    const locked = await attempt(operator.staffProfileId, PIN, new Date(now.getTime() + 1000));
    expect(locked).toMatchObject({ ok: false, reason: 'LOCKED' });
    expect(compares.count).toBe(0);

    // After the lock expires the operator gets a fresh set of attempts.
    const later = new Date(now.getTime() + 15 * 60 * 1000 + 1);
    await expect(attempt(operator.staffProfileId, PIN, later)).resolves.toMatchObject({
      ok: true,
    });
    await expect(credentialState(operator.credentialId)).resolves.toEqual({
      failedAttempts: 0,
      lockedUntil: null,
    });
  }, 60_000);

  it('accepts the correct PIN after 4 wrong ones and clears the counter', async () => {
    const operator = await newOperator();

    for (let i = 0; i < 4; i += 1) {
      await expect(attempt(operator.staffProfileId, WRONG_PIN)).resolves.toEqual({
        ok: false,
        reason: 'INVALID',
      });
    }
    await expect(credentialState(operator.credentialId)).resolves.toEqual({
      failedAttempts: 4,
      lockedUntil: null,
    });

    await expect(attempt(operator.staffProfileId, PIN)).resolves.toMatchObject({
      ok: true,
      credentialId: operator.credentialId,
    });
    await expect(credentialState(operator.credentialId)).resolves.toEqual({
      failedAttempts: 0,
      lockedUntil: null,
    });

    // The cleared counter really is a fresh set: four more misses do not lock.
    for (let i = 0; i < 4; i += 1) await attempt(operator.staffProfileId, WRONG_PIN);
    await expect(attempt(operator.staffProfileId, PIN)).resolves.toMatchObject({ ok: true });
  }, 60_000);

  it('counts every attempt when wrong and correct PINs race, and never over-counts', async () => {
    const operator = await newOperator();

    const results = await Promise.all([
      ...Array.from({ length: 3 }, () => attempt(operator.staffProfileId, WRONG_PIN)),
      attempt(operator.staffProfileId, PIN),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(compares.count).toBe(4);
    const state = await credentialState(operator.credentialId);
    expect(state.lockedUntil).toBeNull();
    expect(state.failedAttempts).toBeLessThanOrEqual(3);
  }, 60_000);

  it("cannot charge or unlock another organization's credential", async () => {
    const operator = await newOperator();

    // Row level security hides the credential, so nothing is charged.
    await expect(
      attempt(operator.staffProfileId, WRONG_PIN, new Date(), otherOrgId)
    ).resolves.toEqual({ ok: false, reason: 'INVALID' });
    await expect(credentialState(operator.credentialId)).resolves.toEqual({
      failedAttempts: 0,
      lockedUntil: null,
    });
  }, 60_000);
});
