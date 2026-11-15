import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postBookkeepingTransaction } from './bookkeeping';
import { settleFamilyKhata } from './family-khata';
import { earnCollectedKhata } from './loyalty-collection';
import { postJournalEntry } from '@/lib/finance/journal';
vi.mock('./family-khata', () => ({ settleFamilyKhata: vi.fn() }));
vi.mock('./loyalty-collection', () => ({
  earnCollectedKhata: vi.fn(),
  reverseCollectedKhata: vi.fn(),
}));
vi.mock('@/lib/finance/journal', () => ({
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
}));
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' };
const input = {
  kind: 'CUSTOMER_RECEIPT' as const,
  amountMinor: 100_000,
  reference: 'receipt',
  occurredAt: new Date(),
  idempotencyKey: 'receipt-key',
  allocations: [
    {
      sourceKind: 'CUSTOMER_KHATA' as const,
      sourceId: 'family-a',
      sourceReference: 'family',
      amountMinor: 100_000,
    },
  ],
};
function fixture() {
  return {
    $queryRaw: vi.fn(),
    pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyBookkeepingTransaction: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'receipt-a' }),
      update: vi.fn(),
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(postJournalEntry).mockResolvedValue({ id: 'journal-a' } as never);
  vi.mocked(settleFamilyKhata).mockResolvedValue({ allocations: [{ id: 'payment-a' }] } as never);
});
describe('DEV-746 real customer receipt earning', () => {
  it('posts money and allocates Khata before earning on the persisted payment', async () => {
    const db = fixture();
    await postBookkeepingTransaction(db as never, scope, input);
    expect(settleFamilyKhata).toHaveBeenCalledWith(db, scope, {
      familyAccountId: 'family-a',
      amountMinor: 100_000,
      occurredAt: input.occurredAt,
      collectionId: 'receipt-a',
    });
    expect(earnCollectedKhata).toHaveBeenCalledWith(db, scope, 'payment-a', 'receipt-a');
    expect(vi.mocked(postJournalEntry).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(earnCollectedKhata).mock.invocationCallOrder[0]!
    );
  });
  it('does not allocate or earn again on receipt replay', async () => {
    const db = fixture();
    db.pharmacyBookkeepingTransaction.findFirst.mockResolvedValue({ id: 'receipt-a' });
    await postBookkeepingTransaction(db as never, scope, input);
    expect(settleFamilyKhata).not.toHaveBeenCalled();
    expect(earnCollectedKhata).not.toHaveBeenCalled();
  });
  it('never treats a non-receipt as a Khata collection', async () => {
    const db = fixture();
    await expect(
      postBookkeepingTransaction(db as never, scope, { ...input, kind: 'EXPENSE' })
    ).rejects.toMatchObject({ reason: 'INVALID_ALLOCATION' });
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(earnCollectedKhata).not.toHaveBeenCalled();
  });
});
