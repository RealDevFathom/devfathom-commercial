import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeCounterApproval,
  confirmCounterApproval,
  CounterApprovalDenied,
} from './counter-line-approval';
import { can } from '@/lib/abac';
import { isLockedOut, verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: vi.fn() }));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  verifyOperatorCredential: vi.fn(),
  isLockedOut: vi.fn(() => false),
  clearLockout: () => ({ failedAttempts: 0 }),
  registerFailedAttempt: () => ({ failedAttempts: 1 }),
}));

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'cashier' };
const pin = { staffProfileId: 'staff-manager', pin: '1234' };
const actor = { id: 'cashier', organizationId: 'org', status: 'ACTIVE', role: 'EMPLOYEE' };
const manager = { id: 'manager', organizationId: 'org', status: 'ACTIVE', role: 'EMPLOYEE' };

/** `holders` hold the checked capability; `others` are the other members with a live PIN. */
function fixture(approver = manager, holders: string[] = ['manager'], others = [manager]) {
  vi.mocked(can).mockImplementation(async (subject) => holders.includes(subject.id));
  vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
  const db = {
    $queryRaw: vi.fn(),
    user: {
      findFirst: vi.fn().mockResolvedValue(actor),
    },
    restaurantOperatorCredential: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'cred',
        credentialHash: 'hash',
        staffProfile: { status: 'ACTIVE', user: approver },
      }),
      findMany: vi.fn().mockResolvedValue(
        others.map((user, index) => ({
          id: `cred-${index}`,
          staffProfile: { status: 'ACTIVE', user },
        }))
      ),
      update: vi.fn(),
    },
  };
  vi.mocked(withTenantDb).mockImplementation(async (_organizationId, run) => run(db as never));
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isLockedOut).mockReturnValue(false);
});

describe('counter discount approval (#520)', () => {
  it('refuses a discount with no PIN approval before reading any credential', async () => {
    const db = fixture();
    await expect(authorizeCounterApproval(db as never, scope, 'DISCOUNT')).rejects.toBeInstanceOf(
      CounterApprovalDenied
    );
    expect(db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });

  it('records the PIN-verified manager, not anything the caller named', async () => {
    const db = fixture();
    await expect(authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)).resolves.toEqual({
      approvedByUserId: 'manager',
      approvalPolicy: 'MANAGER_PIN',
      selfApproved: false,
    });
    expect(can).toHaveBeenCalledWith(manager, 'pharmacy:manage', undefined, expect.anything());
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: { failedAttempts: 0 },
    });
  });

  it('refuses an approver who does not hold the discount capability', async () => {
    const db = fixture(manager, []);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['inactive', { ...manager, status: 'SUSPENDED' }],
    ['in another organization', { ...manager, organizationId: 'other-org' }],
  ])('refuses an approver who is %s', async (_label, approver) => {
    const db = fixture(approver);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
  });

  it('refuses an unknown credential', async () => {
    const db = fixture();
    db.restaurantOperatorCredential.findFirst.mockResolvedValue(null);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
  });

  it('commits a failed attempt for a wrong PIN and refuses', async () => {
    const db = fixture();
    vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: { failedAttempts: 1 },
    });
    // The check runs in its own tenant transaction so the lockout counter survives the refusal.
    expect(withTenantDb).toHaveBeenCalledWith('org', expect.any(Function), {
      userId: 'cashier',
      skipDrain: true,
    });
  });

  it('refuses a locked-out credential without checking the PIN', async () => {
    const db = fixture();
    vi.mocked(isLockedOut).mockReturnValue(true);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
  });

  it('refuses self-approval while another member can approve', async () => {
    const self = { ...actor };
    const db = fixture(self, ['cashier', 'manager'], [manager]);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
  });

  it('lets the sole approver self-approve with a fresh PIN, recorded as self-approved', async () => {
    const self = { ...actor };
    const db = fixture(self, ['cashier'], [{ ...actor, id: 'other-cashier' }]);
    await expect(authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)).resolves.toEqual({
      approvedByUserId: 'cashier',
      approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
      selfApproved: true,
    });
    expect(verifyOperatorCredential).toHaveBeenCalledWith('PIN', '1234', 'hash');
  });

  it('only counts other members with an active staff profile and a live PIN', async () => {
    const self = { ...actor };
    const db = fixture(self, ['cashier'], []);
    await authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin);
    expect(db.restaurantOperatorCredential.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org',
        type: 'PIN',
        revokedAt: null,
        deviceId: null,
        staffProfile: {
          status: 'ACTIVE',
          user: { organizationId: 'org', status: 'ACTIVE', id: { not: 'cashier' } },
        },
      },
      include: { staffProfile: { include: { user: true } } },
    });
  });

  it('checks each other member once, even with several PIN credentials', async () => {
    const self = { ...actor };
    const other = { ...actor, id: 'other-cashier' };
    const db = fixture(self, ['cashier'], [other, other, other]);
    await authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin);
    expect(
      vi.mocked(can).mock.calls.filter(([subject]) => subject.id === 'other-cashier')
    ).toHaveLength(1);
  });

  it('refuses a sole approver whose fresh PIN is wrong', async () => {
    const self = { ...actor };
    const db = fixture(self, ['cashier'], []);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
  });
});

