import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  bookkeepingJournalLines,
  createSettlementBatch,
  postBookkeepingTransaction,
  reverseBookkeepingTransaction,
} from './bookkeeping';

const postJournalEntry = vi.fn();
vi.mock('@/lib/finance/journal', () => ({
  postJournalEntry: (...args: unknown[]) => postJournalEntry(...args),
}));

const base = {
  reference: 'REF-1',
  amountMinor: 1250,
  occurredAt: new Date('2026-09-02T00:00:00Z'),
  idempotencyKey: 'key-1',
} as const;

describe('pharmacy bookkeeping journal mappings', () => {
  it.each([
    ['SUPPLIER_PAYMENT', 'ACCOUNTS_PAYABLE', 'BANK'],
    ['CUSTOMER_RECEIPT', 'BANK', 'ACCOUNTS_RECEIVABLE'],
    ['EXPENSE', 'OPERATING_EXPENSE', 'BANK'],
    ['PETTY_CASH', 'OPERATING_EXPENSE', 'CASH'],
    ['BANK_DEPOSIT', 'BANK', 'CASH'],
    ['SETTLEMENT', 'BANK', 'SALES_CLEARING'],
    ['VOUCHER', 'ACCOUNTS_PAYABLE', 'BANK'],
    ['CHEQUE', 'ACCOUNTS_PAYABLE', 'BANK'],
  ] as const)('maps %s into the shared ledger', (kind, debit, credit) => {
    const lines = bookkeepingJournalLines({ ...base, kind });
    expect(lines).toEqual([
      { accountCode: debit, side: 'DEBIT', amountMinor: 1250 },
      { accountCode: credit, side: 'CREDIT', amountMinor: 1250 },
    ]);
  });

  it('rejects a generic allocation to a native AP invoice before posting a journal', async () => {
    const create = vi.fn();
    const db = {
      pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacySupplierExpenseInvoice: {
        findMany: vi.fn().mockResolvedValue([{ id: 'native-invoice-1' }]),
      },
      pharmacyBookkeepingTransaction: { findFirst: vi.fn(), create },
    } as unknown as ScopedDb;

    await expect(
      postBookkeepingTransaction(
        db,
        { organizationId: 'org-a', branchId: 'branch-a', actorId: 'accountant-a' },
        {
          ...base,
          kind: 'SUPPLIER_PAYMENT',
          allocations: [
            {
              sourceKind: 'EXPENSE',
              sourceId: 'native-invoice-1',
              sourceReference: 'UTIL-42',
              amountMinor: base.amountMinor,
            },
          ],
        }
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(create).not.toHaveBeenCalled();
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('rejects a generic reversal of a native payment before canonical status or replay reads', async () => {
    const findFirst = vi.fn();
    const db = {
      pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacySupplierExpenseSettlement: { findFirst: vi.fn().mockResolvedValue({ id: 'native-payment' }) },
      pharmacyBookkeepingTransaction: { findFirst },
    } as unknown as ScopedDb;
    await expect(reverseBookkeepingTransaction(db, {
      organizationId: 'org-a', branchId: 'branch-a', actorId: 'accountant-a',
    }, { transactionId: 'transaction-a', at: base.occurredAt, reason: 'Mistake', idempotencyKey: 'reverse' }))
      .rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('fails closed if the native payment delegate is absent', async () => {
    const findFirst = vi.fn();
    const db = {
      pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacyBookkeepingTransaction: { findFirst },
    } as unknown as ScopedDb;
    await expect(reverseBookkeepingTransaction(db, {
      organizationId: 'org-a', branchId: 'branch-a', actorId: 'accountant-a',
    }, { transactionId: 'transaction-a', at: base.occurredAt, reason: 'Mistake', idempotencyKey: 'reverse' }))
      .rejects.toThrow(TypeError);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('POS settlement batches', () => {
  it('selects tenders inside the tenant and branch and pins each amount', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'tender-1', amountMinor: 700 },
      { id: 'tender-2', amountMinor: 300 },
    ]);
    const create = vi.fn().mockResolvedValue({ id: 'batch-1' });
    const db = {
      pharmacyTender: { findMany },
      pharmacySettlementBatch: { create },
    } as unknown as ScopedDb;
    await createSettlementBatch(
      db,
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'accountant-a' },
      {
        reference: 'SET-1',
        provider: 'Wallet',
        tenderType: 'WALLET',
        businessDate: new Date('2026-09-02'),
        tenderIds: ['tender-1', 'tender-2'],
      }
    );
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        id: { in: ['tender-1', 'tender-2'] },
        type: 'WALLET',
      },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expectedMinor: 1000,
          tenders: {
            create: [
              { organizationId: 'org-a', tenderId: 'tender-1', amountMinor: 700 },
              { organizationId: 'org-a', tenderId: 'tender-2', amountMinor: 300 },
            ],
          },
        }),
        include: { tenders: true },
      })
    );
  });
});
