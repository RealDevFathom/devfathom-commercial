// Real router, central ABAC, Rx gate and settlement; only persistence, batch
// inspection (covered separately) and accounting postings are bounded fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sale-batch-safety', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sale-batch-safety')>()),
  assertSaleBatchesSellable: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/pharmacy/finance-postings', () => ({
  postTenderEntry: vi.fn(),
  postSaleLineEntry: vi.fn(),
  postTenderRefundEntry: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sales', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: vi.fn(async () => ({ line: { id: 'line-a' } })),
}));

import { hasModule } from '@/lib/entitlements';
import {
  assertSaleBatchesSellable,
  PharmacySaleBatchError,
} from '@/lib/pharmacy/sale-batch-safety';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { addSaleLine } from '@/lib/pharmacy/sales';
import { completePaidPharmacySale } from '@/lib/pharmacy/sale-completion';
import { pharmacySalesRouter } from './pharmacy-sales';
import type { TRPCContext } from '../trpc';

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };
const input = {
  branchId: 'branch-a',
  saleId: 'sale-a',
  deviceId: 'device-a',
  businessDate: new Date('2026-11-01T00:00:00Z'),
  type: 'CASH' as const,
  amountMinor: 100,
  cashReceivedMinor: 150,
  idempotencyKey: 'payment-a',
};
function fixture(role = 'owner-operator', overrides: Permission[] = [], roleDenies: string[] = []) {
  const permissions: Permission[] = [
    ...(role === 'pharmacist'
      ? [{ capability: 'pharmacy:counter', effect: 'ALLOW' as const }]
      : []),
    ...PHARMACY_ROLE_TEMPLATES.find((r) => r.key === role)!.capabilities.map((capability) => ({
      capability,
      effect: 'ALLOW' as const,
    })),
    ...roleDenies.map((capability) => ({ capability, effect: 'DENY' as const })),
  ];
  let idempotency: Record<string, unknown> | null = null;
  const sale = {
    id: 'sale-a',
    status: 'OPEN',
    customerId: 'customer-a',
    lines: [
      {
        id: 'line-a',
        prescriptionLineId: 'rx-a',
        prescriptionPatientId: 'patient-a',
        organizationId: 'org-a',
        branchId: 'branch-a',
        medicineId: 'medicine-a',
        presentationId: 'presentation-a',
        quantity: 1,
        canonicalUnits: 1,
        unitPriceMinor: 100,
        discountMinor: 0,
        medicine: {
          organizationId: 'org-a',
          productName: 'Rx medicine',
          rx: true,
          restricted: false,
          controlled: false,
          strengths: [],
        },
        presentation: { organizationId: 'org-a', medicineId: 'medicine-a', presentation: 'Tablet' },
        allocations: [
          {
            id: 'allocation-a',
            organizationId: 'org-a',
            branchId: 'branch-a',
            inventoryLotId: 'lot-a',
            canonicalUnits: 1,
            lot: {
              organizationId: 'org-a',
              branchId: 'branch-a',
              batch: {
                organizationId: 'org-a',
                medicineId: 'medicine-a',
                batchNumber: 'B1',
                expiresAt: new Date('2030-01-01'),
              },
            },
          },
        ],
      },
    ],
    tenders: [],
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-a',
        organizationRole: { permissions },
        permissionOverrides: overrides,
      })),
    },
    pharmacyBranch: {
      findMany: vi.fn(async () => [{ id: 'branch-a' }]),
      findFirst: vi.fn(async () => ({ id: 'branch-a' })),
    },
    pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch-a' }]) },
    pharmacyDailyClose: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    pharmacyDrawerSession: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'drawer-a' })),
    },
    pharmacyDrawerMovement: { create: vi.fn(async () => ({})) },
    pharmacySale: { findFirst: vi.fn(async () => sale), update: vi.fn(async () => ({})) },
    pharmacySaleLine: {
      findFirst: vi.fn(async () => ({ ...sale.lines[0], saleId: sale.id })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    pharmacyLoyaltyPointsEntry: { findUnique: vi.fn(async () => null), create: vi.fn() },
    pharmacyPharmacistReviewItem: {
      findFirst: vi.fn(async (): Promise<{ prescriptionLineId: string } | null> => null),
      create: vi.fn(async () => ({})),
    },
    pharmacyTender: {
      create: vi.fn(async () => ({ id: 'tender-a', createdAt: new Date() })),
      findFirst: vi.fn(async () => ({ saleId: 'sale-a' })),
    },
    pharmacyPharmacistReviewDecision: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'signed-a' })),
    },
    prescriptionLine: {
      findFirst: vi.fn(async () => ({
        id: 'rx-a',
        authorizedCanonicalUnits: 100,
        prescription: {
          patientId: 'patient-a',
          validFrom: new Date('2020-01-01'),
          validUntil: new Date('2100-01-01'),
          authorizedRepeats: 2,
        },
        fills: [],
      })),
    },
    prescriptionFill: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    medicine: { findFirst: vi.fn(async () => sale.lines[0].medicine) },
    pharmacySaleEvent: { create: vi.fn(async () => ({})) },
    camera: { findFirst: vi.fn(async () => null) },
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => idempotency),
      update: vi.fn(async ({ data }: { data: { resultPayload: unknown } }) => {
        idempotency = { ...idempotency, resultPayload: data.resultPayload };
        return idempotency;
      }),
    },
    $queryRaw: vi.fn(async () => [{ receipt_number: 41 }]),
    $executeRaw: vi.fn(async (query: { values: unknown[] }) => {
      idempotency ??= {
        id: 'idem-a',
        commandType: 'tender',
        payloadHash: query.values[5],
        resultPayload: null,
      };
      return 1;
    }),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'pharmacist-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return {
    db,
    sale,
    context,
    caller: () => pharmacySalesRouter.createCaller(context as unknown as TRPCContext),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasModule).mockReturnValue(true);
  vi.mocked(assertSaleBatchesSellable).mockReset().mockResolvedValue(new Map());
});

