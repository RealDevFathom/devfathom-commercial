import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// Finance postings are outside the evidence wiring under test.
vi.mock('@/lib/pharmacy/finance-postings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/finance-postings')>()),
  postTenderEntry: vi.fn(),
  postTenderRefundEntry: vi.fn(),
  postSaleLineEntry: vi.fn(),
}));

import { refundPharmacyTender } from '@/lib/pharmacy/settlement';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * CAM-2 (F6) evidence wiring on the integrated tip. F6 requested the still in the router, after
 * the settlement call. The tip requests it inside the settlement service, on the service's own
 * client, so every caller (counter, failed delivery, sandbox) gets it. These cases carry F6's
 * router-level assertions over to that design: same client, written after the money row, nothing
 * written without a usable camera, and an outbox failure fails the event.
 */
const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
const input = {
  originalTenderId: 'cash-tender',
  deviceId: 'device-1',
  businessDate: new Date('2026-09-29'),
  amountMinor: 100,
  reason: 'Returned medicine',
  idempotencyKey: 'refund-attempt',
};

function fixture(camera: { id: string } | null) {
  let payloadHash = '';
  const db = {
    $executeRaw: vi.fn(async (query: { values: unknown[] }) => {
      payloadHash = String(query.values[5]);
      return 1;
    }),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => ({ id: 'idem-1', commandType: 'refund', payloadHash })),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyTender: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'cash-tender',
        saleId: 'sale-1',
        type: 'CASH',
        amountMinor: 1000,
        refunds: [],
        sale: { customerId: null },
      }),
    },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'sale-1',
        status: 'COMPLETED',
        lines: [
          {
            quantity: 10,
            unitPriceMinor: 100,
            discountMinor: 0,
            canonicalUnits: 10,
            unidentifiedReturnHolds: [],
            returnLines: [
              { canonicalUnits: 5, grossMinor: 500, discountMinor: 0 },
            ],
          },
        ],
        refunds: [],
      }),
    },
    pharmacyDrawerSession: { findFirst: vi.fn().mockResolvedValue({ id: 'drawer-1' }) },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyRefund: {
      create: vi.fn(async ({ data }) => ({ id: 'refund-1', ...data })),
      findFirst: vi.fn().mockResolvedValue({ saleId: 'sale-1' }),
    },
    pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
    camera: { findFirst: vi.fn().mockResolvedValue(camera) },
    cameraEvidence: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'evidence-1' }),
    },
  };
  return db;
}

const run = (db: ReturnType<typeof fixture>) =>
  refundPharmacyTender(db as unknown as ScopedDb, scope, input);

describe('REFUND counter evidence wiring (service-level, integrated tip)', () => {
  it('authorizes the exact allocation value rather than a unit-prorated line value', async () => {
    const db = fixture(null);
    db.pharmacySale.findFirst.mockResolvedValue({
      id: 'sale-1',
      status: 'COMPLETED',
      lines: [
        {
          quantity: 3,
          unitPriceMinor: 133,
          grossMinor: 400,
          discountMinor: 40,
          canonicalUnits: 3,
          unidentifiedReturnHolds: [],
          returnLines: [{ canonicalUnits: 1, grossMinor: 200, discountMinor: 20 }],
        },
      ],
      refunds: [],
    });
    await expect(
      refundPharmacyTender(db as unknown as ScopedDb, scope, { ...input, amountMinor: 180 })
    ).resolves.toMatchObject({ refundId: 'refund-1' });
  });
  it('writes the evidence outbox row on the refund client, after the refund row', async () => {
    const db = fixture({ id: 'camera-1' });
    await expect(run(db)).resolves.toMatchObject({ refundId: 'refund-1', replayed: false });
    expect(db.pharmacyRefund.findFirst).toHaveBeenCalledWith({
      where: { id: 'refund-1', organizationId: 'org-1', branchId: 'branch-1' },
      select: { saleId: true },
    });
    expect(db.cameraEvidence.createMany).toHaveBeenCalledWith({
      data: [
        {
          organizationId: 'org-1',
          branchId: 'branch-1',
          subjectKind: 'PHARMACY_REFUND',
          subjectId: 'refund-1',
          saleId: 'sale-1',
          cameraId: 'camera-1',
        },
      ],
      skipDuplicates: true,
    });
    // The request is written after the money row, so a failed refund writes nothing.
    expect(db.pharmacyRefund.create.mock.invocationCallOrder[0]).toBeLessThan(
      db.cameraEvidence.createMany.mock.invocationCallOrder[0]!
    );
  });

  it('writes nothing beyond the refund when the branch has no usable evidence camera', async () => {
    const db = fixture(null);
    await expect(run(db)).resolves.toMatchObject({ refundId: 'refund-1' });
    expect(db.camera.findFirst.mock.calls[0]![0].where).toMatchObject({
      organizationId: 'org-1',
      branchId: 'branch-1',
      enabled: true,
      counterEvidence: true,
      gateway: { status: 'ACTIVE', revokedAt: null },
    });
    expect(db.cameraEvidence.createMany).not.toHaveBeenCalled();
    expect(db.pharmacyRefund.create).toHaveBeenCalledTimes(1);
  });

  it('fails the refund when the outbox write fails, so its transaction rolls back', async () => {
    const db = fixture({ id: 'camera-1' });
    db.cameraEvidence.createMany.mockRejectedValue(new Error('outbox down'));
    await expect(run(db)).rejects.toThrow('outbox down');
    expect(db.pharmacyMoneyIdempotencyKey.update).not.toHaveBeenCalled();
  });
});
