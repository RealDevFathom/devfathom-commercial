import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: vi.fn(),
}));

import { addSaleLine } from '@/lib/pharmacy/sales';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

const line = {
  branchId: 'branch-1',
  saleId: 'sale-1',
  medicineId: 'medicine-1',
  presentationId: 'presentation-1',
  packLevelId: 'pack-1',
  saleUnit: 'UNIT' as const,
  quantity: 2,
  canonicalUnitsPerSaleUnit: 1,
  idempotencyKey: 'counter:sale-1:controlled',
  controlledAuthorization: {
    patientId: 'patient-1',
    patientAddress: '12 Mall Road, Gulberg',
    staffProfileId: 'witness-staff',
    pin: '1234',
    rxSerialWritten: true,
    emergency: true,
    prescriberName: 'Dr Khan',
  },
};

function callerFor(permissions: Array<{ capability: string; effect: 'ALLOW' | 'DENY' }>) {
  const credential = vi.fn();
  const register = vi.fn();
  const db = {
    $transaction: async (callback: (tx: unknown) => unknown) => callback(db),
    pharmacyBranch: { findMany: async () => [{ id: 'branch-1' }] },
    medicine: {
      findFirst: async () => ({ id: 'medicine-1', controlled: true, manufacturer: 'Maker' }),
    },
    user: {
      findUnique: async () => ({
        status: 'ACTIVE',
        organizationRole: { permissions },
        permissionOverrides: [],
      }),
    },
    restaurantOperatorCredential: { findFirst: credential },
    pharmacyControlledRegisterEntry: { create: register, findFirst: vi.fn(), aggregate: vi.fn() },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'cashier-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { credential, register, caller: app.createCaller(context).pharmacySales };
}

beforeEach(() => {
  vi.mocked(addSaleLine).mockReset();
});

describe('pharmacySales.addLine controlled actor', () => {
  it('denies a cashier before the witness PIN and writes no register row', async () => {
    const { caller, credential, register } = callerFor([
      { capability: 'pharmacy.counter', effect: 'ALLOW' },
      { capability: 'pharmacy:orders', effect: 'ALLOW' },
    ]);
    await expect(caller.addLine(line)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to dispense a controlled medicine.',
    });
    expect(credential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('honors an explicit ABAC deny even when the role grants dispense', async () => {
    const { caller, credential, register } = callerFor([
      { capability: 'pharmacy:dispense', effect: 'ALLOW' },
      { capability: 'pharmacy:dispense', effect: 'DENY' },
    ]);
    await expect(caller.addLine(line)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to dispense a controlled medicine.',
    });
    expect(credential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('does not treat the legacy dotted capability as a dispense grant', async () => {
    const { caller, credential, register } = callerFor([
      { capability: 'pharmacy.dispense', effect: 'ALLOW' },
    ]);
    await expect(caller.addLine(line)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to dispense a controlled medicine.',
    });
    expect(credential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('lets a pharmacist past the actor check', async () => {
    const { caller, credential, register } = callerFor([
      { capability: 'pharmacy:dispense', effect: 'ALLOW' },
    ]);
    const { controlledAuthorization, ...plain } = line;
    void controlledAuthorization;
    await expect(caller.addLine(plain)).resolves.toEqual({
      blocked:
        'Controlled medicine requires the patient address, an independent pharmacist PIN, and either a valid prescription or an emergency supply with the prescriber name.',
    });
    expect(credential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });
});