describe('DEV-629 server prescription enforcement', () => {
  it('settles a signed Rx sale, records its fill and replays one payment/receipt', async () => {
    const f = fixture();
    await expect(f.caller().tender(input)).resolves.toMatchObject({
      tenderId: 'tender-a',
      settled: true,
      receiptNumber: 41,
      remainingMinor: 0,
      replayed: false,
    });
    await expect(f.caller().tender(input)).resolves.toMatchObject({
      tenderId: 'tender-a',
      replayed: true,
    });
    expect(f.db.pharmacyTender.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        actorId: 'pharmacist-a',
        amountMinor: 100,
        cashReceivedMinor: 150,
        changeGivenMinor: 50,
        drawerSessionId: 'drawer-a',
      }),
    });
    expect(f.db.pharmacySale.update).toHaveBeenCalledExactlyOnceWith({
      where: { organizationId_id: { organizationId: 'org-a', id: 'sale-a' } },
      data: expect.objectContaining({ status: 'COMPLETED', receiptNumber: 41 }),
    });
    expect(f.db.pharmacySaleEvent.create).toHaveBeenCalledOnce();
    expect(f.db.prescriptionFill.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        prescriptionLineId: 'rx-a',
        dispensedByUserId: 'pharmacist-a',
        quantityCanonicalUnits: 1,
      }),
    });
    expect(assertSaleBatchesSellable).toHaveBeenCalledTimes(2);
    expect(f.db.pharmacySale.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sale-a', organizationId: 'org-a', branchId: 'branch-a' },
      })
    );
    const locks = f.db.$queryRaw.mock.calls.map((c) =>
      (c as unknown as [{ strings: string[] }])[0].strings.join(' ')
    );
    expect(locks.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(locks.some((s) => s.includes('FOR UPDATE'))).toBe(true);
  });
  it('allows an unlinked draft line but does not authorize payment', async () => {
    const f = fixture();
    f.sale.lines[0].prescriptionLineId = '';
    await expect(
      f.caller().addLine({
        branchId: 'branch-a',
        saleId: 'sale-a',
        medicineId: 'medicine-a',
        presentationId: 'presentation-a',
        packLevelId: 'pack-a',
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: 'line-a',
      })
    ).resolves.toMatchObject({ line: { id: 'line-a' } });
    expect(addSaleLine).toHaveBeenCalledOnce();
    await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.update).not.toHaveBeenCalled();
  });
  it('attaches only the exact line and queues review without signing', async () => {
    const f = fixture();
    f.sale.lines[0].prescriptionLineId = '';
    await expect(
      f.caller().attachCounterPrescription({
        branchId: 'branch-a',
        saleId: 'sale-a',
        saleLineId: 'line-a',
        patientId: 'patient-a',
        prescriptionLineId: 'rx-a',
      })
    ).resolves.toEqual({ attached: true });
    expect(f.db.pharmacySaleLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'line-a',
          branchId: 'branch-a',
          organizationId: 'org-a',
        }),
        data: { prescriptionLineId: 'rx-a', prescriptionPatientId: 'patient-a' },
      })
    );
    expect(f.db.pharmacyPharmacistReviewItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          saleLineId: 'line-a',
          prescriptionLineId: 'rx-a',
          organizationId: 'org-a',
        }),
      })
    );
    expect(f.db.pharmacyPharmacistReviewDecision.findFirst).not.toHaveBeenCalled();
  });
  it('refuses an orphan review rather than reusing an earlier signature', async () => {
    const f = fixture();
    f.sale.lines[0].prescriptionLineId = '';
    f.db.pharmacyPharmacistReviewItem.findFirst.mockResolvedValue({ prescriptionLineId: 'rx-a' });
    await expect(
      f.caller().attachCounterPrescription({
        branchId: 'branch-a',
        saleId: 'sale-a',
        saleLineId: 'line-a',
        patientId: 'patient-a',
        prescriptionLineId: 'rx-a',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.pharmacySaleLine.updateMany).not.toHaveBeenCalled();
  });
  it('refuses a legacy Rx sale with no attached reference before charging', async () => {
    const f = fixture();
    f.sale.lines[0].prescriptionLineId = '';
    await expect(f.caller().tender(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('verified prescription'),
    });
    expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.update).not.toHaveBeenCalled();
  });
  it('refuses direct completion of an unlinked line before issuing a receipt', async () => {
    const f = fixture();
    f.sale.lines[0].prescriptionLineId = '';
    await expect(
      completePaidPharmacySale(
        f.db as never,
        { organizationId: 'org-a', branchId: 'branch-a', actorId: 'pharmacist-a' },
        f.sale as never,
        { deviceId: 'device-a', businessDate: new Date() }
      )
    ).rejects.toMatchObject({ reason: 'PRESCRIPTION_REQUIRED' });
    expect(f.db.pharmacySale.update).not.toHaveBeenCalled();
    expect(f.db.prescriptionFill.create).not.toHaveBeenCalled();
  });
  it('refuses even a partial loyalty tender on an unlinked Rx bill', async () => {
    const f = fixture();
    f.sale.lines[0].prescriptionLineId = '';
    await expect(
      f
        .caller()
        .redeemPoints({
          branchId: 'branch-a',
          saleId: 'sale-a',
          points: 1,
          deviceId: 'device-a',
          businessDate: new Date(),
          idempotencyKey: 'loyalty-a',
        })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(f.db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
  it('refuses an unsigned attached prescription before charging', async () => {
    const f = fixture();
    f.db.pharmacyPharmacistReviewDecision.findFirst.mockResolvedValue(null);
    await expect(f.caller().tender(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('verify and sign'),
    });
    expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.update).not.toHaveBeenCalled();
    expect(f.db.pharmacyPharmacistReviewDecision.findFirst).toHaveBeenCalledWith({
      where: {
        reviewItem: { saleLineId: 'line-a', prescriptionLineId: 'rx-a' },
        kind: 'SIGN',
        signedAt: { not: null },
      },
      select: { id: true },
    });
  });
  it('keeps ordinary OTC settlement available without prescription evidence', async () => {
    const f = fixture();
    f.sale.lines[0].medicine.rx = false;
    f.sale.lines[0].prescriptionLineId = '';
    await expect(f.caller().tender(input)).resolves.toMatchObject({ settled: true });
    expect(f.db.pharmacyPharmacistReviewDecision.findFirst).not.toHaveBeenCalled();
  });
  it.each(['pharmacy:counter', 'pharmacy:dispense', 'pharmacy:*', '*'])(
    'preserves an explicit user DENY of %s',
    async (capability) => {
      const f = fixture('pharmacist', [{ capability, effect: 'DENY' }]);
      await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
    }
  );
  it('preserves a role DENY despite a user ALLOW', async () => {
    const f = fixture(
      'pharmacist',
      [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
      ['pharmacy:counter']
    );
    await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
  });
  it('keeps a cashier from paying an Rx bill without dispensing authorization', async () => {
    const f = fixture('cashier');
    await expect(f.caller().tender(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('dispensing permission'),
    });
    expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
  });
  it.each(['unassigned', 'foreign', 'inactive'] as const)(
    'fails closed for %s access',
    async (kind) => {
      const f = fixture();
      if (kind === 'unassigned') f.db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
      if (kind === 'foreign') f.context.session.user.organizationId = 'org-other';
      if (kind === 'inactive') f.context.session.user.status = 'INACTIVE';
      await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
    }
  );
  it.each(['drawer', 'closed-day', 'over-tender', 'batch'] as const)(
    'preserves the %s payment gate',
    async (kind) => {
      const f = fixture();
      if (kind === 'drawer') f.db.pharmacyDrawerSession.findFirst.mockResolvedValue(null);
      if (kind === 'closed-day')
        f.db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close-a' });
      if (kind === 'batch')
        vi.mocked(assertSaleBatchesSellable).mockRejectedValue(
          new PharmacySaleBatchError('SALE_BATCH_RECALLED', 'RECALLED', 'line-a', 'lot-a')
        );
      await expect(
        f.caller().tender({ ...input, amountMinor: kind === 'over-tender' ? 101 : 100 })
      ).rejects.toBeDefined();
      expect(f.db.pharmacyTender.create).not.toHaveBeenCalled();
      expect(f.db.pharmacySale.update).not.toHaveBeenCalled();
    }
  );
});
