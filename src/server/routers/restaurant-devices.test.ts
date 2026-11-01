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
 * The suite asserts that its runtime connection is LOGIN, NOSUPERUSER, and
 * NOBYPASSRLS before making tenant-isolation claims. The tRPC middleware that
 * needs Auth.js / the ABAC engine is mocked (`resolveTenantActor`, `can`) exactly
 * as the sibling admin-router tests do; the database and the router are real.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  annotateAudit: vi.fn(),
  can: vi.fn(async () => true),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
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
const otherOrgId = `org_wha22_other_${suffix}`;
const branchId = `branch_${suffix}`;
const otherBranchId = `branch_other_${suffix}`;
const foreignBranchId = `branch_foreign_${suffix}`;
const foreignDeviceId = `device_foreign_${suffix}`;
const inactiveStaffId = `staff_inactive_${suffix}`;
const foreignStaffId = `staff_foreign_${suffix}`;
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
  hashDeviceSecret: (typeof import('@/lib/restaurant/devices'))['hashDeviceSecret'];
  resolveDeviceBySecret: (typeof import('@/lib/restaurant/devices'))['resolveDeviceBySecret'];
  rotateDeviceSecret: (typeof import('@/lib/restaurant/devices'))['rotateDeviceSecret'];
};

let deps: Deps;

