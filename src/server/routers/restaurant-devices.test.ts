/**
 * Back-office device administration, against a REAL PostgreSQL.
 *
 * The load-bearing behaviour — a device revocation that is only accepted with a
 * DISTINCT approving manager whose operator credential verifies, and that writes
 * an atomic co-authorization record (C7) — is a property of the database
 * (durable lockout counters, the co-authorization row, the REVOKED transition),
 * so a mock could not establish it. Requires TEST_DATABASE_URL (a migrated,
 * throwaway database, never DATABASE_URL); without it the suite reports itself
 * skipped rather than passing vacuously.
 *
 * Deliberately does not assert RLS isolation: every row is created and read
 * under one tenant scope for a single, per-run-unique organization id, so the
 * suite is valid on a superuser TEST_DATABASE_URL too. The tRPC middleware that
 * needs Auth.js / the ABAC engine is mocked (`resolveTenantActor`, `can`) exactly
 * as the sibling admin-router tests do; the database and the router are real.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

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

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha22_dev_${suffix}`;
const branchId = `branch_${suffix}`;
const actingStaffId = `staff_acting_${suffix}`;
const approvingStaffId = `staff_mgr_${suffix}`;
const unprivilegedStaffId = `staff_unprivileged_${suffix}`;
const APPROVING_PIN = '482913';

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  restaurantDevicesRouter: (typeof import('./restaurant-devices'))['restaurantDevicesRouter'];
  hashOperatorCredential: (typeof import('@/lib/restaurant/operator-credentials'))['hashOperatorCredential'];
};

let deps: Deps;

function adminCtx(db: unknown) {
  return {
    db,
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
        id: 'user_admin',
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
  } as never;
}

const caller = () =>
  deps.restaurantDevicesRouter.createCaller(adminCtx(deps.createTenantDb(orgId)));

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, routerModule, credModule] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./restaurant-devices'),
    import('@/lib/restaurant/operator-credentials'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    createTenantDb: scopedDb.createTenantDb,
    restaurantDevicesRouter: routerModule.restaurantDevicesRouter,
    hashOperatorCredential: credModule.hashOperatorCredential,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha863-devices-${suffix}`,
        legalName: 'WHA-863 Devices Test',
        displayName: 'WHA-863 Devices',
        status: 'ACTIVE',
      },
    })
  );

  const approvingHash = await deps.hashOperatorCredential('PIN', APPROVING_PIN);
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({ data: { id: branchId, name: 'Downtown' } });
    await tx.restaurantStaffProfile.create({
      data: { id: actingStaffId, displayName: 'Acting Admin', status: 'ACTIVE' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: approvingStaffId, displayName: 'Shift Manager', status: 'ACTIVE' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: unprivilegedStaffId, displayName: 'Unprivileged Manager', status: 'ACTIVE' },
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        staffProfileId: approvingStaffId,
        type: 'PIN',
        credentialHash: approvingHash,
      },
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        staffProfileId: unprivilegedStaffId,
        type: 'PIN',
        credentialHash: approvingHash,
      },
    });
    const managerRole = await tx.restaurantJobRole.create({
      data: { key: `device-manager-${suffix}`, name: 'Device manager', active: true },
    });
    await tx.restaurantJobRoleCapability.create({
      data: { jobRoleId: managerRole.id, capability: 'devices:manage' },
    });
    await tx.restaurantStaffJobRole.create({
      data: {
        staffProfileId: approvingStaffId,
        jobRoleId: managerRole.id,
        branchId,
      },
    });
  });
});

describeIfDatabase('restaurantDevices router (real DB)', () => {
  it('enrolls a device and lists it with health, never leaking the secret', async () => {
    const api = caller();
    const enrolled = await api.initiateEnrollment({ branchId, name: 'POS-1' });

    expect(enrolled.enrollmentSecret.startsWith('rdk_')).toBe(true);
    expect(enrolled.device.status).toBe('ACTIVE');

    const list = await api.list();
    const row = list.find((device) => device.id === enrolled.device.id);
    expect(row).toBeDefined();
    expect(row!.health).toBe('NEVER_SEEN');
    // The list shape must never carry secret material.
    expect(row as Record<string, unknown>).not.toHaveProperty('deviceSecretHash');
  });

  it('rejects a self-approval (approver must differ from actor) before any compare', async () => {
    const api = caller();
    const { device } = await api.initiateEnrollment({ branchId, name: 'POS-self' });
    await expect(
      api.revoke({
        deviceId: device.id,
        actingStaffProfileId: approvingStaffId,
        approvingStaffProfileId: approvingStaffId,
        approvingType: 'PIN',
        approvingSecret: APPROVING_PIN,
        reason: 'test',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const still = (await api.list()).find((d) => d.id === device.id);
    expect(still!.status).toBe('ACTIVE');
  });

  it('rejects revocation with a wrong approving credential and advances the durable counter', async () => {
    const api = caller();
    const { device } = await api.initiateEnrollment({ branchId, name: 'POS-wrong' });
    await expect(
      api.revoke({
        deviceId: device.id,
        actingStaffProfileId: actingStaffId,
        approvingStaffProfileId: approvingStaffId,
        approvingType: 'PIN',
        approvingSecret: '000000',
        reason: 'wrong pin',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const still = (await api.list()).find((d) => d.id === device.id);
    expect(still!.status).toBe('ACTIVE');

    // The failed attempt was recorded on the durable per-row counter (C4).
    const failed = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOperatorCredential.findFirst({ where: { staffProfileId: approvingStaffId } })
    );
    expect(failed!.failedAttempts).toBeGreaterThanOrEqual(1);
  });

  it('rejects a valid approving credential without device-management capability', async () => {
    const api = caller();
    const { device } = await api.initiateEnrollment({ branchId, name: 'POS-no-capability' });

    await expect(
      api.revoke({
        deviceId: device.id,
        actingStaffProfileId: actingStaffId,
        approvingStaffProfileId: unprivilegedStaffId,
        approvingType: 'PIN',
        approvingSecret: APPROVING_PIN,
        reason: 'capability check',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const still = (await api.list()).find((d) => d.id === device.id);
    expect(still!.status).toBe('ACTIVE');
  });

  it('revokes with manager co-authorization, writing the C7 evidence record atomically', async () => {
    const api = caller();
    const { device } = await api.initiateEnrollment({ branchId, name: 'POS-revoke' });

    const result = await api.revoke({
      deviceId: device.id,
      actingStaffProfileId: actingStaffId,
      approvingStaffProfileId: approvingStaffId,
      approvingType: 'PIN',
      approvingSecret: APPROVING_PIN,
      reason: 'lost device',
    });

    expect(result.device.status).toBe('REVOKED');
    expect(result.coAuthorizationId).toBeTruthy();

    const [coAuth, revoked] = await deps.withTenantDb(orgId, (tx) =>
      Promise.all([
        tx.restaurantCoAuthorization.findUnique({ where: { id: result.coAuthorizationId } }),
        tx.restaurantRegisteredDevice.findUnique({ where: { id: device.id } }),
      ])
    );
    expect(coAuth).toMatchObject({
      actingStaffProfileId: actingStaffId,
      approvingStaffProfileId: approvingStaffId,
      capability: 'devices:revoke',
      targetType: 'RestaurantRegisteredDevice',
      targetId: device.id,
      reason: 'lost device',
    });
    expect(revoked!.status).toBe('REVOKED');
    expect(revoked!.revokedAt).toBeInstanceOf(Date);

    // A successful approval cleared the durable counter (C4).
    const cleared = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOperatorCredential.findFirst({ where: { staffProfileId: approvingStaffId } })
    );
    expect(cleared!.failedAttempts).toBe(0);

    // Re-revoking an already-revoked device is rejected.
    await expect(
      api.revoke({
        deviceId: device.id,
        actingStaffProfileId: actingStaffId,
        approvingStaffProfileId: approvingStaffId,
        approvingType: 'PIN',
        approvingSecret: APPROVING_PIN,
        reason: 'again',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
