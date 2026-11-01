import { beforeEach, describe, expect, it, vi } from 'vitest';

const can = vi.hoisted(() => vi.fn());
vi.mock('@/lib/abac', () => ({
  can,
  subjectFromSession: (user: { id: string; role?: string | null }) => ({
    id: user.id,
    role: user.role ?? 'EMPLOYEE',
    department: null,
    status: null,
  }),
}));

import { pharmacyStaffCapabilities, readPharmacyStaffAccess } from './staff-access';

const db = {} as never;

// Each persona's session role and the capabilities its pharmacy role template grants.
const personas = {
  owner: [
    'ADMIN',
    ['reports:operational', 'reports:financial', 'pharmacy:close', 'pharmacy:inventory'],
  ],
  admin: ['ADMIN', []],
  manager: ['EMPLOYEE', ['pharmacy:manage', 'pharmacy:orders', 'pharmacy:procurement']],
  cashier: ['EMPLOYEE', ['pharmacy:counter', 'pharmacy:orders']],
} as const;

function grant(capabilities: readonly string[]) {
  can.mockImplementation(async (_subject: unknown, action: string) =>
    capabilities.includes(action)
  );
}

beforeEach(() => {
  can.mockReset();
});

describe('readPharmacyStaffAccess', () => {
  it('opens everything to an owner', async () => {
    const [role, grants] = personas.owner;
    grant(grants);
    await expect(readPharmacyStaffAccess({ id: 'owner', role }, db)).resolves.toEqual({
      commandCentre: true,
      dayClose: true,
      reports: true,
      inventoryControl: true,
      inventoryImport: true,
      dispense: false,
      prescriptions: false,
    });
  });

  it('gives an admin the command centre, day close and import', async () => {
    const [role, grants] = personas.admin;
    grant(grants);
    await expect(readPharmacyStaffAccess({ id: 'admin', role }, db)).resolves.toMatchObject({
      commandCentre: true,
      dayClose: true,
      inventoryImport: true,
    });
  });

  it('gives a manager the command centre without import', async () => {
    const [role, grants] = personas.manager;
    grant(grants);
    await expect(readPharmacyStaffAccess({ id: 'manager', role }, db)).resolves.toMatchObject({
      commandCentre: true,
      inventoryImport: false,
    });
  });

  it('keeps a cashier to the counter: no command centre, day close, reports or inventory admin', async () => {
    const [role, grants] = personas.cashier;
    grant(grants);
    const access = await readPharmacyStaffAccess({ id: 'cashier', role }, db);
    expect(access).toEqual({
      commandCentre: false,
      dayClose: false,
      reports: false,
      inventoryControl: false,
      inventoryImport: false,
      dispense: false,
      prescriptions: false,
    });
    expect(pharmacyStaffCapabilities(access)).toEqual([]);
  });

  it('reports dispensing and prescription access for a pharmacist', async () => {
    grant([
      'pharmacy:dispense',
      'pharmacy:prescriptions',
      'pharmacy:catalogue-review',
      'pharmacy:close',
    ]);
    const access = await readPharmacyStaffAccess({ id: 'pharmacist', role: 'EMPLOYEE' }, db);
    expect(access).toMatchObject({ dispense: true, prescriptions: true, dayClose: true });
    expect(pharmacyStaffCapabilities(access)).toEqual(
      expect.arrayContaining(['pharmacy:dispense', 'pharmacy:prescriptions'])
    );
  });

  it('denies everything without a signed-in user', async () => {
    const access = await readPharmacyStaffAccess(null, db);
    expect(Object.values(access).some(Boolean)).toBe(false);
    expect(can).not.toHaveBeenCalled();
  });
});
