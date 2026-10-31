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

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

function callerFor(permissions: Permission[], permissionOverrides: Permission[] = []) {
  const credential = vi.fn();
  const register = vi.fn();
  const lock = vi.fn();
  const db = {
    $transaction: async (callback: (tx: unknown) => unknown) => callback(db),
    $queryRaw: lock,
    pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch-1' }]) },
    pharmacyBranch: {
      findFirst: vi.fn(async () => ({ id: 'branch-1' })),
      findMany: async () => [{ id: 'branch-1' }],
    },
    branchRegulatoryProfile: {
      findFirst: async () => ({
        branchId: 'branch-1',
        licenceCategory: 'PHARMACY',
        licenceValidFrom: new Date('2020-01-01T00:00:00.000Z'),
        licenceValidTo: new Date('2100-01-01T00:00:00.000Z'),
        licenceEvidenceFileRef: 'evidence://pharmacy-licence',
        permittedSchedules: ['*'],
        qualifiedPersonRegistration: 'QP-1',
        qualifiedPersonValidFrom: new Date('2020-01-01T00:00:00.000Z'),
        qualifiedPersonValidTo: new Date('2100-01-01T00:00:00.000Z'),
        qualifiedPersonCoverageRosterRef: 'roster-1',
        jurisdictionRuleSet: {
          licenceCategories: { provisional: false, values: ['PHARMACY'] },
          permittedSchedules: { provisional: false, values: ['*'] },
          pharmacistCoverageRule: { provisional: false },
        },
      }),
    },
    medicine: {
      findFirst: async () => ({ id: 'medicine-1', controlled: true, manufacturer: 'Maker' }),
    },
    user: {
      findUnique: async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions },
        permissionOverrides,
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
  return { credential, register, lock, caller: app.createCaller(context).pharmacySales };
}

beforeEach(() => {
  vi.mocked(addSaleLine).mockReset();
});

describe('pharmacySales.addLine controlled actor', () => {
  it('denies a cashier before the witness PIN and writes no register row', async () => {
    const { caller, credential, register, lock } = callerFor([
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy:orders', effect: 'ALLOW' },
    ]);
    await expect(caller.addLine(line)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to dispense a controlled medicine.',
    });
    expect(credential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it('honors an explicit ABAC deny even when the role grants dispense', async () => {
    const { caller, credential, register } = callerFor(
      [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
      [{ capability: 'pharmacy:dispense', effect: 'DENY' }]
    );
    await expect(caller.addLine(line)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to dispense a controlled medicine.',
    });
    expect(credential).not.toHaveBeenCalled();
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it.each(['pharmacy:dispense', 'pharmacy:*', '*'])(
    'honors a role DENY for %s even when an override grants dispense',
    async (capability) => {
      const { caller, credential, register, lock } = callerFor(
        [{ capability, effect: 'DENY' }],
        [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]
      );
      await expect(caller.addLine(line)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'You do not have permission to dispense a controlled medicine.',
      });
      expect(lock).not.toHaveBeenCalled();
      expect(credential).not.toHaveBeenCalled();
      expect(addSaleLine).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
    }
  );

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

  it('accepts the canonical exact dispense capability at the actor check', async () => {
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

  it('checks the independent witness after accepting an authorized actor', async () => {
    const { caller, credential, register, lock } = callerFor([
      { capability: 'pharmacy:dispense', effect: 'ALLOW' },
    ]);
    credential.mockResolvedValue(null);

    await expect(caller.addLine(line)).resolves.toEqual({
      blocked:
        'Controlled medicine requires the patient address, an independent pharmacist PIN, and either a valid prescription or an emergency supply with the prescriber name.',
    });
    // One read resolves whether the witness profile is the actor's own (solo owner PIN);
    // the second serializes the independent witness credential row.
    expect(lock).toHaveBeenCalledTimes(2);
    expect(credential).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: 'org-1',
        staffProfileId: 'witness-staff',
        type: 'PIN',
        revokedAt: null,
        deviceId: null,
      },
      include: { staffProfile: { include: { user: true } } },
    });
    expect(addSaleLine).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });
});
