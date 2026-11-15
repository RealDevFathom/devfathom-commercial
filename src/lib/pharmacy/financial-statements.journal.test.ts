import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { financialStatements } from './financial-statements';

describe('financial statement journal titles', () => {
  it('names refunds by payment method and lots by medicine and batch', async () => {
    const refundFindMany = vi.fn(async () => [
      { id: 'refund_1', drawerSessionId: null, originalTender: { type: 'CASH' } },
      // Card refund paid out of the cash drawer (manual cash fallback) is posted to CASH.
      { id: 'refund_2', drawerSessionId: 'drawer_1', originalTender: { type: 'CARD' } },
      { id: 'refund_3', drawerSessionId: null, originalTender: { type: 'CARD' } },
    ]);
    const lotFindMany = vi.fn(async () => [
      { id: 'lot_1', batch: { batchNumber: 'B12', medicine: { productName: 'Panadol' } } },
    ]);
    const db = {
      $queryRaw: vi.fn(async () => []),
      financeJournalEntry: {
        findMany: vi.fn(async () => [
          {
            id: 'entry_1',
            sourceKind: 'PHARMACY_REFUND',
            sourceId: 'refund_1',
            description: 'Refund of tender cmvz1abcdefghijklmnopqrst',
            currency: 'PKR',
            occurredAt: new Date('2026-11-01T10:00:00Z'),
            reversesEntryId: null,
            lines: [
              { id: 'l1', accountCode: 'CASH', side: 'CREDIT', amountMinor: 100, lotId: null },
            ],
          },
          ...['refund_2', 'refund_3'].map((sourceId, index) => ({
            id: `entry_r${index}`,
            sourceKind: 'PHARMACY_REFUND',
            sourceId,
            description: 'Refund of tender cmvz1abcdefghijklmnopqrst',
            currency: 'PKR',
            occurredAt: new Date('2026-11-01T09:30:00Z'),
            reversesEntryId: null,
            lines: [],
          })),
          {
            id: 'entry_2',
            sourceKind: 'PHARMACY_SALE_LINE',
            sourceId: 'line_1',
            description: 'Sale line cmvz1abcdefghijklmnopqrst',
            currency: 'PKR',
            occurredAt: new Date('2026-11-01T09:00:00Z'),
            reversesEntryId: null,
            lines: [
              {
                id: 'l2',
                accountCode: 'INVENTORY',
                side: 'CREDIT',
                amountMinor: 60,
                lotId: 'lot_1',
              },
            ],
          },
        ]),
        count: vi.fn(async () => 2),
      },
      pharmacyRefund: { findMany: refundFindMany },
      pharmacyTender: { findMany: vi.fn(async () => []) },
      pharmacyInventoryLot: { findMany: lotFindMany },
    } as unknown as ScopedDb;
    const result = await financialStatements(
      db,
      { organizationId: 'org_1', branchId: 'branch_1' },
      { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-02T00:00:00Z'), page: 1 }
    );
    expect(result.journal.map((entry) => entry.title)).toEqual([
      'Refund · Cash',
      'Refund · Cash',
      'Refund · Card',
      'Sale',
    ]);
    expect(result.journal[0].description).toBe('Refund of tender cmvz1abcdefghijklmnopqrst');
    expect(result.journal[3].lines[0].lotLabel).toBe('Panadol · batch B12');
    expect(refundFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_1', id: { in: ['refund_1', 'refund_2', 'refund_3'] } },
      })
    );
    expect(lotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_1', id: { in: ['lot_1'] } } })
    );
  });
});
