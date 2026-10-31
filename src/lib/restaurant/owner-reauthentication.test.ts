import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { buildCoAuthorizationRecord } from './co-authorization';
import {
  recordOwnerPinReauthentication,
  withOwnerReauthenticationScope,
} from './owner-reauthentication';

const permissions = vi.hoisted(() => ({ canApprove: vi.fn(async () => true) }));
vi.mock('./checkout-routes', () => ({ operatorHasCapability: permissions.canApprove }));
beforeEach(() => permissions.canApprove.mockResolvedValue(true));

const request = {
  actingStaffProfileId: 'owner',
  approvingStaffProfileId: 'owner',
  capability: 'orders:void',
  reason: 'Duplicate',
  deviceId: 'device',
};
const scope = { actingStaffProfileId: 'owner', deviceId: 'device', terminalSessionId: 'session' };
const owner = { id: 'owner', user: { organizationRole: { key: 'owner' } }, jobRoles: [] };
const database = (staff: unknown[]) =>
  ({ restaurantStaffProfile: { findMany: vi.fn(async () => staff) } }) as unknown as ScopedDb;

describe('solo-owner PIN reauthentication', () => {
  it('records the same actor and approver with explicit evidence after fresh PIN verification', async () => {
    await withOwnerReauthenticationScope(scope, async () => {
      await recordOwnerPinReauthentication(database([owner]), 'owner', 'branch');
      expect(buildCoAuthorizationRecord(request)).toMatchObject({
        actingStaffProfileId: 'owner',
        approvingStaffProfileId: 'owner',
        reason: 'Duplicate [Owner PIN reauthentication]',
        terminalSessionId: 'session',
      });
    });
    expect(() => buildCoAuthorizationRecord(request)).toThrow(/second identity/);
  });
  it.each([
    { rows: [] },
    { rows: [owner, { id: 'colleague', user: null, jobRoles: [] }] },
    { rows: [{ ...owner, user: { organizationRole: { key: 'cashier' } } }] },
  ])('refuses absent, multi-person and non-owner workspaces', async ({ rows }) => {
    await withOwnerReauthenticationScope(scope, async () => {
      await recordOwnerPinReauthentication(database(rows), 'owner', 'branch');
      expect(() => buildCoAuthorizationRecord(request)).toThrow(/second identity/);
    });
  });
  it('honors an explicit denial of approval permission even for the sole owner', async () => {
    permissions.canApprove.mockResolvedValue(false);
    await withOwnerReauthenticationScope(scope, async () => {
      await recordOwnerPinReauthentication(database([owner]), 'owner', 'branch');
      expect(() => buildCoAuthorizationRecord(request)).toThrow(/second identity/);
    });
  });

  it('refuses an unverified PIN and a mismatched device or identity', async () => {
    await withOwnerReauthenticationScope(scope, async () => {
      expect(() => buildCoAuthorizationRecord(request)).toThrow(/second identity/);
      await recordOwnerPinReauthentication(database([owner]), 'other', 'branch');
      expect(() => buildCoAuthorizationRecord(request)).toThrow(/second identity/);
      await recordOwnerPinReauthentication(database([owner]), 'owner', 'branch');
      expect(() => buildCoAuthorizationRecord({ ...request, deviceId: 'other' })).toThrow(
        /second identity/
      );
    });
  });
});
