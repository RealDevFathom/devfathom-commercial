import { beforeEach, expect, it, vi } from 'vitest';
const post = vi.hoisted(() => vi.fn());
vi.mock('@/lib/finance/journal', () => ({ postJournalEntry: post }));
import { postPrepaidCash } from './prepaid-tiers';
import { postTenderEntry, postTenderRefundEntry } from './finance-postings';
import { classifyBalanceSheet } from './accounts/balance-sheet';
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' };
beforeEach(() => vi.clearAllMocks());
it('books upfront money as cash against a liability and reverses cash refunds', async () => {
  for (const amountMinor of [10000, -3000]) {
    await postPrepaidCash({} as never, scope, {
      id: 'entry-a',
      kind: amountMinor > 0 ? 'PAYMENT' : 'REFUND',
      amountMinor,
      createdAt: new Date(),
    });
    expect(post).toHaveBeenLastCalledWith(
      {},
      scope,
      expect.objectContaining({
        lines: [
          expect.objectContaining({
            accountCode: 'CASH',
            side: amountMinor > 0 ? 'DEBIT' : 'CREDIT',
            amountMinor: Math.abs(amountMinor),
          }),
          expect.objectContaining({
            accountCode: 'CUSTOMER_PREPAID',
            side: amountMinor > 0 ? 'CREDIT' : 'DEBIT',
            amountMinor: Math.abs(amountMinor),
          }),
        ],
      })
    );
  }
});
it('spends and restores customer liabilities through the wallet tender, never bank money', async () => {
  const db = {
    pharmacyTender: {
      findFirst: vi.fn(async () => ({
        id: 'tender-a',
        branchId: 'branch-a',
        type: 'WALLET',
        provider: 'CUSTOMER_PREPAID',
        amountMinor: 1000,
      })),
    },
    pharmacyRefund: {
      findFirst: vi.fn(async () => ({
        id: 'refund-a',
        branchId: 'branch-a',
        amountMinor: 500,
        originalTender: { type: 'WALLET', provider: 'CUSTOMER_PREPAID' },
      })),
    },
  };
  await postTenderEntry(db as never, scope, { tenderId: 'tender-a', at: new Date() });
  expect(post.mock.calls[0]![2].lines[0]).toMatchObject({
    accountCode: 'CUSTOMER_PREPAID',
    side: 'DEBIT',
    amountMinor: 1000,
  });
  await postTenderRefundEntry(db as never, scope, { refundId: 'refund-a', at: new Date() });
  expect(post.mock.calls[1]![2].lines[1]).toMatchObject({
    accountCode: 'CUSTOMER_PREPAID',
    side: 'CREDIT',
    amountMinor: 500,
  });
});
it('classifies the remaining prepaid amount as customer liabilities', () => {
  const [sheet] = classifyBalanceSheet([
    {
      accountCode: 'CUSTOMER_PREPAID',
      currency: 'PKR',
      openingMinor: '0',
      debitMinor: '2000',
      creditMinor: '10000',
      closingMinor: '-8000',
    },
  ]);
  expect(sheet!.liabilitiesMinor).toBe('8000');
  expect(sheet!.currentResultMinor).toBe('0');
});
