// @vitest-environment node
/**
 * Khata patient reads are primarily licensed through pharmacy-counter.
 * pharmacy-dispensing remains an alternative for clinical workflows; either
 * module still needs the corresponding counter or dispense capability.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { alternativeModulesForProcedure, moduleForProcedure } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  hasModule: vi.fn(),
  patient: vi.fn(),
  patients: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  recordAudit: mocks.audit,
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacyPrescriptionsRouter } from './pharmacy-prescriptions';

const testRouter = router({ pharmacyPrescriptions: pharmacyPrescriptionsRouter });
function caller(enabledModules: string[]) {
  return testRouter.createCaller({
    db: { pharmacyPatient: { findFirst: mocks.patient, findMany: mocks.patients } },
    entitlements: { organizationId: 'org-a', modules: [], enabledModules },
    session: {
      expires: 'later',
      user: { id: 'user-a', organizationId: 'org-a', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: { id: 'org-a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyPrescriptions;
}

describe('counter patient entitlement regression', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.hasModule.mockImplementation((entitlements, key) =>
      entitlements.enabledModules.includes(key)
    );
    mocks.patients.mockResolvedValue([]);
    mocks.patient.mockResolvedValue({
      id: 'patient-a', displayName: 'Patient A', cnic: null, phone: null,
      address: null, dateOfBirth: null, consents: [], prescriptions: [],
    });
  });

  it.each(['counterPatients', 'counterPatientPanel'])(
    '%s belongs to counter with dispensing as an alternative',
    (name) => {
      const path = `pharmacyPrescriptions.${name}`;
      expect(moduleForProcedure(path)).toBe('pharmacy-counter');
      expect(alternativeModulesForProcedure(path)).toEqual(['pharmacy-dispensing']);
    }
  );

  it.each([
    ['pharmacy-counter', 'pharmacy:counter'],
    ['pharmacy-dispensing', 'pharmacy:dispense'],
  ])('accepts %s alone without licensing the other module', async (module, action) => {
    mocks.can.mockImplementation(async (_subject, requested) => requested === action);
    const api = caller([module]);
    await expect(api.counterPatients({ query: 'patient' })).resolves.toEqual({ patients: [] });
    await expect(api.counterPatientPanel({ patientId: 'patient-a' })).resolves.toMatchObject({
      patientId: 'patient-a', prescriptions: [],
    });
    expect(mocks.patients).toHaveBeenCalledOnce();
    expect(mocks.patient).toHaveBeenCalledOnce();
    expect(mocks.hasModule.mock.calls.every(([entitlements]) =>
      entitlements.enabledModules.length === 1 && entitlements.enabledModules[0] === module
    )).toBe(true);
    expect(mocks.can.mock.calls.map(([, requested]) => requested)).toEqual(
      action === 'pharmacy:counter'
        ? ['pharmacy:counter', 'pharmacy:counter']
        : ['pharmacy:counter', 'pharmacy:dispense', 'pharmacy:counter', 'pharmacy:dispense']
    );
  });

  it('denies both patient reads when neither eligible module is licensed', async () => {
    mocks.can.mockResolvedValue(true);
    const api = caller([]);
    await expect(api.counterPatients({ query: 'patient' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.counterPatientPanel({ patientId: 'patient-a' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.patient).not.toHaveBeenCalled();
    expect(mocks.patients).not.toHaveBeenCalled();
  });
});
