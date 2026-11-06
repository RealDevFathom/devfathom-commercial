import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('@/lib/abac', () => ({ can: mocks.can }));
vi.mock('./lost-demand-operations', () => ({ verifyLostDemandPin: mocks.verify }));

import { enrolPharmacyOperatorPin, PharmacyPinEnrolmentError } from './operator-pin';

type User = { id: string; name: string; status: string; role: string; department: string };
const owner: User = {
  id: 'owner',
  name: 'Owner',
  status: 'ACTIVE',
  role: 'ADMIN',
  department: 'ops',
};
const manager: User = {
  id: 'manager',
  name: 'Manager',
  status: 'ACTIVE',
  role: 'EMPLOYEE',
  department: 'ops',
};
const cashier: User = {
  id: 'cashier',
  name: 'Cashier',
  status: 'ACTIVE',
  role: 'EMPLOYEE',
  department: 'ops',
};

function fakeDb({
  profiles = [] as { id: string; status: string }[],
  existingPin = null as { id: string } | null,
} = {}) {
  const users = new Map([owner, manager, cashier].map((u) => [u.id, u]));
  return {
    $queryRaw: vi.fn(async () => []),
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null),
    },
    restaurantStaffProfile: {
      findMany: vi.fn(async () => profiles),
      create: vi.fn(async () => ({ id: 'staff-new', status: 'ACTIVE' })),
    },
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => existingPin),
      updateMany: vi.fn(async () => ({ count: existingPin ? 1 : 0 })),
      create: vi.fn(async () => ({ id: 'cred-new' })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}
type FakeDb = ReturnType<typeof fakeDb>;
const enrol = (db: FakeDb, actor: User, input: Parameters<typeof enrolPharmacyOperatorPin>[2]) =>
  enrolPharmacyOperatorPin(
    db as never,
    { organizationId: 'org-a', userId: actor.id, role: actor.role },
    input
  );

beforeEach(() => {
  vi.clearAllMocks();
  // Owners and managers hold pharmacy:manage; cashiers do not.
  mocks.can.mockImplementation(async (subject: { id: string }) => subject.id !== 'cashier');
  mocks.verify.mockResolvedValue(true);
});

describe('pharmacy owner/manager PIN enrolment', () => {
  it('creates a staff profile and a hashed PIN for an owner without restaurant credentials', async () => {
    const db = fakeDb();
    await expect(enrol(db, owner, { pin: '1357' })).resolves.toMatchObject({
      ok: true,
      credentialId: 'cred-new',
      staffProfileId: 'staff-new',
      targetUserId: 'owner',
      reset: false,
    });
    expect(db.restaurantStaffProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: 'org-a', userId: 'owner' }),
      })
    );
    const created = db.restaurantOperatorCredential.create.mock.calls[0][0] as {
      data: { credentialHash: string; type: string; deviceId: null };
    };
    expect(created.data).toMatchObject({ type: 'PIN', deviceId: null });
    expect(created.data.credentialHash).not.toBe('1357');
    expect(created.data.credentialHash).not.toContain('1357');
  });

  it('writes an audit row with identifiers only, never the PIN or its hash', async () => {
    const db = fakeDb();
    await enrol(db, owner, { pin: '1357' });
    const created = db.restaurantOperatorCredential.create.mock.calls[0][0] as {
      data: { credentialHash: string };
    };
    const audit = JSON.stringify(db.auditLog.create.mock.calls[0][0]);
    expect(audit).toContain('pharmacyOperatorPin.set');
    expect(audit).toContain('"actorId":"owner"');
    expect(audit).not.toContain('1357');
    expect(audit).not.toContain(created.data.credentialHash);
  });

  it('lets the owner reset a manager PIN, revoking the previous one', async () => {
    const db = fakeDb({
      profiles: [{ id: 'staff-m', status: 'ACTIVE' }],
      existingPin: { id: 'cred-old' },
    });
    await expect(enrol(db, owner, { targetUserId: 'manager', pin: '2468' })).resolves.toMatchObject(
      { ok: true, reset: true, targetUserId: 'manager' }
    );
    expect(db.restaurantOperatorCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ staffProfileId: 'staff-m', revokedAt: null }),
      })
    );
    expect(JSON.stringify(db.auditLog.create.mock.calls[0][0])).toContain(
      'pharmacyOperatorPin.reset'
    );
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('refuses a manager setting another user PIN', async () => {
    const db = fakeDb();
    await expect(enrol(db, manager, { targetUserId: 'owner', pin: '2468' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.restaurantOperatorCredential.create).not.toHaveBeenCalled();
  });

  it('refuses actors and targets without the owner/manager capability', async () => {
    await expect(enrol(fakeDb(), cashier, { pin: '2468' })).rejects.toBeInstanceOf(
      PharmacyPinEnrolmentError
    );
    const db = fakeDb();
    await expect(enrol(db, owner, { targetUserId: 'cashier', pin: '2468' })).rejects.toMatchObject({
      code: 'TARGET_NOT_ELIGIBLE',
    });
    await expect(enrol(db, owner, { targetUserId: 'foreign', pin: '2468' })).rejects.toMatchObject({
      code: 'TARGET_NOT_ELIGIBLE',
    });
    expect(db.restaurantOperatorCredential.create).not.toHaveBeenCalled();
  });

  it('lets a manager set a first PIN but requires the current PIN to change it', async () => {
    await expect(enrol(fakeDb(), manager, { pin: '2468' })).resolves.toMatchObject({ ok: true });
    const db = fakeDb({
      profiles: [{ id: 'staff-m', status: 'ACTIVE' }],
      existingPin: { id: 'cred-old' },
    });
    await expect(enrol(db, manager, { pin: '2468' })).rejects.toMatchObject({
      code: 'CURRENT_PIN_REQUIRED',
    });
    mocks.verify.mockResolvedValueOnce(false);
    await expect(enrol(db, manager, { pin: '2468', currentPin: '0000' })).resolves.toEqual({
      ok: false,
      code: 'CURRENT_PIN_INVALID',
    });
    expect(db.restaurantOperatorCredential.updateMany).not.toHaveBeenCalled();
    expect(db.restaurantOperatorCredential.create).not.toHaveBeenCalled();
    await expect(enrol(db, manager, { pin: '2468', currentPin: '1357' })).resolves.toMatchObject({
      ok: true,
      reset: true,
    });
  });

  it('never reactivates a suspended operator profile', async () => {
    const db = fakeDb({ profiles: [{ id: 'staff-m', status: 'SUSPENDED' }] });
    await expect(enrol(db, manager, { pin: '2468' })).rejects.toMatchObject({
      code: 'PROFILE_INACTIVE',
    });
    expect(db.restaurantStaffProfile.create).not.toHaveBeenCalled();
  });

  it('rejects a PIN that violates the credential policy without persisting it', async () => {
    const db = fakeDb();
    await expect(enrol(db, owner, { pin: '12' })).rejects.toMatchObject({ code: 'INVALID_PIN' });
    expect(db.restaurantOperatorCredential.create).not.toHaveBeenCalled();
  });
});
