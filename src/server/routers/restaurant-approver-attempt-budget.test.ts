/**
 * DEV-1055: the back-office approvals that verify a manager's PIN or badge (device
 * revoke, device rotate, camera gateway revoke) count attempts per approver in the
 * rate-limit store, outside the request transaction. A wrong credential fails the
 * request and rolls its transaction back; the credential check commits its durable
 * strike in its own transaction (covered by the database suite), and this budget
 * is the second, outer limit.
 *
 * Runs the REAL routers and the real in-memory rate-limit store; the credential
 * check itself is stubbed (its lockout is covered by the database suite).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  staffCapabilities: vi.fn(async (): Promise<Set<string>> => new Set()),
  authenticateOperator: vi.fn(),
  createCoAuthorization: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  // The credential check commits in its own tenant transaction; here it is a stub.
  withTenantDb: vi.fn((_organizationId: string, run: (tx: unknown) => unknown) =>
    run({ $queryRawUnsafe: vi.fn(async () => []) })
  ),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/job-roles', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/job-roles')>(
    '@/lib/restaurant/job-roles'
  );
  return {
    ...actual,
    resolveStaffCapabilities: mocks.staffCapabilities,
    // The approver holds coauth:approve at the device's branch.
    staffHasCapability: vi.fn(async () => true),
  };
});
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/restaurant/camera-gateway-runtime', () => ({
  cameraGatewayRuntime: { available: true, adapter: {} },
}));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  authenticateOperator: mocks.authenticateOperator,
}));

import {
  authenticateApproverWithinBudget,
  clearRestaurantApproverAttempts,
} from '@/lib/restaurant/approver-attempt-budget';
import type { TRPCContext } from '../trpc';
import { restaurantCamerasRouter } from './restaurant-cameras';
import { restaurantDevicesRouter } from './restaurant-devices';

const ORG = 'org_budget';
const INVALID = { ok: false as const, reason: 'INVALID' as const };
const VERIFIED = { ok: true as const, credentialId: 'cred', staffProfileId: 'staff_approver' };

const db = {
  restaurantRegisteredDevice: {
    findUnique: vi.fn(async () => ({
      id: 'device_1',
      branchId: 'branch_1',
      name: 'Front POS',
      status: 'ACTIVE',
      revokedAt: null,
      deviceSecretHash: 'hash',
    })),
  },
  restaurantStaffProfile: {
    findMany: vi.fn(async () => [
      {
        id: 'staff_acting',
        primaryBranchId: 'branch_1',
        jobRoles: [{ branchId: 'branch_1' }],
        directCapabilityGrants: [],
      },
    ]),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      status: 'ACTIVE',
    })),
  },
  restaurantBranch: { findMany: vi.fn(async () => [{ id: 'branch_1' }]) },
  restaurantCoAuthorization: { create: mocks.createCoAuthorization },
  restaurantCameraGateway: {
    findUnique: vi.fn(async () => ({ id: 'gateway_1', branchId: 'branch_1', status: 'ACTIVE' })),
  },
};

const ctx = {
  db,
  entitlements: {
    enabledModules: ['restaurant-pos', 'restaurant-integrations'],
    modules: [],
    organizationId: ORG,
  },
  session: {
    expires: 'later',
    user: { id: 'user_admin', role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
  },
  organization: { id: ORG },
  support: null,
  requestMeta: { ip: null, userAgent: null },
  audit: { detail: {} },
} as unknown as TRPCContext;

const approval = (approvingStaffProfileId: string) => ({
  approvingStaffProfileId,
  approvingType: 'PIN' as const,
  approvingSecret: '000000',
  reason: 'lost terminal',
});

const approvals = {
  'restaurantDevices.revoke': (approver: string) =>
    restaurantDevicesRouter
      .createCaller(ctx)
      .revoke({ deviceId: 'device_1', ...approval(approver) }),
  'restaurantDevices.rotate': (approver: string) =>
    restaurantDevicesRouter
      .createCaller(ctx)
      .rotate({ deviceId: 'device_1', ...approval(approver) }),
  'restaurantCameras.revokeGateway': (approver: string) =>
    restaurantCamerasRouter.createCaller(ctx).revokeGateway({
      gatewayId: 'gateway_1',
      actingStaffProfileId: 'staff_acting',
      ...approval(approver),
    }),
};

let approverSeq = 0;
/** A fresh approver per test, so no test inherits another's spent budget. */
const freshApprover = () => `staff_approver_${++approverSeq}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.staffCapabilities.mockResolvedValue(
    new Set(['devices:manage', 'devices:revoke', 'coauth:approve'])
  );
  mocks.authenticateOperator.mockResolvedValue(INVALID);
});

describe('DEV-1055: per-approver attempt budget on back-office approvals', () => {
  it.each(Object.keys(approvals) as (keyof typeof approvals)[])(
    '%s stops checking the credential after five wrong attempts',
    async (name) => {
      const approver = freshApprover();

      for (let i = 0; i < 5; i += 1) {
        await expect(approvals[name](approver)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(mocks.authenticateOperator).toHaveBeenCalledTimes(5);

      // The sixth guess is refused without the credential being checked at all.
      await expect(approvals[name](approver)).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        message: 'Approving manager credential is temporarily locked.',
      });
      expect(mocks.authenticateOperator).toHaveBeenCalledTimes(5);
      expect(mocks.createCoAuthorization).not.toHaveBeenCalled();

      // The budget is per approver: another manager is unaffected.
      await expect(approvals[name](freshApprover())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.authenticateOperator).toHaveBeenCalledTimes(6);
    }
  );

  it('shares one budget across the three approvals', async () => {
    const approver = freshApprover();

    await expect(approvals['restaurantDevices.revoke'](approver)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(approvals['restaurantDevices.rotate'](approver)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(approvals['restaurantCameras.revokeGateway'](approver)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    await expect(approvals['restaurantDevices.revoke'](approver)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mocks.authenticateOperator).toHaveBeenCalledTimes(5);
  });

  it('restores the budget when the credential is verified, and answers LOCKED when it is gone', async () => {
    const approver = freshApprover();
    const authenticate = vi.fn(async (): Promise<typeof INVALID | typeof VERIFIED> => INVALID);

    for (let i = 0; i < 4; i += 1) {
      await expect(authenticateApproverWithinBudget(ORG, approver, authenticate)).resolves.toEqual(
        INVALID
      );
    }
    authenticate.mockResolvedValueOnce(VERIFIED);
    await expect(authenticateApproverWithinBudget(ORG, approver, authenticate)).resolves.toEqual(
      VERIFIED
    );

    // A verified credential gives the approver a fresh set of five.
    for (let i = 0; i < 5; i += 1) {
      await expect(authenticateApproverWithinBudget(ORG, approver, authenticate)).resolves.toEqual(
        INVALID
      );
    }
    expect(authenticate).toHaveBeenCalledTimes(10);
    await expect(
      authenticateApproverWithinBudget(ORG, approver, authenticate)
    ).resolves.toMatchObject({ ok: false, reason: 'LOCKED', retryAfterMs: expect.any(Number) });
    expect(authenticate).toHaveBeenCalledTimes(10);

    // The same approver id in another organization has its own budget.
    await expect(
      authenticateApproverWithinBudget('org_other', approver, authenticate)
    ).resolves.toEqual(INVALID);
    await clearRestaurantApproverAttempts(ORG, approver);
  });
});
