import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(), branch: vi.fn(), fill: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', () => ({ can: mocks.can }));
vi.mock('./branch-assignment', () => ({ assertBranchAssignment: mocks.branch }));
vi.mock('./rx-prescription-reference', () => ({ recordCompletedPrescriptionReference: mocks.fill }));
vi.mock('./finance-postings', () => ({ postSaleLineEntry: vi.fn() }));
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: vi.fn(async () => new Map()) }));
vi.mock('./receipt-identity', () => ({ validateReceiptIdentity: vi.fn((snapshot) => snapshot) }));

import { assertRxSaleLinesAllowed, PharmacyRxSaleDenied } from './rx-sale-gate';
import { completePaidPharmacySale } from './sale-completion';

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'owner' };
function fixture() {
  const approval = {
    actorId: 'pharmacist',
    metadata: {
      saleId: 'sale', branchId: 'branch', requestedById: 'owner', medicineId: 'medicine',
      presentationId: 'presentation', canonicalUnits: 2,
    },
  };
  const sale = {
    id: 'sale', createdByUserId: 'owner', tenders: [],
    lines: [{
      id: 'line', organizationId: 'org', branchId: 'branch', medicineId: 'medicine',
      presentationId: 'presentation', canonicalUnits: 2, prescriptionLineId: 'prescription-line',
      prescriptionPatientId: 'patient', allocations: [],
      medicine: { organizationId: 'org', rx: true, restricted: false, controlled: false,
        productName: 'Medicine', strengths: [] },
      presentation: { organizationId: 'org', medicineId: 'medicine', presentation: 'Tablet' },
    }],
  };
  const db = {
    auditLog: { findFirst: vi.fn(async () => approval as typeof approval | null) },
    user: {
      findFirst: vi.fn(async () => ({ organizationRole: { key: 'pharmacist' } }) as
        { organizationRole: { key: string } } | null),
      findUnique: vi.fn(async () => ({ permissionOverrides: [], organizationRole: { permissions: [] } })),
    },
    $queryRaw: vi.fn(async () => [{ receipt_number: 1 }]),
    pharmacySale: { update: vi.fn() },
    pharmacySaleEvent: { create: vi.fn() },
  };
  return { db, approval, sale };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.branch.mockImplementation(async (_db, branchScope) => branchScope);
});

describe('recorded Rx approvals when the payer can dispense', () => {
  it('attributes the completed prescription fill to the approving pharmacist', async () => {
    const { db, sale } = fixture();
    await completePaidPharmacySale(db as never, scope, sale as never, {
      deviceId: 'device', businessDate: new Date('2026-10-31T00:00:00Z'),
    });
    expect(mocks.fill).toHaveBeenCalledWith(db, { ...scope, actorId: 'pharmacist' },
      expect.objectContaining({ prescriptionLineId: 'prescription-line', saleId: 'sale' }),
      expect.any(Date));
    expect(db.pharmacySale.update).toHaveBeenCalled();
  });

  it.each(['permission', 'assignment', 'role', 'status'])(
    'denies completion after the checker loses %s despite the owner dispensing grant',
    async (change) => {
      const { db, sale } = fixture();
      if (change === 'permission')
        mocks.can.mockImplementation(async (subject) => subject.id === 'owner');
      if (change === 'assignment') mocks.branch.mockRejectedValue(new PharmacyRxSaleDenied());
      if (change === 'role')
        db.user.findFirst.mockResolvedValue({ organizationRole: { key: 'cashier' } });
      if (change === 'status') db.user.findFirst.mockResolvedValue(null);
      await expect(completePaidPharmacySale(db as never, scope, sale as never, {
        deviceId: 'device', businessDate: new Date(),
      })).rejects.toBeInstanceOf(PharmacyRxSaleDenied);
      expect(db.pharmacySale.update).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(mocks.fill).not.toHaveBeenCalled();
    }
  );

  it.each(['saleId', 'branchId', 'requestedById', 'medicineId', 'presentationId'] as const)(
    'refuses recorded evidence with mismatched %s even for a dispensing payer', async (field) => {
      const { db, sale, approval } = fixture();
      approval.metadata[field] = 'different';
      await expect(assertRxSaleLinesAllowed(db as never, scope, sale)).rejects.toBeInstanceOf(PharmacyRxSaleDenied);
    }
  );

  it('refuses a changed quantity even for a dispensing payer', async () => {
    const { db, sale, approval } = fixture();
    approval.metadata.canonicalUnits = 1;
    await expect(assertRxSaleLinesAllowed(db as never, scope, sale)).rejects.toBeInstanceOf(PharmacyRxSaleDenied);
  });

  it('preserves direct dispensing without delegated evidence and denies an unapproved cashier', async () => {
    const { db, sale } = fixture();
    db.auditLog.findFirst.mockResolvedValue(null);
    await expect(assertRxSaleLinesAllowed(db as never, scope, sale)).resolves.toEqual(new Map());
    mocks.can.mockResolvedValue(false);
    await expect(assertRxSaleLinesAllowed(db as never, scope, sale)).rejects.toBeInstanceOf(PharmacyRxSaleDenied);
  });
});
