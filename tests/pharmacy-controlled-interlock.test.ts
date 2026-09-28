import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', () => ({ can: vi.fn(async () => true) }));
vi.mock('@/lib/pharmacy/sales', async (original) => ({
  ...(await original<object>()),
  addSaleLine: vi.fn(),
}));
vi.mock('@/lib/restaurant/operator-credentials', async (original) => ({
  ...(await original<object>()),
  verifyOperatorCredential: vi.fn(async () => false),
}));
import { pharmacySalesRouter } from '@/server/routers/pharmacy-sales';
import type { TRPCContext } from '@/server/trpc';
import { addSaleLine } from '@/lib/pharmacy/sales';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
const input = {
  branchId: 'branch-1',
  saleId: 'sale-1',
  medicineId: 'med-1',
  presentationId: 'pres-1',
  packLevelId: 'pack-1',
  saleUnit: 'UNIT' as const,
  quantity: 1,
  canonicalUnitsPerSaleUnit: 1,
  idempotencyKey: 'request-1',
};
const auth = {
  prescriptionLineId: 'rx-1',
  patientId: 'patient-1',
  staffProfileId: 'staff-1',
  pin: '7392',
};
function fixture() {
  const credential = {
    id: 'credential-1',
    failedAttempts: 4,
    lockedUntil: null,
    credentialHash: 'hash',
    staffProfile: {
      status: 'ACTIVE',
      user: { id: 'pharmacist', organizationId: 'org-1', status: 'ACTIVE', role: 'EMPLOYEE' },
    },
  };
  const db = {
    medicine: { findFirst: vi.fn(async () => ({ controlled: true })) },
    $queryRaw: vi.fn(),
    restaurantOperatorCredential: { findFirst: vi.fn(async () => credential), update: vi.fn() },
    prescriptionLine: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: async (fn: (db: unknown) => unknown) => fn(db),
  };
  const caller = pharmacySalesRouter.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'cashier', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
  return { caller, db, credential };
}
beforeEach(() => vi.clearAllMocks());
it('blocks controlled stock before allocation when authorization is absent', async () => {
  const { caller } = fixture();
  expect(await caller.addLine(input)).toHaveProperty('blocked');
  expect(addSaleLine).not.toHaveBeenCalled();
});
it('persists lockout on the fifth incorrect PIN without allocating stock', async () => {
  const { caller, db } = fixture();
  expect(await caller.addLine({ ...input, controlledAuthorization: auth })).toHaveProperty(
    'blocked'
  );
  expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
    where: { id: 'credential-1' },
    data: { failedAttempts: 0, lockedUntil: expect.any(Date) },
  });
  expect(addSaleLine).not.toHaveBeenCalled();
});
it('rejects cashier self-approval even with an active credential', async () => {
  const { caller, credential } = fixture();
  credential.staffProfile.user.id = 'cashier';
  expect(await caller.addLine({ ...input, controlledAuthorization: auth })).toHaveProperty(
    'blocked'
  );
  expect(verifyOperatorCredential).not.toHaveBeenCalled();
  expect(addSaleLine).not.toHaveBeenCalled();
});
it('rejects an unavailable prescription after a correct PIN', async () => {
  vi.mocked(verifyOperatorCredential).mockResolvedValueOnce(true);
  const { caller } = fixture();
  expect(await caller.addLine({ ...input, controlledAuthorization: auth })).toHaveProperty(
    'blocked'
  );
  expect(addSaleLine).not.toHaveBeenCalled();
});

it.each([
  ['missing patient ID', { cnic: null }],
  ['blank patient ID', { cnic: '   ' }],
])('refuses %s even with a correct independent PIN', async (_, patient) => {
  vi.mocked(verifyOperatorCredential).mockResolvedValueOnce(true);
  const { caller, db } = fixture();
  db.prescriptionLine.findFirst.mockResolvedValue({
    prescription: {
      patientId: auth.patientId,
      patient,
      prescriber: { registrationNumber: 'REG-1' },
      validFrom: new Date('2020-01-01'),
      validUntil: new Date('2099-01-01'),
    },
  });
  expect(await caller.addLine({ ...input, controlledAuthorization: auth })).toHaveProperty(
    'blocked'
  );
  expect(addSaleLine).not.toHaveBeenCalled();
});

it('refuses an expired prescription without allocating stock', async () => {
  vi.mocked(verifyOperatorCredential).mockResolvedValueOnce(true);
  const { caller, db } = fixture();
  db.prescriptionLine.findFirst.mockResolvedValue({
    prescription: {
      patientId: auth.patientId,
      patient: { cnic: '3520112345678' },
      prescriber: { registrationNumber: 'REG-1' },
      validFrom: new Date('2020-01-01'),
      validUntil: new Date('2021-01-01'),
    },
  });
  expect(await caller.addLine({ ...input, controlledAuthorization: auth })).toHaveProperty(
    'blocked'
  );
  expect(addSaleLine).not.toHaveBeenCalled();
});
