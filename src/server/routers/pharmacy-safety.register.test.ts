import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(),
}));

import { pharmacySafetyRouter } from './pharmacy-safety';
import { router, type TRPCContext } from '../trpc';

const app = router({ pharmacySafety: pharmacySafetyRouter });

function fixture(capability = 'pharmacy:safety', role = 'EMPLOYEE') {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: [{ capability, effect: 'ALLOW' }] },
        permissionOverrides: [],
      }),
      findMany: vi.fn().mockResolvedValue([{ id: 'witness', name: 'Qualified person' }]),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-a' }]),
    },
    pharmacyBranch: {
      findMany: vi.fn().mockResolvedValue([{ id: 'branch-a', name: 'SehatCart Test Branch' }]),
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }),
    },
    pharmacyControlledRegisterEntry: { findMany: vi.fn().mockResolvedValue([]) },
    restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(),
  };
  const ctx = {
    db,
    entitlements: { organizationId: 'org-a', modules: [] },
    session: { user: { id: 'actor', role, status: 'ACTIVE', organizationId: 'org-a' } },
    requestMeta: { ip: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(ctx).pharmacySafety };
}

describe('pharmacy safety register procedures', () => {
  it('does not expose a direct recordControlledEntry mutation', () => {
    expect(Object.keys(pharmacySafetyRouter._def.procedures)).not.toContain(
      'recordControlledEntry'
    );
    expect(Object.keys(pharmacySafetyRouter._def.procedures)).toEqual(
      expect.arrayContaining(['controlledRegister', 'recordCorrection', 'branches', 'access'])
    );
  });

  it('loads active assigned branches within the current tenant in stable order', async () => {
    const { db, caller } = fixture();
    await expect(caller.branches()).resolves.toEqual([
      { id: 'branch-a', name: 'SehatCart Test Branch' },
    ]);
    expect(db.pharmacyBranchAssignment.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', userId: 'actor', active: true },
      select: { branchId: true },
    });
    expect(db.pharmacyBranch.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', active: true, id: { in: ['branch-a'] } },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  });

  it.each(['EMPLOYEE', 'ADMIN'])(
    'does not treat an existing tenant branch as an assignment for %s',
    async (role) => {
      const { db, caller } = fixture('pharmacy:safety', role);
      db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
      await expect(caller.branches()).resolves.toEqual([]);
      expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
      await expect(caller.controlledRegister({ branchId: 'branch-a' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(db.pharmacyControlledRegisterEntry.findMany).not.toHaveBeenCalled();
    }
  );

  it('does not disguise an assignment-load error as an empty list', async () => {
    const { db, caller } = fixture();
    db.pharmacyBranchAssignment.findMany.mockRejectedValue(new Error('Assignment read failed'));
    await expect(caller.branches()).rejects.toThrow('Assignment read failed');
  });

  it('denies users without safety permission before reading assignments or entries', async () => {
    const { db, caller } = fixture('pharmacy.counter');
    await expect(caller.branches()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.controlledRegister({ branchId: 'branch-a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyBranchAssignment.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyControlledRegisterEntry.findMany).not.toHaveBeenCalled();
  });

  it('refuses an unassigned sibling branch before reading entries or correcting', async () => {
    const { db, caller } = fixture();
    await expect(caller.controlledRegister({ branchId: 'branch-b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller.recordCorrection({
        branchId: 'branch-b',
        correctsEntryId: 'entry-1',
        correctionReason: 'Fixture correction',
        quantityCanonicalUnits: 1,
        staffProfileId: 'staff',
        pin: '1234',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyControlledRegisterEntry.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('requires the assigned branch to be active and in the same tenant', async () => {
    const { db, caller } = fixture();
    db.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(caller.controlledRegister({ branchId: 'branch-a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
      where: { id: 'branch-a', organizationId: 'org-a', active: true },
      select: { id: true },
    });
    expect(db.pharmacyControlledRegisterEntry.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty register only after a successful scoped entry read', async () => {
    const { db, caller } = fixture();
    await expect(caller.controlledRegister({ branchId: 'branch-a' })).resolves.toEqual({
      entries: [],
    });
    expect(db.pharmacyControlledRegisterEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', branchId: 'branch-a' },
        orderBy: { serial: 'asc' },
      })
    );
  });

  it('preserves entries, resolves witness names, and masks patient identifiers', async () => {
    const { db, caller } = fixture();
    db.pharmacyControlledRegisterEntry.findMany.mockResolvedValue([
      {
        id: 'entry-1',
        serial: 1,
        witnessedByUserId: 'witness',
        patient: { displayName: 'Fixture patient', cnic: '12345-1234567-1' },
        medicine: { productName: 'Fixture medicine', manufacturer: 'Fixture manufacturer' },
      },
    ]);
    const result = await caller.controlledRegister({ branchId: 'branch-a' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: 'entry-1',
      serial: 1,
      witnessName: 'Qualified person',
      patient: { displayName: 'Fixture patient' },
      medicine: { productName: 'Fixture medicine' },
    });
    expect(result.entries[0].patient?.cnic).not.toBe('12345-1234567-1');
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: { in: ['witness'] } },
      select: { id: true, name: true },
    });
  });
});
