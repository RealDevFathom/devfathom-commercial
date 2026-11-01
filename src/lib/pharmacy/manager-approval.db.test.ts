/**
 * #482 — owner/manager PIN approval against REAL PostgreSQL (NOSUPERUSER NOBYPASSRLS).
 *
 * Proves what mocks cannot: a failed PIN attempt is committed in its own tenant transaction, so
 * rolling back the request transaction around it (as a tRPC batch with a deliberately failing
 * call does) does not undo the counter; the fifth failure locks the stored credential; and
 * concurrent wrong guesses are serialized on the credential row so none is lost.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = databaseUrl ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ids = {
  org: `org_m482_${suffix}`,
  branch: `br_m482_${suffix}`,
  operator: `user_m482_op_${suffix}`,
  manager: `user_m482_mgr_${suffix}`,
  managerProfile: `staff_m482_mgr_${suffix}`,
  managerCredential: `cred_m482_mgr_${suffix}`,
};
const PIN = '482482';
const WRONG = '111111';

type Approval = typeof import('./manager-approval');
type Scoped = typeof import('@/lib/tenancy/scoped-db');

let approval: Approval;
let withTenantDb: Scoped['withTenantDb'];
let withPlatformDb: Scoped['withPlatformDb'];
let maxFailedAttempts: number;
let disconnect: (() => Promise<void>) | null = null;

const scope = () => ({ organizationId: ids.org, branchId: ids.branch, actorId: ids.operator });

function counters() {
  return withTenantDb(ids.org, (db) =>
    db.restaurantOperatorCredential.findUniqueOrThrow({
      where: { id: ids.managerCredential },
      select: { failedAttempts: true, lockedUntil: true },
    })
  );
}

function resetCounters() {
  return withTenantDb(ids.org, (db) =>
    db.restaurantOperatorCredential.update({
      where: { id: ids.managerCredential },
      data: { failedAttempts: 0, lockedUntil: null },
    })
  );
}

class RequestRolledBack extends Error {}

/** One wrong guess made from inside a request transaction that is then rolled back. */
async function guessInsideRolledBackRequest(pin: string) {
  let outcome: Awaited<ReturnType<Approval['verifyManagerApprovalDurably']>> | undefined;
  await expect(
    withTenantDb(
      ids.org,
      async () => {
        outcome = await approval.verifyManagerApprovalDurably(scope(), {
          staffProfileId: ids.managerProfile,
          pin,
        });
        throw new RequestRolledBack();
      },
      { userId: ids.operator, timeout: 60_000 }
    )
  ).rejects.toBeInstanceOf(RequestRolledBack);
  return outcome!;
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  approval = await import('./manager-approval');
  const credentials = await import('@/lib/restaurant/operator-credentials');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  maxFailedAttempts = credentials.MAX_FAILED_ATTEMPTS;
  disconnect = () => db.$disconnect();
  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Manager PIN', 'Manager PIN', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.org
    )
  );
  const credentialHash = await credentials.hashOperatorCredential('PIN', PIN);
  await withTenantDb(ids.org, async (tx) => {
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    await tx.pharmacyBranch.create({
      data: {
        id: ids.branch,
        code: 'MGR',
        name: 'Manager PIN counter',
        addressLine: '1 Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    for (const [userId, capabilities] of [
      [ids.operator, ['pharmacy:counter']],
      [ids.manager, ['pharmacy:counter', 'pharmacy:manage']],
    ] as const) {
      await tx.organizationRole.create({
        data: {
          id: `role_${userId}`,
          key: `role_${userId}`,
          name: userId,
          permissions: {
            create: capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const })),
          },
        },
      });
      await tx.user.create({
        data: {
          id: userId,
          name: userId,
          email: `${userId}@example.test`,
          department: 'LEADERSHIP',
          title: 'Counter',
          organizationRoleId: `role_${userId}`,
        },
      });
      await tx.pharmacyBranchAssignment.create({ data: { userId, branchId: ids.branch } });
    }
    await tx.restaurantStaffProfile.create({
      data: { id: ids.managerProfile, userId: ids.manager, displayName: 'Manager' },
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        id: ids.managerCredential,
        staffProfileId: ids.managerProfile,
        type: 'PIN',
        credentialHash,
      },
    });
  });
});

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('manager PIN approval durability (#482)', () => {
  it('keeps a failed attempt when the surrounding request rolls back', async () => {
    await resetCounters();
    const outcome = await guessInsideRolledBackRequest(WRONG);
    expect(outcome).toMatchObject({ ok: false, reason: 'INVALID_PIN' });
    expect(await counters()).toEqual({ failedAttempts: 1, lockedUntil: null });
  });

  it('locks the stored credential on the fifth failure even across rolled-back requests', async () => {
    await resetCounters();
    for (let attempt = 1; attempt < maxFailedAttempts; attempt += 1) {
      expect(await guessInsideRolledBackRequest(WRONG)).toMatchObject({ reason: 'INVALID_PIN' });
    }
    expect(await guessInsideRolledBackRequest(WRONG)).toMatchObject({ reason: 'LOCKED' });
    const locked = await counters();
    expect(locked.lockedUntil).toBeInstanceOf(Date);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // The correct PIN is refused while the lock holds.
    expect(await guessInsideRolledBackRequest(PIN)).toMatchObject({ ok: false, reason: 'LOCKED' });
  });

  it('serializes concurrent wrong guesses so no failed attempt is lost', async () => {
    await resetCounters();
    const guesses = maxFailedAttempts - 1;
    const outcomes = await Promise.all(
      Array.from({ length: guesses }, () =>
        approval.verifyManagerApprovalDurably(scope(), {
          staffProfileId: ids.managerProfile,
          pin: WRONG,
        })
      )
    );
    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
    expect(await counters()).toEqual({ failedAttempts: guesses, lockedUntil: null });
  });

  it('approves the stored PIN and clears the strikes', async () => {
    await resetCounters();
    await guessInsideRolledBackRequest(WRONG);
    await expect(
      approval.verifyManagerApprovalDurably(scope(), {
        staffProfileId: ids.managerProfile,
        pin: PIN,
      })
    ).resolves.toEqual({
      ok: true,
      approverUserId: ids.manager,
      approverStaffProfileId: ids.managerProfile,
    });
    expect(await counters()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });

  it('lists the branch manager as an approver and not the operator', async () => {
    await expect(
      withTenantDb(ids.org, (db) => approval.listManagerApprovers(db, scope()))
    ).resolves.toEqual([{ id: ids.managerProfile, name: 'Manager' }]);
  });
});
