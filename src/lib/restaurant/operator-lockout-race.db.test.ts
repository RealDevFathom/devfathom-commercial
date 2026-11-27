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
 *
 * The back-office approvals (tRPC) test the same PIN. Their request answers a
 * wrong PIN with an error that rolls the request transaction back, so the check
 * commits in its own tenant transaction and lands on the SAME counter: guesses
 * split across the terminal route and an approval still stop at five compares.
 * That case runs the real router inside a request transaction that rolls back on
 * failure, as the HTTP handler does; only Auth.js and the ABAC engine are mocked.
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
  const compare = (secret: string, hash: string): Promise<boolean> => {
    compares.count += 1;
    return actual.compare(secret, hash);
  };
  return { ...actual, compare, default: { ...actual, compare } };
});

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

const suffix = randomBytes(6).toString('hex');
const orgId = `org_dev1055_${suffix}`;
const otherOrgId = `org_dev1055_other_${suffix}`;
const branchId = `branch_dev1055_${suffix}`;
const adminUserId = `user_dev1055_${suffix}`;
const actingStaffId = `staff_dev1055_acting_${suffix}`;
let approverRoleId: string;
const PIN = '482915';
const WRONG_PIN = '000000';

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  authenticateOperator: (typeof import('@/lib/restaurant/terminal-auth'))['authenticateOperator'];
  hash: (typeof import('@/lib/restaurant/operator-credentials'))['hashOperatorCredential'];
  devicesRouter: (typeof import('@/server/routers/restaurant-devices'))['restaurantDevicesRouter'];
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

/** Let the operator approve co-authorizations at the branch, and enrol a device to revoke. */
async function asApproverWithDevice(staffProfileId: string): Promise<string> {
  const deviceId = `device_dev1055_${suffix}_${staffSeq}`;
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantStaffJobRole.create({
      data: { staffProfileId, jobRoleId: approverRoleId, branchId },
    });
    await tx.restaurantRegisteredDevice.create({
      data: { id: deviceId, branchId, name: deviceId, deviceSecretHash: `secret_${deviceId}` },
    });
  });
  return deviceId;
}

/**
 * One back-office device revocation approved with `secret`, as one tRPC request
 * makes it: the whole request runs in ONE tenant transaction, and a refusal
 * throws out of it, rolling back everything the request wrote in it.
 */
function approveRevoke(approvingStaffProfileId: string, deviceId: string, secret: string) {
  return deps.withTenantDb(orgId, (tx) =>
    deps.devicesRouter
      .createCaller({
        db: tx,
        entitlements: {
          organizationId: orgId,
          seatLimit: 10,
          activeSeats: 0,
          enabledModules: ['restaurant-core'],
          modules: [
            {
              key: 'restaurant-core',
              name: 'Restaurant Core',
              enabled: true,
              source: 'PACKAGE',
              seatLimit: null,
              expiresAt: null,
            },
          ],
          limits: {},
        },
        session: {
          expires: 'later',
          user: {
            id: adminUserId,
            role: 'ADMIN',
            department: 'LEADERSHIP',
            status: 'ACTIVE',
            organizationId: orgId,
          },
        },
        organization: { id: orgId },
        support: null,
        requestMeta: { ip: '203.0.113.1', userAgent: null },
        audit: { detail: {} },
      } as never)
      .revoke({
        deviceId,
        approvingStaffProfileId,
        approvingType: 'PIN',
        approvingSecret: secret,
        reason: 'lockout race',
      })
  );
}