function adminCtx(db: unknown, userId = 'user_admin') {
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
      limits: { 'pos.registeredDevices.max': 100, 'pos.terminals.max': 100 },
    },
    session: {
      expires: 'later',
      user: {
        id: userId,
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

const caller = (userId = 'user_admin') =>
  deps.restaurantDevicesRouter.createCaller(adminCtx(deps.createTenantDb(orgId), userId));

async function rotationState(deviceId: string) {
  return deps.withTenantDb(orgId, async (tx) => {
    const [device, coAuthorizationCount] = await Promise.all([
      tx.restaurantRegisteredDevice.findUniqueOrThrow({
        where: { id: deviceId },
        select: { deviceSecretHash: true },
      }),
      tx.restaurantCoAuthorization.count({ where: { targetId: deviceId } }),
    ]);
    return { deviceSecretHash: device.deviceSecretHash, coAuthorizationCount };
  });
}

async function expectUnchangedRotationState(
  deviceId: string,
  expected: Awaited<ReturnType<typeof rotationState>>
) {
  await expect(rotationState(deviceId)).resolves.toEqual(expected);
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, routerModule, credModule, deviceModule] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./restaurant-devices'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/lib/restaurant/devices'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    createTenantDb: scopedDb.createTenantDb,
    restaurantDevicesRouter: routerModule.restaurantDevicesRouter,
    hashOperatorCredential: credModule.hashOperatorCredential,
    hashDeviceSecret: deviceModule.hashDeviceSecret,
    resolveDeviceBySecret: deviceModule.resolveDeviceBySecret,
    rotateDeviceSecret: deviceModule.rotateDeviceSecret,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.createMany({
      data: [
        {
          id: orgId,
          slug: `wha920-devices-${suffix}`,
          legalName: 'WHA-920 Devices Test',
          displayName: 'WHA-920 Devices',
          status: 'ACTIVE',
        },
        {
          id: otherOrgId,
          slug: `wha920-devices-other-${suffix}`,
          legalName: 'WHA-920 Other Devices Test',
          displayName: 'WHA-920 Other Devices',
          status: 'ACTIVE',
        },
      ],
    })
  );

  const approvingHash = await deps.hashOperatorCredential('PIN', APPROVING_PIN);
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.organizationDepartment.create({
      data: { key: 'LEADERSHIP', name: 'Leadership' },
    });
    await tx.user.create({
      data: {
        id: 'user_admin',
        name: 'Device administrator',
        email: `device-admin-${suffix}@example.test`,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: 'Device administrator',
      },
    });
    await tx.user.createMany({
      data: [
        {
          id: 'user_absent',
          name: 'Unmapped administrator',
          email: `device-absent-${suffix}@example.test`,
          role: 'ADMIN',
          department: 'LEADERSHIP',
          title: 'Device administrator',
        },
        {
          id: 'user_inactive',
          name: 'Inactive administrator',
          email: `device-inactive-${suffix}@example.test`,
          role: 'ADMIN',
          department: 'LEADERSHIP',
          title: 'Device administrator',
        },
      ],
    });
    await tx.restaurantBranch.createMany({
      data: [
        { id: branchId, name: 'Downtown' },
        { id: otherBranchId, name: 'Airport' },
      ],
    });
    await tx.restaurantStaffProfile.create({
      data: {
        id: actingStaffId,
        userId: 'user_admin',
        displayName: 'Acting Admin',
        status: 'ACTIVE',
      },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: approvingStaffId, displayName: 'Shift Manager', status: 'ACTIVE' },
    });
    await tx.restaurantStaffProfile.create({
      data: {
        id: unprivilegedStaffId,
        displayName: 'Unprivileged Manager',
        status: 'ACTIVE',
        primaryBranchId: branchId,
      },
    });
    await tx.restaurantStaffProfile.create({
      data: {
        id: inactiveStaffId,
        userId: 'user_inactive',
        displayName: 'Inactive Admin',
        status: 'SUSPENDED',
      },
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
    const approverRole = await tx.restaurantJobRole.create({
      data: { key: `device-approver-${suffix}`, name: 'Device approver', active: true },
    });
    await tx.restaurantJobRoleCapability.createMany({
      data: [
        { jobRoleId: managerRole.id, capability: 'devices:manage' },
        { jobRoleId: managerRole.id, capability: 'devices:revoke' },
      ],
    });
    await tx.restaurantJobRoleCapability.create({
      data: { jobRoleId: approverRole.id, capability: 'coauth:approve' },
    });
    await tx.restaurantStaffJobRole.create({
      data: { staffProfileId: actingStaffId, jobRoleId: managerRole.id, branchId },
    });
    await tx.restaurantStaffJobRole.create({
      data: {
        staffProfileId: approvingStaffId,
        jobRoleId: approverRole.id,
        branchId,
      },
    });
    await tx.restaurantStaffJobRole.create({
      data: { staffProfileId: unprivilegedStaffId, jobRoleId: managerRole.id, branchId },
    });
  });
  await deps.withTenantDb(otherOrgId, async (tx) => {
    await tx.organizationDepartment.create({
      data: { key: 'LEADERSHIP', name: 'Leadership' },
    });
    await tx.user.create({
      data: {
        id: 'user_foreign',
        name: 'Foreign administrator',
        email: `device-foreign-${suffix}@example.test`,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: 'Device administrator',
      },
    });
    await tx.restaurantBranch.create({ data: { id: foreignBranchId, name: 'Foreign branch' } });
    await tx.restaurantStaffProfile.create({
      data: {
        id: foreignStaffId,
        userId: 'user_foreign',
        displayName: 'Foreign Admin',
        status: 'ACTIVE',
      },
    });
    await tx.restaurantRegisteredDevice.create({
      data: {
        id: foreignDeviceId,
        branchId: foreignBranchId,
        name: 'Foreign POS',
        deviceSecretHash: deps.hashDeviceSecret(`rdk_foreign_${suffix}`),
      },
    });
  });
});

beforeEach(() => {
  mocks.annotateAudit.mockClear();
  mocks.can.mockReset();
  mocks.can.mockResolvedValue(true);
});

