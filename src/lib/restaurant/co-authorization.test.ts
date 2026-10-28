import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock('./terminal-auth', () => ({ authenticateOperator: mocks.authenticate }));

import {
  CoAuthorizationError,
  authenticateCoAuthorizationOperator,
  buildAuthenticatedCoAuthorizationRecord,
  assertCoAuthorization,
  buildCoAuthorizationRecord,
  type CoAuthorizationRequest,
} from './co-authorization';

const terminalRequest: CoAuthorizationRequest = {
  actingStaffProfileId: 'staff_actor',
  approvingStaffProfileId: 'staff_manager',
  capability: 'orders:void',
  reason: 'Guest disputed a duplicate charge',
  targetType: 'Order',
  targetId: 'order_123',
  deviceId: 'device_1',
  terminalSessionId: 'session_1',
};

describe('assertCoAuthorization (C6/C7 invariants)', () => {
  it('accepts a well-formed terminal-path co-authorization', () => {
    expect(() => assertCoAuthorization(terminalRequest)).not.toThrow();
  });

  it('rejects a self-approval — the approver must be a second identity (C6)', () => {
    expect(() =>
      assertCoAuthorization({ ...terminalRequest, approvingStaffProfileId: 'staff_actor' })
    ).toThrow(CoAuthorizationError);
  });

  it('requires a non-empty capability and reason (C7 evidence)', () => {
    expect(() => assertCoAuthorization({ ...terminalRequest, capability: '   ' })).toThrow(
      CoAuthorizationError
    );
    expect(() => assertCoAuthorization({ ...terminalRequest, reason: '' })).toThrow(
      CoAuthorizationError
    );
  });

  it('rejects a half-specified target (type without id, or id without type)', () => {
    expect(() =>
      assertCoAuthorization({ ...terminalRequest, targetType: 'Order', targetId: null })
    ).toThrow(CoAuthorizationError);
    expect(() =>
      assertCoAuthorization({ ...terminalRequest, targetType: null, targetId: 'order_123' })
    ).toThrow(CoAuthorizationError);
  });
});

describe('buildCoAuthorizationRecord', () => {
  it('returns a create-shaped record without organizationId or createdAt (DB supplies both)', () => {
    const record = buildCoAuthorizationRecord(terminalRequest);
    expect(record).toEqual({
      actingStaffProfileId: 'staff_actor',
      approvingStaffProfileId: 'staff_manager',
      capability: 'orders:void',
      reason: 'Guest disputed a duplicate charge',
      targetType: 'Order',
      targetId: 'order_123',
      deviceId: 'device_1',
      terminalSessionId: 'session_1',
    });
    expect(record).not.toHaveProperty('organizationId');
    expect(record).not.toHaveProperty('createdAt');
  });

  it('supports the back-office path with no device or terminal session', () => {
    const record = buildCoAuthorizationRecord({
      actingStaffProfileId: 'staff_actor',
      approvingStaffProfileId: 'staff_manager',
      capability: 'staff:manage',
      reason: 'Promoted to shift lead',
      targetType: 'RestaurantStaffProfile',
      targetId: 'staff_actor',
    });
    expect(record.deviceId).toBeNull();
    expect(record.terminalSessionId).toBeNull();
  });

  it('trims strings and folds blank optionals to null', () => {
    const record = buildCoAuthorizationRecord({
      ...terminalRequest,
      reason: '  discount over threshold  ',
      deviceId: '   ',
      terminalSessionId: '',
    });
    expect(record.reason).toBe('discount over threshold');
    expect(record.deviceId).toBeNull();
    expect(record.terminalSessionId).toBeNull();
  });
});

describe('authenticated solo-owner exception', () => {
  const self = {
    ...terminalRequest,
    approvingStaffProfileId: terminalRequest.actingStaffProfileId,
  };
  const params = {
    staffProfileId: self.actingStaffProfileId,
    branchId: 'branch_1',
    type: 'PIN' as const,
    secret: 'test-only-secret',
    now: new Date(),
  };
  function database(options: { owner?: boolean; staff?: string[] } = {}) {
    return {
      restaurantBranch: {
        findUnique: vi.fn(async () => ({ id: 'branch_1', organizationId: 'org_1', active: true })),
      },
      restaurantStaffJobRole: {
        findMany: vi.fn(async () => [
          { jobRole: { capabilities: [{ capability: 'coauth:approve' }] } },
        ]),
      },
      restaurantStaffCapabilityGrant: { findMany: vi.fn(async () => []) },
      restaurantStaffProfile: {
        findUnique: vi.fn(async () => ({
          status: 'ACTIVE',
          primaryBranchId: 'branch_1',
          jobRoles: [],
          directCapabilityGrants: [],
          user: null,
        })),
        findFirst: vi.fn(async () =>
          options.owner === false ? null : { id: self.actingStaffProfileId }
        ),
        findMany: vi.fn(async () =>
          (options.staff ?? [self.actingStaffProfileId]).map((id) => ({ id }))
        ),
      },
    } as unknown as ScopedDb;
  }
  beforeEach(() => {
    mocks.authenticate.mockReset();
    mocks.authenticate.mockResolvedValue({ ok: true, staffProfileId: self.actingStaffProfileId });
  });

  it('requires fresh re-authentication, scopes proof to its database client, and consumes it once', async () => {
    const db = database();
    await expect(buildAuthenticatedCoAuthorizationRecord(db, self)).rejects.toThrow(
      CoAuthorizationError
    );
    await authenticateCoAuthorizationOperator(db, params);
    await expect(buildAuthenticatedCoAuthorizationRecord(database(), self)).rejects.toThrow(
      CoAuthorizationError
    );
    const record = await buildAuthenticatedCoAuthorizationRecord(db, self);
    expect(record.reason).toContain('PIN re-authenticated');
    expect(record.reason).not.toContain(params.secret);
    await expect(buildAuthenticatedCoAuthorizationRecord(db, self)).rejects.toThrow(
      CoAuthorizationError
    );
  });

  it('rejects badge and invalid PIN re-authentication', async () => {
    const db = database();
    await authenticateCoAuthorizationOperator(db, { ...params, type: 'BADGE' });
    await expect(buildAuthenticatedCoAuthorizationRecord(db, self)).rejects.toThrow(
      CoAuthorizationError
    );
    mocks.authenticate.mockResolvedValue({ ok: false, reason: 'INVALID' });
    await authenticateCoAuthorizationOperator(db, params);
    await expect(buildAuthenticatedCoAuthorizationRecord(db, self)).rejects.toThrow(
      CoAuthorizationError
    );
  });

  it.each([
    { owner: false },
    { staff: [self.actingStaffProfileId, 'second_staff'] },
    { staff: [] },
  ])('denies self-approval without exactly one active owner: %j', async (options) => {
    const db = database(options);
    await authenticateCoAuthorizationOperator(db, params);
    await expect(buildAuthenticatedCoAuthorizationRecord(db, self)).rejects.toThrow(
      CoAuthorizationError
    );
  });

  it('rejects expired proof', async () => {
    const db = database();
    await authenticateCoAuthorizationOperator(db, params);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    try {
      await expect(buildAuthenticatedCoAuthorizationRecord(db, self)).rejects.toThrow(
        CoAuthorizationError
      );
    } finally {
      now.mockRestore();
    }
  });
});