describe('counter FEFO-override approval (#520)', () => {
  it('lets the pharmacist on duty approve their own override without a PIN', async () => {
    const db = fixture(manager, ['cashier']);
    await expect(authorizeCounterApproval(db as never, scope, 'FEFO_OVERRIDE')).resolves.toEqual({
      approvedByUserId: 'cashier',
      approvalPolicy: 'PHARMACIST_ON_DUTY',
      selfApproved: false,
    });
    expect(can).toHaveBeenCalledWith(actor, 'pharmacy:dispense', undefined, expect.anything());
    expect(db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a non-pharmacist override without a pharmacist PIN', async () => {
    const db = fixture(manager, []);
    await expect(
      authorizeCounterApproval(db as never, scope, 'FEFO_OVERRIDE')
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
  });

  it('accepts a pharmacist PIN for a non-pharmacist override', async () => {
    const pharmacist = { ...manager, id: 'pharmacist' };
    const db = fixture(pharmacist, ['pharmacist']);
    await expect(
      authorizeCounterApproval(db as never, scope, 'FEFO_OVERRIDE', pin)
    ).resolves.toEqual({
      approvedByUserId: 'pharmacist',
      approvalPolicy: 'PHARMACIST_PIN',
      selfApproved: false,
    });
  });

  it('refuses an inactive actor outright', async () => {
    const db = fixture();
    db.user.findFirst.mockResolvedValue(null);
    await expect(
      authorizeCounterApproval(db as never, scope, 'FEFO_OVERRIDE', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(withTenantDb).not.toHaveBeenCalled();
  });
});

describe('in-transaction approval re-check (#520)', () => {
  const approval = {
    approvedByUserId: 'manager',
    approvalPolicy: 'MANAGER_PIN',
    selfApproved: false,
  };

  it('accepts an approver who is still active and still holds the capability', async () => {
    const db = fixture();
    db.user.findFirst.mockResolvedValue(manager);
    await expect(
      confirmCounterApproval(db as never, scope, 'DISCOUNT', approval)
    ).resolves.toBeUndefined();
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'manager', organizationId: 'org', status: 'ACTIVE' },
    });
    expect(can).toHaveBeenCalledWith(manager, 'pharmacy:manage', undefined, expect.anything());
  });

  it('refuses an approver deactivated since the PIN check', async () => {
    const db = fixture();
    db.user.findFirst.mockResolvedValue(null);
    await expect(
      confirmCounterApproval(db as never, scope, 'DISCOUNT', approval)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
  });

  it('refuses an approver whose capability was revoked since the PIN check', async () => {
    const db = fixture(manager, []);
    db.user.findFirst.mockResolvedValue(manager);
    await expect(
      confirmCounterApproval(db as never, scope, 'FEFO_OVERRIDE', approval)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
  });
});
