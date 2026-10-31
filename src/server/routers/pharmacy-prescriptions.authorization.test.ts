// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ can: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({ ...(await vi.importActual('@/lib/abac')), can: mocks.can }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordAudit: vi.fn(),
  recordTrpcAudit: mocks.audit,
  annotateAudit: vi.fn(),
}));
import { pharmacyPrescriptionsRouter } from './pharmacy-prescriptions';
import { pharmacyDispensingRouter } from './pharmacy-dispensing';
import type { TRPCContext } from '../trpc';

function fixture(assigned = true) {
  const patient = {
    id: 'patient',
    displayName: 'Patient',
    cnic: null,
    phone: null,
    dateOfBirth: null,
    address: 'Address',
    consents: [],
    prescriptions: [],
  };
  const reads = {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => patient),
    findFirstOrThrow: vi.fn(async () => patient),
  };
  const db = {
    user: { findFirst: vi.fn(async () => ({ id: 'staff', role: 'EMPLOYEE' })) },
    pharmacyBranch: {
      findMany: vi.fn(async () => (assigned ? [{ id: 'branch-a', name: 'A' }] : [])),
    },
    pharmacyPatient: reads,
    $queryRaw: vi.fn(async () => [{ allowed: false }]),
    pharmacySaleLine: { findMany: vi.fn(async () => [{ id: 'line-a' }]) },
    pharmacyPharmacistReviewItem: { findMany: vi.fn(async () => []) },
    pharmacyPrescriber: { findMany: vi.fn(async () => []) },
    medicine: { findMany: vi.fn(async () => []) },
    prescription: { findMany: vi.fn(async () => []) },
    pharmacyRefillReminderCapture: { findMany: vi.fn(async () => []) },
  };
  const ctx = {
    db,
    session: { user: { id: 'staff', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org' } },
    organization: { id: 'org', vertical: 'PHARMACY' },
    entitlements: { organizationId: 'org' },
    audit: { detail: {} },
    requestMeta: { ip: null, userAgent: null },
    support: null,
  } as unknown as TRPCContext;
  return {
    api: pharmacyPrescriptionsRouter.createCaller(ctx),
    queue: pharmacyDispensingRouter.createCaller(ctx),
    ctx,
    db,
    reads,
  };
}
const paths = [
  'workspace',
  'readPatient',
  'exportPatient',
  'counterPatients',
  'counterPatientPanel',
] as const;
async function read(
  api: ReturnType<typeof fixture>['api'],
  path: (typeof paths)[number],
  branchId = 'branch-a'
) {
  switch (path) {
    case 'workspace':
      return api.workspace({ branchId });
    case 'counterPatients':
      return api.counterPatients({ branchId, query: 'Pa' });
    default:
      return api[path]({ branchId, patientId: 'patient' });
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
});
describe('prescription read boundary', () => {
  it.each(paths)('%s denies missing clinical and counter grants before patient or branch queries', async (path) => {
    mocks.can.mockResolvedValue(false);
    const f = fixture();
    await expect(read(f.api, path)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    for (const query of Object.values(f.reads)) expect(query).not.toHaveBeenCalled();
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:dispense',
      undefined,
      expect.anything()
    );
  });
  it.each(paths)('%s denies sibling branch before patient queries', async (path) => {
    const f = fixture();
    await expect(read(f.api, path, 'branch-b')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const query of Object.values(f.reads)) expect(query).not.toHaveBeenCalled();
    expect(f.db.pharmacyBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org',
          active: true,
          branchAssignments: { some: { organizationId: 'org', userId: 'staff', active: true } },
        }),
      })
    );
  });
  it.each(paths)('%s denies empty assignments', async (path) => {
    const f = fixture(false);
    await expect(read(f.api, path)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const query of Object.values(f.reads)) expect(query).not.toHaveBeenCalled();
  });
  it.each(paths)('%s denies a foreign session tenant before patient queries', async (path) => {
    const f = fixture();
    f.ctx.session!.user.organizationId = 'foreign';
    await expect(read(f.api, path)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const query of Object.values(f.reads)) expect(query).not.toHaveBeenCalled();
  });
  it('preserves the assigned workspace and patient masking', async () => {
    const f = fixture();
    await expect(f.api.workspace()).resolves.toMatchObject({
      selectedBranchId: 'branch-a',
      branches: [{ id: 'branch-a', name: 'A' }],
    });
    await expect(
      f.api.readPatient({ branchId: 'branch-a', patientId: 'patient' })
    ).resolves.toMatchObject({ id: 'patient' });
  });
});

describe('alternate clinical read paths', () => {
  it.each(['reviewQueue', 'substitutionWorkspace'] as const)(
    '%s filters clinical items through assigned sale branches',
    async (path) => {
      const f = fixture();
      await f.queue[path]();
      expect(f.db.pharmacySaleLine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org', branchId: { in: ['branch-a'] } },
        })
      );
      expect(f.db.pharmacyPharmacistReviewItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org', saleLineId: { in: ['line-a'] } },
        })
      );
    }
  );
  it.each(['reviewQueue', 'substitutionWorkspace'] as const)(
    '%s denies empty assignments before clinical queries',
    async (path) => {
      const f = fixture(false);
      await expect(f.queue[path]()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.pharmacyPharmacistReviewItem.findMany).not.toHaveBeenCalled();
      expect(f.db.pharmacySaleLine.findMany).not.toHaveBeenCalled();
    }
  );
});


describe('cashier counter patient access', () => {
  beforeEach(() => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:counter');
  });
  it('allows masked patient search and the limited panel on an assigned branch', async () => {
    const f = fixture();
    f.reads.findMany.mockResolvedValue([{ id: 'patient', displayName: 'Patient',
      phone: '03001234567', cnic: '3520212345678', dateOfBirth: null }] as never);
    await expect(f.api.counterPatients({ branchId: 'branch-a', query: 'Pa' })).resolves.toEqual({
      patients: [{ patientId: 'patient', displayName: 'Patient', phone: '*******4567' }],
    });
    const panel = await f.api.counterPatientPanel({ branchId: 'branch-a', patientId: 'patient' });
    expect(panel).toMatchObject({ patientId: 'patient', prescriptions: [], dispensingConsent: false });
    expect(panel).not.toHaveProperty('sourceFileRef');
    expect(panel).not.toHaveProperty('dateOfBirth');
    expect(f.ctx.audit.detail.skipInput).toBe(true);
  });
  it.each(['workspace', 'readPatient', 'exportPatient'] as const)(
    'keeps %s behind the clinical-file guard', async (path) => {
      const f = fixture();
      await expect(read(f.api, path)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      for (const query of Object.values(f.reads)) expect(query).not.toHaveBeenCalled();
    }
  );
  it.each(['counterPatients', 'counterPatientPanel'] as const)(
    'denies %s on another branch despite the counter grant', async (path) => {
      const f = fixture();
      await expect(read(f.api, path, 'branch-b')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      for (const query of Object.values(f.reads)) expect(query).not.toHaveBeenCalled();
    }
  );
});
