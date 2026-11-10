import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// Finance postings are outside the evidence wiring under test.
vi.mock('@/lib/pharmacy/finance-postings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/finance-postings')>()),
  postTenderEntry: vi.fn(),
}));
vi.mock('@/lib/pharmacy/regulatory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));

import { applyPharmacyTender } from '@/lib/pharmacy/settlement';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * CAM-2 TENDER evidence wiring on the integrated tip: applyPharmacyTender requests the still on
 * its own client, after the tender row, so every caller (counter, offline, delivery, sandbox)
 * gets it. A part payment keeps the sale open, so sale completion stays out of the fixture.
 */
const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
const input = {
  saleId: 'sale-1',
  deviceId: 'device-1',
  businessDate: new Date('2026-09-29'),
  type: 'BANK_TRANSFER' as const,
  amountMinor: 100,
  idempotencyKey: 'tender-attempt',
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
      findUnique: vi.fn(async () => ({ id: 'idem-1', commandType: 'tender', payloadHash })),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'sale-1',
        status: 'OPEN',
        customerId: null,
        lines: [{ quantity: 10, unitPriceMinor: 100, discountMinor: 0 }],
        tenders: [],
      }),
    },
    pharmacyTender: {
      create: vi.fn(async ({ data }) => ({ id: 'tender-1', createdAt: new Date(), ...data })),
      findFirst: vi.fn().mockResolvedValue({ saleId: 'sale-1' }),
    },
    camera: { findFirst: vi.fn().mockResolvedValue(camera) },
    cameraEvidence: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'evidence-1' }),
    },
  };
  return db;
}

const run = (db: ReturnType<typeof fixture>) =>
  applyPharmacyTender(db as unknown as ScopedDb, scope, input);

describe('TENDER counter evidence wiring (service-level, integrated tip)', () => {
  it('writes the evidence outbox row on the tender client, after the tender row', async () => {
    const db = fixture({ id: 'camera-1' });
    await expect(run(db)).resolves.toMatchObject({
      tenderId: 'tender-1',
      settled: false,
      replayed: false,
    });
    expect(db.pharmacyTender.findFirst).toHaveBeenCalledWith({
      where: { id: 'tender-1', organizationId: 'org-1', branchId: 'branch-1' },
      select: { saleId: true },
    });
    expect(db.cameraEvidence.createMany).toHaveBeenCalledWith({
      data: [
        {
          organizationId: 'org-1',
          branchId: 'branch-1',
          subjectKind: 'PHARMACY_TENDER',
          subjectId: 'tender-1',
          saleId: 'sale-1',
          cameraId: 'camera-1',
        },
      ],
      skipDuplicates: true,
    });
    // The request is written after the money row, so a failed tender writes nothing.
    expect(db.pharmacyTender.create.mock.invocationCallOrder[0]).toBeLessThan(
      db.cameraEvidence.createMany.mock.invocationCallOrder[0]!
    );
  });

  it('writes nothing beyond the tender when the branch has no usable evidence camera', async () => {
    const db = fixture(null);
    await expect(run(db)).resolves.toMatchObject({ tenderId: 'tender-1' });
    expect(db.camera.findFirst.mock.calls[0]![0].where).toMatchObject({
      organizationId: 'org-1',
      branchId: 'branch-1',
      enabled: true,
      counterEvidence: true,
      gateway: { status: 'ACTIVE', revokedAt: null },
    });
    expect(db.cameraEvidence.createMany).not.toHaveBeenCalled();
    expect(db.pharmacyTender.create).toHaveBeenCalledTimes(1);
  });

  it('fails the tender when the outbox write fails, so its transaction rolls back', async () => {
    const db = fixture({ id: 'camera-1' });
    db.cameraEvidence.createMany.mockRejectedValue(new Error('outbox down'));
    await expect(run(db)).rejects.toThrow('outbox down');
    expect(db.pharmacyMoneyIdempotencyKey.update).not.toHaveBeenCalled();
  });
});
