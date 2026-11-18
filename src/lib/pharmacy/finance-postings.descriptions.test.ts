import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { postTenderEntry, postTenderRefundEntry } from './finance-postings';

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'user' };
const at = new Date('2026-11-03T10:00:00Z');

function fakeDb(rows: { tender?: unknown; refund?: unknown }) {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'entry',
    ...data,
  }));
  const db = {
    pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyTender: { findFirst: vi.fn().mockResolvedValue(rows.tender ?? null) },
    pharmacyRefund: { findFirst: vi.fn().mockResolvedValue(rows.refund ?? null) },
    financeJournalEntry: {
      findFirst: vi.fn().mockResolvedValue(null),
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: 'entry' }),
      create,
    },
    financeJournalLine: { create: vi.fn().mockResolvedValue({}) },
  };
  return { db: db as unknown as ScopedDb, create };
}

describe('tender journal descriptions', () => {
  it.each([
    ['CASH', 'Payment received · Cash'],
    ['JAZZCASH', 'Payment received · JazzCash'],
    ['BANK_TRANSFER', 'Payment received · Bank transfer'],
  ])('names a %s tender instead of its internal ID', async (type, description) => {
    const { db, create } = fakeDb({
      tender: { id: 'cmvzinternaltender', branchId: 'branch', type, amountMinor: 5000 },
    });
    await postTenderEntry(db, scope, { tenderId: 'cmvzinternaltender', at });
    expect(create.mock.calls[0]![0].data).toMatchObject({
      sourceId: 'cmvzinternaltender',
      description,
    });
    expect(create.mock.calls[0]![0].data.description).not.toContain('cmvz');
  });

  it.each([
    ['drawer', 'CARD', 'Refund · Cash'],
    [null, 'CARD', 'Refund · Card'],
  ])(
    'names the refund tender (drawer %s, original %s)',
    async (drawerSessionId, type, description) => {
      const { db, create } = fakeDb({
        refund: {
          id: 'cmvzinternalrefund',
          branchId: 'branch',
          amountMinor: 5000,
          drawerSessionId,
          originalTenderId: 'cmvzinternaltender',
          originalTender: { type },
        },
      });
      await postTenderRefundEntry(db, scope, { refundId: 'cmvzinternalrefund', at });
      expect(create.mock.calls[0]![0].data).toMatchObject({
        sourceId: 'cmvzinternalrefund',
        description,
      });
      expect(create.mock.calls[0]![0].data.description).not.toContain('cmvz');
    }
  );
});
