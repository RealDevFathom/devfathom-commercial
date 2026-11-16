import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('./regulatory', async (original) => ({
  ...(await original<typeof import('./regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(),
}));
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: vi.fn() }));
vi.mock('./rx-sale-gate', async (original) => ({
  ...(await original<typeof import('./rx-sale-gate')>()),
  assertRxSaleAllowed: vi.fn(),
}));
import { applyPharmacyTender, refundPharmacyTender } from './settlement';

const scope = { organizationId: 'org_period', branchId: 'branch_period', actorId: 'cashier' };

describe('DEV-877 provider preflight', () => {
  it.each(['SALE', 'REFUND'] as const)(
    'refuses %s before a provider moves money',
    async (capability) => {
      const adapter = { name: 'CERTIFIED_TEST_PROVIDER', certified: true, execute: vi.fn() };
      const common = {
        deviceId: 'device_period',
        businessDate: new Date('2026-11-16'),
        amountMinor: 100,
        idempotencyKey: 'attempt',
        adapter,
      };
      const input =
        capability === 'SALE'
          ? { ...common, saleId: 'sale', type: 'CARD' as const }
          : { ...common, originalTenderId: 'tender', reason: 'Return' };
      const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const db = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([]),
        pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue({ id: 'closed' }) },
        pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
        pharmacyMoneyIdempotencyKey: {
          findUnique: vi
            .fn()
            .mockResolvedValue({
              id: 'idem',
              commandType: capability === 'SALE' ? 'tender' : 'refund',
              payloadHash,
            }),
          update: vi.fn(),
        },
        pharmacySale: {
          findFirst: vi
            .fn()
            .mockResolvedValue(
              capability === 'SALE'
                ? {
                    id: 'sale',
                    status: 'OPEN',
                    lines: [{ quantity: 1, unitPriceMinor: 100, discountMinor: 0, medicine: {} }],
                    tenders: [],
                  }
                : null
            ),
          count: vi.fn().mockResolvedValue(1),
          update: vi.fn(),
        },
        pharmacyTender: {
          findFirst: vi
            .fn()
            .mockResolvedValue({
              id: 'tender',
              saleId: 'sale',
              type: 'CARD',
              amountMinor: 100,
              refunds: [],
              providerRef: 'charge',
              sale: { status: 'OPEN' },
            }),
          create: vi.fn(),
        },
        pharmacyRefund: { create: vi.fn() },
      };
      const work =
        capability === 'SALE'
          ? applyPharmacyTender(
              db as unknown as ScopedDb,
              scope,
              input as Parameters<typeof applyPharmacyTender>[2]
            )
          : refundPharmacyTender(
              db as unknown as ScopedDb,
              scope,
              input as Parameters<typeof refundPharmacyTender>[2]
            );
      await expect(work).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(db.pharmacyTender.create).not.toHaveBeenCalled();
      expect(db.pharmacyRefund.create).not.toHaveBeenCalled();
      expect(db.pharmacySale.update).not.toHaveBeenCalled();
    }
  );
});