function deviceState(deviceId: string) {
  return deps.withTenantDb(orgId, async (tx) => ({
    status: (
      await tx.restaurantRegisteredDevice.findUniqueOrThrow({
        where: { id: deviceId },
        select: { status: true },
      })
    ).status,
    coAuthorizations: await tx.restaurantCoAuthorization.count({ where: { targetId: deviceId } }),
  }));
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
  const [scopedDb, credentials, terminalAuth, devices] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/lib/restaurant/terminal-auth'),
    import('@/server/routers/restaurant-devices'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    authenticateOperator: terminalAuth.authenticateOperator,
    hash: credentials.hashOperatorCredential,
    devicesRouter: devices.restaurantDevicesRouter,
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
  // The signed-in administrator who asks for the back-office approvals, and the
  // job role that lets a manager approve them.
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.organizationDepartment.create({ data: { key: 'LEADERSHIP', name: 'Leadership' } });
    await tx.user.create({
      data: {
        id: adminUserId,
        name: 'Lockout race administrator',
        email: `lockout-race-${suffix}@example.test`,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: 'Administrator',
      },
    });
    await tx.restaurantStaffProfile.create({
      data: {
        id: actingStaffId,
        userId: adminUserId,
        displayName: 'Acting administrator',
        status: 'ACTIVE',
      },
    });
    const managerRole = await tx.restaurantJobRole.create({
      data: { key: `lockout-manager-${suffix}`, name: 'Device manager', active: true },
    });
    await tx.restaurantJobRoleCapability.create({
      data: { jobRoleId: managerRole.id, capability: 'devices:manage' },
    });
    await tx.restaurantStaffJobRole.create({
      data: { staffProfileId: actingStaffId, jobRoleId: managerRole.id, branchId },
    });
    const approverRole = await tx.restaurantJobRole.create({
      data: { key: `lockout-approver-${suffix}`, name: 'Device approver', active: true },
    });
    await tx.restaurantJobRoleCapability.create({
      data: { jobRoleId: approverRole.id, capability: 'coauth:approve' },
    });
    approverRoleId = approverRole.id;
  });
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

  it('stops at 5 compares when wrong PINs are split across the terminal route and a tRPC approval', async () => {
    const operator = await newOperator();
    const deviceId = await asApproverWithDevice(operator.staffProfileId);

    // Three wrong PINs on the terminal route...
    for (let i = 0; i < 3; i += 1) {
      await expect(attempt(operator.staffProfileId, WRONG_PIN)).resolves.toEqual({
        ok: false,
        reason: 'INVALID',
      });
    }
    expect(compares.count).toBe(3);

    // ...then two on the back-office approval. Each refusal rolls its request
    // transaction back, and the charge is still counted on the same credential.
    await expect(approveRevoke(operator.staffProfileId, deviceId, WRONG_PIN)).rejects.toMatchObject(
      { code: 'FORBIDDEN', message: 'Invalid approving credential.' }
    );
    await expect(credentialState(operator.credentialId)).resolves.toEqual({
      failedAttempts: 4,
      lockedUntil: null,
    });
    await expect(approveRevoke(operator.staffProfileId, deviceId, WRONG_PIN)).rejects.toMatchObject(
      { code: 'FORBIDDEN', message: 'Invalid approving credential.' }
    );
    expect(compares.count).toBe(5);

    const state = await credentialState(operator.credentialId);
    expect(state.failedAttempts).toBe(0);
    expect(state.lockedUntil).not.toBeNull();
    expect(state.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // The credential is now locked on BOTH routes: even the correct PIN is
    // refused without a compare, and nothing is revoked.
    await expect(approveRevoke(operator.staffProfileId, deviceId, PIN)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    await expect(attempt(operator.staffProfileId, PIN)).resolves.toMatchObject({
      ok: false,
      reason: 'LOCKED',
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(attempt(operator.staffProfileId, WRONG_PIN)).resolves.toMatchObject({
        ok: false,
        reason: 'LOCKED',
      });
    }
    expect(compares.count).toBe(5);
    await expect(deviceState(deviceId)).resolves.toEqual({ status: 'ACTIVE', coAuthorizations: 0 });
  }, 60_000);

  it('stops at 5 compares when the terminal route and tRPC approvals guess at the same moment', async () => {
    const operator = await newOperator();
    const deviceId = await asApproverWithDevice(operator.staffProfileId);

    const [terminal, approvals] = await Promise.all([
      Promise.all(Array.from({ length: 6 }, () => attempt(operator.staffProfileId, WRONG_PIN))),
      Promise.allSettled(
        Array.from({ length: 4 }, () => approveRevoke(operator.staffProfileId, deviceId, WRONG_PIN))
      ),
    ]);

    expect(terminal.every((result) => !result.ok)).toBe(true);
    expect(approvals.every((result) => result.status === 'rejected')).toBe(true);
    expect(compares.count).toBe(5);

    const state = await credentialState(operator.credentialId);
    expect(state.failedAttempts).toBe(0);
    expect(state.lockedUntil).not.toBeNull();
    await expect(deviceState(deviceId)).resolves.toEqual({ status: 'ACTIVE', coAuthorizations: 0 });
  }, 60_000);

  it('a correct approval after wrong PINs on both routes clears the shared counter and revokes', async () => {
    const operator = await newOperator();
    const deviceId = await asApproverWithDevice(operator.staffProfileId);

    for (let i = 0; i < 2; i += 1) await attempt(operator.staffProfileId, WRONG_PIN);
    for (let i = 0; i < 2; i += 1) {
      await expect(
        approveRevoke(operator.staffProfileId, deviceId, WRONG_PIN)
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(credentialState(operator.credentialId)).resolves.toEqual({
      failedAttempts: 4,
      lockedUntil: null,
    });

    await approveRevoke(operator.staffProfileId, deviceId, PIN);
    await expect(credentialState(operator.credentialId)).resolves.toEqual({
      failedAttempts: 0,
      lockedUntil: null,
    });
    await expect(deviceState(deviceId)).resolves.toEqual({
      status: 'REVOKED',
      coAuthorizations: 1,
    });
  }, 60_000);
});
