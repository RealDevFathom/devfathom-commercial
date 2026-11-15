import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// The pharmacy:dispense grant has its own suites; here the payer holds it.
vi.mock('@/lib/abac', () => ({ can: vi.fn(async () => true) }));
const batchSafety = vi.hoisted(() => ({
  assertSaleBatchesSellable: vi.fn(async () => new Map()),
}));
vi.mock('./sale-batch-safety', () => ({
  assertSaleBatchesSellable: batchSafety.assertSaleBatchesSellable,
}));
const postings = vi.hoisted(() => ({ postTenderEntry: vi.fn(), postSaleLineEntry: vi.fn() }));
vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  postTenderEntry: postings.postTenderEntry,
  postSaleLineEntry: postings.postSaleLineEntry,
}));
vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));

import { completePaidPharmacySale } from './sale-completion';
import { applyPharmacyTender } from './settlement';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'pharmacist-1' };

function rxLine(prescriptionLineId: string | null) {
  return {
    id: 'line-1',
    quantity: 1,
    unitPriceMinor: 100,
    discountMinor: 0,
    prescriptionLineId,
    medicine: {
      organizationId: 'org-1',
      productName: 'Amoxicillin 500mg',
      rx: true,
      restricted: false,
      controlled: false,
      strengths: [],
    },
  };
}

function saleDb(line = rxLine(null)) {
  return {
    // No pharmacist has signed the RX-03 review of this sale line.
    pharmacyPharmacistReviewDecision: { findFirst: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'sale-1',
        status: 'OPEN',
        lines: [line],
        tenders: [],
      }),
      update: vi.fn(),
    },
    pharmacyTender: { create: vi.fn() },
    pharmacySaleEvent: { create: vi.fn() },
    pharmacyDrawerMovement: { create: vi.fn() },
    camera: { findFirst: vi.fn() },
  };
}

describe('DEV-629: the server refuses to sell an Rx line with no prescription', () => {
  const refusals = [
    [
      'no prescription',
      null,
      { name: 'PharmacyRxReferenceError', reason: 'PRESCRIPTION_REQUIRED' },
    ],
    [
      'an attached prescription no pharmacist signed',
      'rx-line-1',
      { name: 'PharmacyDispensingError', code: 'PHARMACIST_APPROVAL_REQUIRED' },
    ],
  ] as const;

  it.each(refusals)(
    'refuses the tender for %s before any payment, tender row, receipt or posting',
    async (_label, prescriptionLineId, refusal) => {
      const adapter = {
        name: 'CERTIFIED_TEST_PROVIDER',
        certified: true,
        execute: vi.fn().mockResolvedValue({ approved: true, providerRef: 'provider-1' }),
      };
      const input = {
        saleId: 'sale-1',
        deviceId: 'device-1',
        businessDate: new Date('2026-11-03T00:00:00.000Z'),
        type: 'CARD' as const,
        amountMinor: 100,
        idempotencyKey: 'rx-without-prescription',
        adapter,
      };
      const db = saleDb(rxLine(prescriptionLineId));
      db.pharmacyMoneyIdempotencyKey.findUnique.mockResolvedValue({
        id: 'idem-1',
        commandType: 'tender',
        payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        resultPayload: null,
      });
      const refused = applyPharmacyTender(db as never, scope, input);
      await expect(refused).rejects.toMatchObject(refusal);
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(db.pharmacyTender.create).not.toHaveBeenCalled();
      expect(db.pharmacySale.update).not.toHaveBeenCalled();
      expect(db.pharmacySaleEvent.create).not.toHaveBeenCalled();
      expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
      expect(postings.postTenderEntry).not.toHaveBeenCalled();
      expect(postings.postSaleLineEntry).not.toHaveBeenCalled();
    }
  );

  it.each(refusals)(
    'refuses completion for %s on every settlement path, before a receipt number is drawn',
    async (_label, prescriptionLineId, refusal) => {
      const line = rxLine(prescriptionLineId);
      const db = saleDb(line);
      await expect(
        completePaidPharmacySale(
          db as never,
          scope,
          { id: 'sale-1', lines: [line], tenders: [] } as never,
          { deviceId: 'device-1', businessDate: new Date('2026-11-03T00:00:00.000Z') }
        )
      ).rejects.toMatchObject(refusal);
      expect(batchSafety.assertSaleBatchesSellable).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.pharmacySale.update).not.toHaveBeenCalled();
    }
  );
});
