import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeCounterApproval,
  confirmCounterApproval,
  CounterApprovalDenied,
  isSoleActiveApprover,
  listCounterApprovers,
  mayApproveCounterLine,
} from './counter-line-approval';
import { can } from '@/lib/abac';
import { isLockedOut, verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

// DEV-879: these fixtures model an approver with no approval authenticator, so the PIN is
// checked exactly as before. approval-authenticator.test.ts covers the authenticator path.
vi.mock('@/lib/approval-authenticator', async () => {
  const { verifyOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  return {
    verifyApprovalSecret: async (
      _db: unknown,
      input: { secret: string; credentialHash: string }
    ) =>
      (await verifyOperatorCredential('PIN', input.secret, input.credentialHash)) ? 'PIN' : null,
  };
});
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: vi.fn() }));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'dummy-hash') }));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  OPERATOR_CREDENTIAL_BCRYPT_COST: 12,
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
  vi.mocked(verifyOperatorCredential).mockImplementation(
    async (_type, _pin, credentialHash) => credentialHash === 'hash'
  );
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

/** Refused without touching the real credential: only a dummy compare, no counter write. */
function expectDummyCompareOnly(db: ReturnType<typeof fixture>) {
  expect(verifyOperatorCredential).toHaveBeenCalledOnce();
  expect(verifyOperatorCredential).toHaveBeenCalledWith('PIN', '1234', 'dummy-hash');
  expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
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
      credentialId: 'cred',
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
    expectDummyCompareOnly(db);
  });

  it.each([
    ['inactive', { ...manager, status: 'SUSPENDED' }],
    ['in another organization', { ...manager, organizationId: 'other-org' }],
  ])('refuses an approver who is %s', async (_label, approver) => {
    const db = fixture(approver);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expectDummyCompareOnly(db);
  });

  it('refuses an unknown credential after the same bcrypt work as a wrong PIN', async () => {
    const db = fixture();
    db.restaurantOperatorCredential.findFirst.mockResolvedValue(null);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expectDummyCompareOnly(db);
  });

  it('commits a failed attempt for a wrong PIN and refuses', async () => {
    const db = fixture();
    vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(verifyOperatorCredential).toHaveBeenCalledWith('PIN', '1234', 'hash');
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
    expectDummyCompareOnly(db);
  });

  it('refuses self-approval while another member can approve', async () => {
    const self = { ...actor };
    const db = fixture(self, ['cashier', 'manager'], [manager]);
    await expect(
      authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expectDummyCompareOnly(db);
  });

  it('lets the sole approver self-approve with a fresh PIN, recorded as self-approved', async () => {
    const self = { ...actor };
    const db = fixture(self, ['cashier'], [{ ...actor, id: 'other-cashier' }]);
    await expect(authorizeCounterApproval(db as never, scope, 'DISCOUNT', pin)).resolves.toEqual({
      approvedByUserId: 'cashier',
      approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
      selfApproved: true,
      credentialId: 'cred',
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

describe('counter scanned-pack FEFO approval (DEV-843)', () => {
  it('has no on-duty default: even an approver needs their PIN', async () => {
    const db = fixture(manager, ['cashier']);
    await expect(
      authorizeCounterApproval(db as never, scope, 'SCANNED_PACK_FEFO')
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });

  it('accepts a manager PIN checked against the manager capability', async () => {
    const db = fixture();
    await expect(
      authorizeCounterApproval(db as never, scope, 'SCANNED_PACK_FEFO', pin)
    ).resolves.toEqual({
      approvedByUserId: 'manager',
      approvalPolicy: 'MANAGER_PIN',
      selfApproved: false,
      credentialId: 'cred',
    });
    expect(can).toHaveBeenCalledWith(manager, 'pharmacy:manage', undefined, expect.anything());
    expect(can).not.toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:dispense',
      undefined,
      expect.anything()
    );
  });

  it('refuses a pharmacist PIN from someone who is not a manager or owner', async () => {
    const pharmacist = { ...manager, id: 'pharmacist' };
    const db = fixture(pharmacist, []);
    await expect(
      authorizeCounterApproval(db as never, scope, 'SCANNED_PACK_FEFO', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expectDummyCompareOnly(db);
  });

  it('counts a wrong manager PIN toward lockout and refuses', async () => {
    const db = fixture();
    vi.mocked(verifyOperatorCredential).mockResolvedValue(false);
    await expect(
      authorizeCounterApproval(db as never, scope, 'SCANNED_PACK_FEFO', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred' },
      data: { failedAttempts: 1 },
    });
    // Committed in its own tenant transaction, so the strike survives the refused sale. This is
    // shown here with mocks only, like the discount case above; the router resolves the approval
    // before the sale transaction opens.
    expect(withTenantDb).toHaveBeenCalledWith('org', expect.any(Function), {
      userId: 'cashier',
      skipDrain: true,
    });
  });

  it('refuses a pharmacist on duty who self-approves while a manager can approve', async () => {
    const self = { ...actor };
    const db = fixture(self, ['cashier', 'manager'], [manager]);
    await expect(
      authorizeCounterApproval(db as never, scope, 'SCANNED_PACK_FEFO', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expectDummyCompareOnly(db);
  });

  it('lets a solo owner self-approve with a fresh PIN, recorded as self-approved', async () => {
    const self = { ...actor };
    const db = fixture(self, ['cashier'], []);
    await expect(
      authorizeCounterApproval(db as never, scope, 'SCANNED_PACK_FEFO', pin)
    ).resolves.toEqual({
      approvedByUserId: 'cashier',
      approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
      selfApproved: true,
      credentialId: 'cred',
    });
  });
});

describe('counter FEFO-override approval (#520)', () => {
  it('lets the pharmacist on duty approve their own override without a PIN', async () => {
    const db = fixture(manager, ['cashier']);
    await expect(authorizeCounterApproval(db as never, scope, 'FEFO_OVERRIDE')).resolves.toEqual({
      approvedByUserId: 'cashier',
      approvalPolicy: 'PHARMACIST_ON_DUTY',
      selfApproved: false,
      credentialId: null,
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
      credentialId: 'cred',
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
    credentialId: 'cred',
  };

  it('refuses a PIN credential revoked since the PIN check', async () => {
    const db = fixture();
    db.user.findFirst.mockResolvedValue(manager);
    db.restaurantOperatorCredential.findFirst.mockResolvedValue(null);
    await expect(
      confirmCounterApproval(db as never, scope, 'DISCOUNT', approval)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expect(db.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'cred',
        organizationId: 'org',
        type: 'PIN',
        revokedAt: null,
        deviceId: null,
        staffProfile: { status: 'ACTIVE', userId: 'manager' },
      },
      select: { id: true },
    });
  });

  it('does not look for a credential for the pharmacist on duty', async () => {
    const db = fixture(manager, ['cashier']);
    await expect(
      confirmCounterApproval(db as never, scope, 'FEFO_OVERRIDE', {
        approvedByUserId: 'cashier',
        approvalPolicy: 'PHARMACIST_ON_DUTY',
        selfApproved: false,
        credentialId: null,
      })
    ).resolves.toBeUndefined();
    expect(db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });

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

describe('DEV-290: Khata over-limit approval at the till', () => {
  it('needs a manager or owner (pharmacy:manage) PIN and records it as a manager approval', async () => {
    const db = fixture();
    await expect(
      authorizeCounterApproval(db as never, scope, 'KHATA_OVER_LIMIT', pin)
    ).resolves.toEqual({
      approvedByUserId: 'manager',
      approvalPolicy: 'MANAGER_PIN',
      selfApproved: false,
      credentialId: 'cred',
    });
    expect(can).toHaveBeenCalledWith(manager, 'pharmacy:manage', undefined, expect.anything());
  });

  it('refuses without a PIN, and refuses a PIN holder without pharmacy:manage', async () => {
    const db = fixture(manager, []);
    await expect(authorizeCounterApproval(db as never, scope, 'KHATA_OVER_LIMIT')).rejects.toThrow(
      'Charging over the Khata credit limit needs a manager or owner to approve it with their PIN.'
    );
    await expect(
      authorizeCounterApproval(db as never, scope, 'KHATA_OVER_LIMIT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expectDummyCompareOnly(db);
  });

  it('refuses self-approval while another manager could approve', async () => {
    const db = fixture({ ...actor }, ['cashier', 'manager'], [manager]);
    await expect(
      authorizeCounterApproval(db as never, scope, 'KHATA_OVER_LIMIT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expectDummyCompareOnly(db);
  });

  it('lets a solo owner self-approve with a fresh PIN', async () => {
    const db = fixture({ ...actor }, ['cashier'], []);
    await expect(
      authorizeCounterApproval(db as never, scope, 'KHATA_OVER_LIMIT', pin)
    ).resolves.toMatchObject({
      approvedByUserId: 'cashier',
      approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
      selfApproved: true,
    });
  });
});

describe('DEV-290: listCounterApprovers', () => {
  const owner = { id: 'owner', organizationId: 'org', status: 'ACTIVE', role: 'EMPLOYEE' };
  function listDb(profiles: Array<{ id: string; displayName: string; user: unknown }>) {
    return { restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue(profiles) } };
  }

  it('offers other active managers and owners with a live PIN, never the actor', async () => {
    vi.mocked(can).mockImplementation(async (subject) =>
      ['manager', 'owner', 'cashier'].includes(subject.id)
    );
    const db = listDb([
      { id: 'staff-manager', displayName: 'Manager Sana', user: manager },
      { id: 'staff-self', displayName: 'Cashier Bilal', user: actor },
      { id: 'staff-owner', displayName: 'Owner Ali', user: owner },
      { id: 'staff-other-org', displayName: 'Elsewhere', user: { ...owner, organizationId: 'x' } },
      { id: 'staff-inactive', displayName: 'Gone', user: { ...owner, status: 'SUSPENDED' } },
      { id: 'staff-orphan', displayName: 'No user', user: null },
    ]);
    await expect(listCounterApprovers(db as never, scope, 'KHATA_OVER_LIMIT')).resolves.toEqual([
      { id: 'staff-manager', name: 'Manager Sana', self: false },
      { id: 'staff-owner', name: 'Owner Ali', self: false },
    ]);
    expect(db.restaurantStaffProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org',
          status: 'ACTIVE',
          user: { organizationId: 'org', status: 'ACTIVE' },
          credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
        },
      })
    );
    expect(can).toHaveBeenCalledWith(manager, 'pharmacy:manage', undefined, expect.anything());
  });

  it('excludes members without pharmacy:manage', async () => {
    vi.mocked(can).mockImplementation(async (subject) => subject.id === 'owner');
    const db = listDb([
      { id: 'staff-manager', displayName: 'Manager Sana', user: manager },
      { id: 'staff-owner', displayName: 'Owner Ali', user: owner },
    ]);
    await expect(listCounterApprovers(db as never, scope, 'KHATA_OVER_LIMIT')).resolves.toEqual([
      { id: 'staff-owner', name: 'Owner Ali', self: false },
    ]);
  });

  it('offers the actor their own profile only when nobody else can approve (solo rule)', async () => {
    vi.mocked(can).mockImplementation(async (subject) => subject.id === 'cashier');
    const db = listDb([
      { id: 'staff-self', displayName: 'Owner Bilal', user: actor },
      { id: 'staff-manager', displayName: 'Manager Sana', user: manager },
    ]);
    await expect(listCounterApprovers(db as never, scope, 'KHATA_OVER_LIMIT')).resolves.toEqual([
      { id: 'staff-self', name: 'Owner Bilal', self: true },
    ]);
  });
});

describe('DEV-290: isSoleActiveApprover', () => {
  function usersDb(users: unknown[]) {
    return { user: { findMany: vi.fn().mockResolvedValue(users) } };
  }

  it('is false while another active member holds pharmacy:manage, even without a PIN', async () => {
    vi.mocked(can).mockImplementation(async (subject) => subject.id === 'manager');
    const db = usersDb([manager]);
    await expect(isSoleActiveApprover(db as never, scope, 'KHATA_OVER_LIMIT')).resolves.toBe(false);
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org', status: 'ACTIVE', id: { not: 'cashier' } },
    });
    expect(can).toHaveBeenCalledWith(manager, 'pharmacy:manage', undefined, expect.anything());
  });

  it('is true when no other active member holds pharmacy:manage', async () => {
    vi.mocked(can).mockResolvedValue(false);
    const db = usersDb([{ ...actor, id: 'other-cashier' }]);
    await expect(isSoleActiveApprover(db as never, scope, 'KHATA_OVER_LIMIT')).resolves.toBe(true);
  });

  it('ignores the actor and members of another organization', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const db = usersDb([actor, { ...manager, organizationId: 'elsewhere' }]);
    await expect(isSoleActiveApprover(db as never, scope, 'KHATA_OVER_LIMIT')).resolves.toBe(true);
  });
});

describe('DEV-806: one shared approver check for the PIN and password routes', () => {
  const tenantAdmin = { id: 'admin', organizationId: 'org', status: 'ACTIVE', role: 'ADMIN' };
  /**
   * `can` decides per action. A tenant ADMIN always holds `admin:access`; `pharmacy:manage`
   * goes to `manager` unless a test says otherwise (an explicit DENY is modelled as false).
   */
  function grants(manage: string[] = ['manager']) {
    const table: Record<string, string[]> = {
      'admin:access': ['admin'],
      'pharmacy:manage': manage,
    };
    vi.mocked(can).mockImplementation(async (subject, action) =>
      (table[action] ?? []).includes(subject.id)
    );
  }

  it('accepts only a live grant of the capability, never the ADMIN role alone', async () => {
    grants();
    await expect(mayApproveCounterLine({} as never, manager, 'KHATA_OVER_LIMIT')).resolves.toBe(
      true
    );
    for (const kind of ['DISCOUNT', 'FEFO_OVERRIDE', 'KHATA_OVER_LIMIT'] as const)
      await expect(mayApproveCounterLine({} as never, tenantAdmin, kind)).resolves.toBe(false);
    expect(can).not.toHaveBeenCalledWith(
      expect.anything(),
      'admin:access',
      undefined,
      expect.anything()
    );
  });

  it('passes the clock and request source to the decision', async () => {
    grants();
    const now = new Date('2026-11-15T09:00:00Z');
    await mayApproveCounterLine({} as never, manager, 'KHATA_OVER_LIMIT', { now, source: 'TRPC' });
    expect(can).toHaveBeenCalledWith(
      manager,
      'pharmacy:manage',
      undefined,
      expect.objectContaining({ now, source: 'TRPC' })
    );
  });

  it("refuses a tenant ADMIN's PIN without pharmacy:manage, as the password route does", async () => {
    const db = fixture(tenantAdmin);
    grants();
    await expect(
      authorizeCounterApproval(db as never, scope, 'KHATA_OVER_LIMIT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expectDummyCompareOnly(db);
  });

  it("refuses a tenant ADMIN's PIN when pharmacy:manage is explicitly denied", async () => {
    const db = fixture(tenantAdmin);
    // The ADMIN's role grants pharmacy:manage, but an explicit DENY makes the decision false.
    vi.mocked(can).mockImplementation(async (subject, action) =>
      action === 'admin:access' ? subject.id === 'admin' : subject.id === 'manager'
    );
    await expect(
      authorizeCounterApproval(db as never, scope, 'KHATA_OVER_LIMIT', pin)
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
    expectDummyCompareOnly(db);
  });

  it('accepts a manager PIN and re-checks it with the same rule inside the sale', async () => {
    const db = fixture(manager);
    grants();
    const approval = await authorizeCounterApproval(db as never, scope, 'KHATA_OVER_LIMIT', pin);
    expect(approval).toEqual({
      approvedByUserId: 'manager',
      approvalPolicy: 'MANAGER_PIN',
      selfApproved: false,
      credentialId: 'cred',
    });
    const saleDb = {
      user: { findFirst: vi.fn().mockResolvedValue(manager) },
      restaurantOperatorCredential: { findFirst: vi.fn().mockResolvedValue({ id: 'cred' }) },
    };
    await expect(
      confirmCounterApproval(saleDb as never, scope, 'KHATA_OVER_LIMIT', approval)
    ).resolves.toBeUndefined();
    saleDb.user.findFirst.mockResolvedValue(tenantAdmin);
    await expect(
      confirmCounterApproval(saleDb as never, scope, 'KHATA_OVER_LIMIT', {
        ...approval,
        approvedByUserId: 'admin',
      })
    ).rejects.toBeInstanceOf(CounterApprovalDenied);
  });

  it('lets a solo owner self-approve with a fresh PIN, recorded as self-approved', async () => {
    // A tenant ADMIN with no pharmacy:manage grant is not another approver.
    const db = fixture({ ...actor }, [], [tenantAdmin]);
    grants(['cashier']);
    await expect(
      authorizeCounterApproval(db as never, scope, 'KHATA_OVER_LIMIT', pin)
    ).resolves.toEqual({
      approvedByUserId: 'cashier',
      approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
      selfApproved: true,
      credentialId: 'cred',
    });
  });

  it('applies the same rule to the password route sole-approver check', async () => {
    grants(['cashier']);
    const adminOnly = { user: { findMany: vi.fn().mockResolvedValue([tenantAdmin]) } };
    await expect(isSoleActiveApprover(adminOnly as never, scope, 'KHATA_OVER_LIMIT')).resolves.toBe(
      true
    );
    grants(['cashier', 'manager']);
    const withManager = { user: { findMany: vi.fn().mockResolvedValue([tenantAdmin, manager]) } };
    await expect(
      isSoleActiveApprover(withManager as never, scope, 'KHATA_OVER_LIMIT')
    ).resolves.toBe(false);
  });

  it('never offers a tenant ADMIN without pharmacy:manage as an approver at the till', async () => {
    grants();
    const db = {
      restaurantStaffProfile: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'staff-admin', displayName: 'Owner Ayesha', user: tenantAdmin },
          { id: 'staff-manager', displayName: 'Manager Sana', user: manager },
        ]),
      },
    };
    await expect(listCounterApprovers(db as never, scope, 'KHATA_OVER_LIMIT')).resolves.toEqual([
      { id: 'staff-manager', name: 'Manager Sana', self: false },
    ]);
  });
});