afterAll(async () => {
  if (!TEST_DATABASE_URL || !deps) return;
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantCoAuthorization.deleteMany({ where: { organizationId: orgId } });
    await tx.restaurantTerminalSession.deleteMany({ where: { organizationId: orgId } });
    await tx.restaurantOperatorCredential.deleteMany({ where: { organizationId: orgId } });
    await tx.restaurantStaffJobRole.deleteMany({ where: { organizationId: orgId } });
    await tx.restaurantJobRoleCapability.deleteMany({ where: { organizationId: orgId } });
    await tx.restaurantRegisteredDevice.deleteMany({ where: { organizationId: orgId } });
    await tx.restaurantStaffProfile.deleteMany({ where: { organizationId: orgId } });
    await tx.restaurantJobRole.deleteMany({ where: { organizationId: orgId } });
    await tx.restaurantBranch.deleteMany({ where: { organizationId: orgId } });
    await tx.user.deleteMany({ where: { organizationId: orgId } });
    await tx.organizationDepartment.deleteMany({ where: { organizationId: orgId } });
  });

  const remaining = await deps.withPlatformDb((tx) =>
    Promise.all([
      tx.restaurantCoAuthorization.count({ where: { organizationId: orgId } }),
      tx.restaurantTerminalSession.count({ where: { organizationId: orgId } }),
      tx.restaurantOperatorCredential.count({ where: { organizationId: orgId } }),
      tx.restaurantStaffJobRole.count({ where: { organizationId: orgId } }),
      tx.restaurantJobRoleCapability.count({ where: { organizationId: orgId } }),
      tx.restaurantRegisteredDevice.count({ where: { organizationId: orgId } }),
      tx.restaurantStaffProfile.count({ where: { organizationId: orgId } }),
      tx.restaurantJobRole.count({ where: { organizationId: orgId } }),
      tx.restaurantBranch.count({ where: { organizationId: orgId } }),
      tx.user.count({ where: { organizationId: orgId } }),
      tx.organizationDepartment.count({ where: { organizationId: orgId } }),
    ])
  );
  expect(remaining).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  await deps.withPlatformDb(async (tx) => {
    await tx.restaurantRegisteredDevice.deleteMany({ where: { organizationId: otherOrgId } });
    await tx.restaurantStaffProfile.deleteMany({ where: { organizationId: otherOrgId } });
    await tx.restaurantBranch.deleteMany({ where: { organizationId: otherOrgId } });
    await tx.user.deleteMany({ where: { organizationId: otherOrgId } });
    await tx.organizationDepartment.deleteMany({ where: { organizationId: otherOrgId } });
    await tx.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    expect(await tx.organization.count({ where: { id: { in: [orgId, otherOrgId] } } })).toBe(0);
  });
});

