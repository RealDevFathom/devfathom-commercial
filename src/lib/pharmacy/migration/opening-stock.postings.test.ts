import { afterEach, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { postOpeningLedgerEntry, postOpeningStockEntry } from '../finance-postings';
import { postOpeningLedger, postOpeningSession } from './opening-stock';

vi.mock('../finance-postings', () => ({
  postOpeningStockEntry: vi.fn(),
  postOpeningLedgerEntry: vi.fn(),
}));

const openingAt = new Date('2026-09-01T04:00:00Z');
const submittedAt = new Date('2026-10-31T12:00:00Z');
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each(['stock', 'ledger'] as const)(
  'recognizes opening %s at the opening instant while retaining its submission time',
  async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(submittedAt);
    const line = {
      id: 'line',
      sourceRef: 'legacy',
      manufacturingBatchId: 'batch',
      batchNumber: 'B-1',
      expiryDate: new Date('2027-06-01'),
      expiryPrecision: 'DAY',
      printedMrpMinor: 200,
      unitCostMinor: 100,
      stockLocationId: 'store',
      packLevelId: 'pack',
      unitsPerPack: 10,
      countedUnits: 20,
    };
    const db = {
      pharmacyOpeningSession: {
        findFirst: vi
          .fn()
          .mockResolvedValue({
            id: 'session',
            branchId: scope.branchId,
            status: 'DRAFT',
            openingAt,
          }),
        update: vi.fn(),
      },
      pharmacyOpeningStockLine: { findMany: vi.fn().mockResolvedValue([line]), update: vi.fn() },
      pharmacyInventoryLot: { create: vi.fn().mockResolvedValue({ id: 'lot' }) },
      pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement' }) },
      pharmacyOpeningTotal: { create: vi.fn().mockResolvedValue({ id: 'total' }) },
      pharmacyOpeningLedgerEntry: {
        create: vi.fn().mockResolvedValue({ id: 'ledger' }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    if (kind === 'stock') {
      await postOpeningSession(db as unknown as ScopedDb, scope, {
        sessionId: 'session',
        idempotencyKeyPrefix: 'opening',
      });
      expect(postOpeningStockEntry).toHaveBeenCalledWith(db, scope, {
        sessionId: 'session',
        at: openingAt,
      });
      expect(db.pharmacyOpeningTotal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ postedAt: submittedAt }),
      });
    } else {
      await postOpeningLedger(db as unknown as ScopedDb, scope, {
        sessionId: 'session',
        balances: [{ account: 'BANK', balanceMinor: BigInt(2000), sourceRef: 'legacy' }],
      });
      expect(postOpeningLedgerEntry).toHaveBeenCalledWith(db, scope, {
        openingLedgerEntryId: 'ledger',
        at: openingAt,
      });
      expect(db.pharmacyOpeningLedgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ postedAt: submittedAt }),
      });
    }
  }
);
