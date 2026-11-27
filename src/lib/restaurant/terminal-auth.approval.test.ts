import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/approval-authenticator', { spy: true });
vi.mock('@/lib/restaurant/operator-credentials', { spy: true });

import { authenticateOperator } from './terminal-auth';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import { ApprovalPinChangeRequired } from '@/lib/pharmacy/approval-pin-change-required';
import {
  hashOperatorCredential,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';

/**
 * DEV-879: a restaurant manager's co-authorization (voids, comps, refunds, device and camera
 * changes) is an approval, so an enrolled manager enters their authenticator code instead of
 * a PIN. Operator sign-in (unlock / switch) is not an approval and keeps the PIN.
 */

const now = new Date('2026-11-17T10:00:00.000Z');

function fakeDb({ approvalPinMustChange = false, credentialHash = 'hash' } = {}) {
  return {
    organization: { findFirst: vi.fn().mockResolvedValue({ requireApprovalAuthenticator: false }) },
    auditLog: { create: vi.fn() },
    restaurantStaffProfile: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'staff-manager',
        primaryBranchId: 'branch',
        status: 'ACTIVE',
        userId: 'manager',
      }),
    },
    restaurantBranch: { findUnique: vi.fn() },
    restaurantOperatorCredential: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'cred',
          organizationId: 'org',
          deviceId: null,
          credentialHash,
          approvalPinMustChange,
          failedAttempts: 0,
          lockedUntil: null,
        },
      ]),
      update: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authenticateOperator approvals (DEV-879)', () => {
  it('checks an approving PIN entry through the approval authenticator rule', async () => {
    const db = fakeDb();
    vi.mocked(verifyApprovalSecret).mockResolvedValueOnce('AUTHENTICATOR');
    await expect(
      authenticateOperator(db as never, {
        staffProfileId: 'staff-manager',
        type: 'PIN',
        secret: '123456',
        now,
        approval: {
          action: 'restaurant.terminal.coAuthorize',
          approverRight: 'coauth:approve',
          requestedByStaffProfileId: 'staff-cashier',
        },
      })
    ).resolves.toEqual({ ok: true, credentialId: 'cred', staffProfileId: 'staff-manager' });
    expect(verifyApprovalSecret).toHaveBeenCalledWith(db, {
      organizationId: 'org',
      approverUserId: 'manager',
      credentialHash: 'hash',
      credentialType: 'PIN',
      deviceBound: false,
      approvalPinMustChange: false,
      secret: '123456',
      action: 'restaurant.terminal.coAuthorize',
      approverRight: 'coauth:approve',
      requestedByStaffProfileId: 'staff-cashier',
      now,
    });
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
  });

  it('refuses a matching approval PIN that the member must change', async () => {
    const pin = '579164';
    const db = fakeDb({
      approvalPinMustChange: true,
      credentialHash: await hashOperatorCredential('PIN', pin),
    });

    await expect(
      authenticateOperator(db as never, {
        staffProfileId: 'staff-manager',
        type: 'PIN',
        secret: pin,
        now,
        approval: { action: 'restaurant.terminal.coAuthorize', approverRight: 'coauth:approve' },
      })
    ).rejects.toBeInstanceOf(ApprovalPinChangeRequired);
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
  });

  it('strikes the durable lockout counter when the approval code is refused', async () => {
    const db = fakeDb();
    vi.mocked(verifyApprovalSecret).mockResolvedValueOnce(null);
    await expect(
      authenticateOperator(db as never, {
        staffProfileId: 'staff-manager',
        type: 'PIN',
        secret: '123456',
        now,
        approval: { action: 'restaurant.terminal.orderApproval', approverRight: 'coauth:approve' },
      })
    ).resolves.toEqual({ ok: false, reason: 'INVALID' });
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: expect.objectContaining({ failedAttempts: 1 }),
    });
  });

  it('keeps operator sign-in on the PIN alone', async () => {
    const db = fakeDb();
    vi.mocked(verifyOperatorCredential).mockResolvedValueOnce(true);
    await expect(
      authenticateOperator(db as never, {
        staffProfileId: 'staff-manager',
        type: 'PIN',
        secret: '1234',
        now,
      })
    ).resolves.toMatchObject({ ok: true });
    expect(verifyApprovalSecret).not.toHaveBeenCalled();
  });
});