describeIfDatabase('restaurantDevices router (real DB)', () => {
  it('runs through a LOGIN NOSUPERUSER NOBYPASSRLS runtime connection', async () => {
    const [role] = await deps.withTenantDb(
      orgId,
      (tx) =>
        tx.$queryRaw<
          { rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]
        >`SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls
          FROM pg_roles r
         WHERE r.rolname = current_user`
    );
    expect(role).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
  });

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

  it('lists only distinct eligible approvers using coauth:approve branch scope', async () => {
    mocks.can.mockImplementation(async (...args: unknown[]) => args[1] === 'devices:manage');
    const api = caller();
    const enrolled = await api.initiateEnrollment({ branchId, name: 'POS-approvers' });

    const directory = await api.listApprovers({ deviceId: enrolled.device.id });

    expect(directory).toEqual({
      actingStaff: { id: actingStaffId, displayName: 'Acting Admin' },
      approvers: [{ id: approvingStaffId, displayName: 'Shift Manager' }],
    });
    expect(JSON.stringify(directory)).not.toContain(unprivilegedStaffId);
    expect(JSON.stringify(directory)).not.toContain(inactiveStaffId);
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'devices:manage',
      undefined,
      expect.anything()
    );
    expect(mocks.can).not.toHaveBeenCalledWith(
      expect.anything(),
      'staff:manage',
      undefined,
      expect.anything()
    );
  });

  it('rejects a self-approval (approver must differ from actor) before any compare', async () => {
    const api = caller();
    const { device } = await api.initiateEnrollment({ branchId, name: 'POS-self' });
    await expect(
      api.revoke({
        deviceId: device.id,
        actingStaffProfileId: approvingStaffId,
        approvingStaffProfileId: actingStaffId,
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

  it.each(['revoke', 'rotate'] as const)(
    'rejects %s with a valid credential that has devices:manage but not coauth:approve',
    async (operation) => {
      const api = caller();
      const { device } = await api.initiateEnrollment({
        branchId,
        name: `POS-no-approval-${operation}`,
      });

      const input = {
        deviceId: device.id,
        approvingStaffProfileId: unprivilegedStaffId,
        approvingType: 'PIN' as const,
        approvingSecret: APPROVING_PIN,
        reason: 'capability check',
      };
      const before = await rotationState(device.id);
      const attempt = operation === 'revoke' ? api.revoke(input) : api.rotate(input);

      await expect(attempt).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'The approving staff member lacks co-authorization approval permission.',
      });
      await expectUnchangedRotationState(device.id, before);

      const still = (await api.list()).find((d) => d.id === device.id);
      expect(still!.status).toBe('ACTIVE');
    }
  );

  it('rejects an ineligible approver before evaluating their credential', async () => {
    const api = caller();
    const { device } = await api.initiateEnrollment({
      branchId,
      name: 'POS-ineligible-credential',
    });
    const credentialBefore = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOperatorCredential.findFirstOrThrow({
        where: { staffProfileId: unprivilegedStaffId },
        select: { failedAttempts: true },
      })
    );

    await expect(
      api.revoke({
        deviceId: device.id,
        actingStaffProfileId: actingStaffId,
        approvingStaffProfileId: unprivilegedStaffId,
        approvingType: 'PIN',
        approvingSecret: '000000',
        reason: 'capability before credential',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The approving staff member lacks co-authorization approval permission.',
    });

    await expect(
      deps.withTenantDb(orgId, (tx) =>
        tx.restaurantOperatorCredential.findFirstOrThrow({
          where: { staffProfileId: unprivilegedStaffId },
          select: { failedAttempts: true },
        })
      )
    ).resolves.toEqual(credentialBefore);
  });

  it('excludes and rejects an approver whose inherited coauth:approve is explicitly denied', async () => {
    const api = caller();
    const revokeEnrollment = await api.initiateEnrollment({
      branchId,
      name: 'POS-denied-approval-revoke',
    });
    const rotateEnrollment = await api.initiateEnrollment({
      branchId,
      name: 'POS-denied-approval-rotate',
    });

    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStaffCapabilityGrant.create({
        data: {
          staffProfileId: approvingStaffId,
          branchId,
          capability: 'coauth:approve',
          effect: 'DENY',
        },
      })
    );

    try {
      await expect(
        api.listApprovers({ deviceId: revokeEnrollment.device.id })
      ).resolves.toMatchObject({ approvers: [] });

      for (const [operation, deviceId] of [
        ['revoke', revokeEnrollment.device.id],
        ['rotate', rotateEnrollment.device.id],
      ] as const) {
        const input = {
          deviceId,
          approvingStaffProfileId: approvingStaffId,
          approvingType: 'PIN' as const,
          approvingSecret: APPROVING_PIN,
          reason: 'explicit deny check',
        };
        const before = await rotationState(deviceId);
        const attempt = operation === 'revoke' ? api.revoke(input) : api.rotate(input);

        await expect(attempt).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'The approving staff member lacks co-authorization approval permission.',
        });
        await expectUnchangedRotationState(deviceId, before);
        const still = (await api.list()).find((device) => device.id === deviceId);
        expect(still!.status).toBe('ACTIVE');
      }
    } finally {
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantStaffCapabilityGrant.delete({
          where: {
            staffProfileId_branchId_capability: {
              staffProfileId: approvingStaffId,
              branchId,
              capability: 'coauth:approve',
            },
          },
        })
      );
    }
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

  it('rejects an actor who can manage devices but is explicitly denied devices:revoke', async () => {
    const api = caller();
    const { device } = await api.initiateEnrollment({ branchId, name: 'POS-revoke-denied' });

    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStaffCapabilityGrant.create({
        data: {
          staffProfileId: actingStaffId,
          branchId,
          capability: 'devices:revoke',
          effect: 'DENY',
        },
      })
    );

    try {
      await expect(
        api.revoke({
          deviceId: device.id,
          approvingStaffProfileId: approvingStaffId,
          approvingType: 'PIN',
          approvingSecret: APPROVING_PIN,
          reason: 'must not bypass dedicated capability',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      await expect(
        deps.withTenantDb(orgId, (tx) =>
          tx.restaurantRegisteredDevice.findUnique({ where: { id: device.id } })
        )
      ).resolves.toMatchObject({ status: 'ACTIVE' });
      await expect(
        deps.withTenantDb(orgId, (tx) =>
          tx.restaurantCoAuthorization.count({ where: { targetId: device.id } })
        )
      ).resolves.toBe(0);
    } finally {
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantStaffCapabilityGrant.delete({
          where: {
            staffProfileId_branchId_capability: {
              staffProfileId: actingStaffId,
              branchId,
              capability: 'devices:revoke',
            },
          },
        })
      );
    }
  });

  it('ignores a forged acting profile and records the authenticated session actor', async () => {
    const api = caller();
    const { device } = await api.initiateEnrollment({ branchId, name: 'POS-forged-actor' });

    const result = await api.revoke({
      deviceId: device.id,
      actingStaffProfileId: unprivilegedStaffId,
      approvingStaffProfileId: approvingStaffId,
      approvingType: 'PIN',
      approvingSecret: APPROVING_PIN,
      reason: 'forged actor probe',
    });

    await expect(
      deps.withTenantDb(orgId, (tx) =>
        tx.restaurantCoAuthorization.findUnique({ where: { id: result.coAuthorizationId } })
      )
    ).resolves.toMatchObject({ actingStaffProfileId: actingStaffId });
  });

  it('rotates once, immediately rejects the old secret, and records redacted co-authorization audit', async () => {
    const api = caller();
    const enrolled = await api.initiateEnrollment({ branchId, name: 'POS-rotate' });
    mocks.annotateAudit.mockClear();

    const result = await api.rotate({
      deviceId: enrolled.device.id,
      approvingStaffProfileId: approvingStaffId,
      approvingType: 'PIN',
      approvingSecret: APPROVING_PIN,
      reason: 'scheduled credential rotation',
    });

    expect(result.secret).toMatch(/^rdk_/);
    expect(result.secret).not.toBe(enrolled.enrollmentSecret);
    expect(
      await deps.withTenantDb(orgId, (tx) =>
        deps.resolveDeviceBySecret(tx, enrolled.enrollmentSecret)
      )
    ).toBeNull();
    expect(
      await deps.withTenantDb(orgId, (tx) => deps.resolveDeviceBySecret(tx, result.secret))
    ).toMatchObject({ id: enrolled.device.id, status: 'ACTIVE' });

    const coAuth = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantCoAuthorization.findUnique({ where: { id: result.coAuthorizationId } })
    );
    expect(coAuth).toMatchObject({
      actingStaffProfileId: actingStaffId,
      approvingStaffProfileId: approvingStaffId,
      capability: 'devices:manage',
      targetId: enrolled.device.id,
      reason: 'scheduled credential rotation',
    });
    expect(mocks.annotateAudit.mock.calls[0]?.[1]).toEqual({ skipInput: true });
    expect(mocks.annotateAudit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        skipInput: true,
        targetId: enrolled.device.id,
        metadata: expect.objectContaining({ coAuthorizationId: result.coAuthorizationId }),
      })
    );
    expect(JSON.stringify(mocks.annotateAudit.mock.calls)).not.toContain(APPROVING_PIN);
    expect(JSON.stringify(mocks.annotateAudit.mock.calls)).not.toContain(result.secret);
  });

  it('allows only one concurrent rotation from the same observed device state', async () => {
    const enrolled = await caller().initiateEnrollment({ branchId, name: 'POS-concurrent' });
    const observed = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantRegisteredDevice.findUniqueOrThrow({ where: { id: enrolled.device.id } })
    );

    const attempts = await Promise.allSettled([
      deps.withTenantDb(orgId, (tx) =>
        deps.rotateDeviceSecret(tx, enrolled.device.id, observed.deviceSecretHash)
      ),
      deps.withTenantDb(orgId, (tx) =>
        deps.rotateDeviceSecret(tx, enrolled.device.id, observed.deviceSecretHash)
      ),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { reason: 'STALE_ROTATION' } });
  });

  it('uses devices:manage without implicitly requiring staff:manage', async () => {
    const api = caller();
    const enrolled = await api.initiateEnrollment({ branchId, name: 'POS-device-capability' });
    mocks.can.mockImplementation(async (...args: unknown[]) => args[1] !== 'restaurant:configure');

    await expect(
      api.rotate({
        deviceId: enrolled.device.id,
        approvingStaffProfileId: approvingStaffId,
        approvingType: 'PIN',
        approvingSecret: APPROVING_PIN,
        reason: 'device capability only',
      })
    ).resolves.toMatchObject({ device: { id: enrolled.device.id, status: 'ACTIVE' } });
  });

  it('rejects spoofed actor input before any rotation or audit annotation', async () => {
    const api = caller();
    const enrolled = await api.initiateEnrollment({ branchId, name: 'POS-spoof' });
    const before = await rotationState(enrolled.device.id);
    mocks.annotateAudit.mockClear();

    await expect(
      api.rotate({
        deviceId: enrolled.device.id,
        actingStaffProfileId: approvingStaffId,
        approvingStaffProfileId: approvingStaffId,
        approvingType: 'PIN',
        approvingSecret: APPROVING_PIN,
        reason: 'spoof actor',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expectUnchangedRotationState(enrolled.device.id, before);
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', 'user_absent'],
    ['inactive', 'user_inactive'],
    ['cross-tenant', 'user_foreign'],
  ])('fails closed for an %s authenticated actor mapping', async (_label, userId) => {
    const enrolled = await caller().initiateEnrollment({ branchId, name: `POS-${_label}` });
    const before = await rotationState(enrolled.device.id);
    mocks.annotateAudit.mockClear();

    await expect(
      caller(userId).rotate({
        deviceId: enrolled.device.id,
        approvingStaffProfileId: approvingStaffId,
        approvingType: 'PIN',
        approvingSecret: APPROVING_PIN,
        reason: `${_label} actor`,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expectUnchangedRotationState(enrolled.device.id, before);
    expect(mocks.annotateAudit.mock.calls).toEqual([[expect.anything(), { skipInput: true }]]);
  });

  it('denies cross-tenant devices and cross-branch actor mappings without mutation', async () => {
    // A branch-scoped administrator: devices:manage, but not organization-wide.
    mocks.can.mockImplementation(async (...args: unknown[]) => args[1] !== 'restaurant:configure');
    const api = caller();
    const branchLocal = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantRegisteredDevice.create({
        data: {
          branchId: otherBranchId,
          name: 'Airport POS',
          deviceSecretHash: deps.hashDeviceSecret(`rdk_airport_${suffix}`),
        },
      })
    );
    const input = {
      approvingStaffProfileId: approvingStaffId,
      approvingType: 'PIN' as const,
      approvingSecret: APPROVING_PIN,
      reason: 'scope probe',
    };

    const branchBefore = await rotationState(branchLocal.id);
    mocks.annotateAudit.mockClear();
    await expect(api.rotate({ ...input, deviceId: branchLocal.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expectUnchangedRotationState(branchLocal.id, branchBefore);
    expect(mocks.annotateAudit.mock.calls).toEqual([[expect.anything(), { skipInput: true }]]);

    mocks.annotateAudit.mockClear();
    await expect(api.rotate({ ...input, deviceId: foreignDeviceId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.annotateAudit.mock.calls).toEqual([[expect.anything(), { skipInput: true }]]);
  });

  it('lets an organization-wide owner list approvers and revoke on a branch they are not linked to', async () => {
    // The acting owner's staff profile is linked only to Downtown; the device is at Airport.
    const device = await deps.withTenantDb(orgId, async (tx) => {
      const approverRole = await tx.restaurantJobRole.findFirstOrThrow({
        where: { key: `device-approver-${suffix}` },
        select: { id: true },
      });
      await tx.restaurantStaffJobRole.create({
        data: {
          staffProfileId: approvingStaffId,
          jobRoleId: approverRole.id,
          branchId: otherBranchId,
        },
      });
      return tx.restaurantRegisteredDevice.create({
        data: {
          branchId: otherBranchId,
          name: 'Airport KDS',
          deviceSecretHash: deps.hashDeviceSecret(`rdk_airport_owner_${suffix}`),
        },
      });
    });
    const api = caller();

    await expect(api.listApprovers({ deviceId: device.id })).resolves.toEqual({
      actingStaff: { id: actingStaffId, displayName: 'Acting Admin' },
      approvers: [{ id: approvingStaffId, displayName: 'Shift Manager' }],
    });
    await expect(
      api.revoke({
        deviceId: device.id,
        approvingStaffProfileId: approvingStaffId,
        approvingType: 'PIN',
        approvingSecret: APPROVING_PIN,
        reason: 'owner revokes an unlinked branch device',
      })
    ).resolves.toMatchObject({ device: { id: device.id, status: 'REVOKED' } });
  });
});
