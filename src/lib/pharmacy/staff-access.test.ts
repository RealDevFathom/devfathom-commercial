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

import {
  NO_PHARMACY_STAFF_ACCESS,
  pharmacyHomePath,
  pharmacyStaffCapabilities,
  readPharmacyStaffAccess,
} from './staff-access';

const db = {} as never;

// Each persona's session role and the capabilities its pharmacy role template grants.
const personas = {
  owner: [
    'ADMIN',
    [
      'reports:operational',
      'reports:financial',
      'pharmacy:close',
      'pharmacy:inventory',
      'pharmacy:procurement',
    ],
  ],
  admin: ['ADMIN', []],
  manager: [
    'EMPLOYEE',
    [
      'pharmacy:manage',
      'pharmacy:orders',
      'pharmacy:procurement',
      'pharmacy:close',
      'reports:operational',
    ],
  ],
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
      purchasing: true,
      administration: true,
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

  it('gives a manager the command centre, day close, reports, purchasing and team without import', async () => {
    const [role, grants] = personas.manager;
    grant(grants);
    await expect(readPharmacyStaffAccess({ id: 'manager', role }, db)).resolves.toMatchObject({
      commandCentre: true,
      dayClose: true,
      reports: true,
      purchasing: true,
      administration: true,
      inventoryImport: false,
    });
  });

  it('reads purchasing from the procurement grant', async () => {
    grant(['pharmacy:procurement']);
    const access = await readPharmacyStaffAccess({ id: 'buyer', role: 'EMPLOYEE' }, db);
    expect(access).toMatchObject({ purchasing: true, administration: false, dayClose: false });
    expect(can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'buyer' }),
      'pharmacy:procurement',
      undefined,
      expect.objectContaining({ db })
    );
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
      purchasing: false,
      administration: false,
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
    expect(access).toMatchObject({
      dispense: true,
      prescriptions: true,
      dayClose: true,
      commandCentre: false,
      reports: false,
      purchasing: false,
      administration: false,
    });
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

describe('pharmacyHomePath', () => {
  const modules = ['pharmacy-counter', 'pharmacy-dispensing'];

  it('keeps the command centre audience on the dashboard', () => {
    expect(pharmacyHomePath({ ...NO_PHARMACY_STAFF_ACCESS, commandCentre: true }, modules)).toBe(
      null
    );
    expect(
      pharmacyHomePath(
        { ...NO_PHARMACY_STAFF_ACCESS, commandCentre: true, dispense: true },
        modules
      )
    ).toBe(null);
  });

  it('lands a pharmacist on the Pharmacist queue', () => {
    expect(
      pharmacyHomePath(
        { ...NO_PHARMACY_STAFF_ACCESS, dispense: true, prescriptions: true, dayClose: true },
        modules
      )
    ).toBe('/pharmacy/pharmacist-queue');
  });

  it('lands a cashier on the Counter', () => {
    expect(pharmacyHomePath(NO_PHARMACY_STAFF_ACCESS, modules)).toBe('/pharmacy/counter');
  });

  it('falls back to the Counter when dispensing is not licensed', () => {
    expect(
      pharmacyHomePath({ ...NO_PHARMACY_STAFF_ACCESS, dispense: true }, ['pharmacy-counter'])
    ).toBe('/pharmacy/counter');
  });

  it('sends nobody to an unlicensed surface', () => {
    expect(pharmacyHomePath({ ...NO_PHARMACY_STAFF_ACCESS, dispense: true }, [])).toBe(null);
    expect(pharmacyHomePath(NO_PHARMACY_STAFF_ACCESS, null)).toBe(null);
  });
});
