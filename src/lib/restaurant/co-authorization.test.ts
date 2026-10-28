import { describe, expect, it } from 'vitest';

import {
  CoAuthorizationError,
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

it('does not extend the solo SOP waiver exception to terminal or sibling actions', () => {
  expect(() =>
    buildCoAuthorizationRecord({ ...terminalRequest, approvingStaffProfileId: 'staff_actor' })
  ).toThrow(CoAuthorizationError);
  expect(() =>
    buildCoAuthorizationRecord({
      ...terminalRequest,
      approvingStaffProfileId: 'staff_actor',
      capability: 'sop:verify',
      targetType: 'RestaurantSopOccurrence',
    })
  ).toThrow(CoAuthorizationError);
});
