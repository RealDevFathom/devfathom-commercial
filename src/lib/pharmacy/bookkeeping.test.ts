import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { bookkeepingJournalLines, createSettlementBatch, reconcileSettlementBankLine } from './bookkeeping';

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

describe('#710 POS settlement statement matching', () => {
  const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner' };
  function matching(amountMinor = 1000) {
    const line = { id: 'line', amountMinor, statementRef: 'statement', matches: [{ amountMinor: 200 }] };
    const batch = { id: 'batch', expectedMinor: 1000, bankMatches: [{ amountMinor: 200 }] };
    const db = {
      $queryRaw: vi.fn(),
      pharmacyBankStatementLine: { findFirst: vi.fn().mockResolvedValue(line), update: vi.fn() },
      pharmacySettlementBatch: { findFirst: vi.fn().mockResolvedValue(batch), update: vi.fn() },
      pharmacyBankReconciliation: { create: vi.fn().mockResolvedValue({ id: 'match' }) },
    };
    return { db, scoped: db as unknown as ScopedDb };
  }
  it('counts active allocations, caps both sides and marks the batch settled without posting money', async () => {
    const { db, scoped } = matching();
    await reconcileSettlementBankLine(scoped, scope, { statementLineId: 'line', settlementBatchId: 'batch', amountMinor: 800 });
    expect(db.pharmacyBankReconciliation.create).toHaveBeenCalledWith({ data: { organizationId: 'org-a', statementLineId: 'line', settlementBatchId: 'batch', amountMinor: 800, matchedByUserId: 'owner' } });
    expect(db.pharmacyBankStatementLine.update).toHaveBeenCalledWith({ where: { id: 'line' }, data: { status: 'MATCHED' } });
    expect(db.pharmacySettlementBatch.update).toHaveBeenCalledWith({ where: { id: 'batch' }, data: expect.objectContaining({ settledMinor: 1000, settledAt: expect.any(Date) }) });
    expect(db.pharmacySettlementBatch.findFirst).toHaveBeenCalledWith({ where: { organizationId: 'org-a', branchId: 'branch-a', id: 'batch' }, include: { bankMatches: { where: { reversedAt: null } } } });
  });
  it.each([[1000, 801], [500, 301], [-1000, 100]])('rejects over-allocation or a debit statement (%s, %s)', async (lineAmount, amountMinor) => {
    const { db, scoped } = matching(lineAmount);
    await expect(reconcileSettlementBankLine(scoped, scope, { statementLineId: 'line', settlementBatchId: 'batch', amountMinor })).rejects.toMatchObject({ reason: 'RECONCILIATION_MISMATCH' });
    expect(db.pharmacyBankReconciliation.create).not.toHaveBeenCalled();
  });
  it('refuses a missing or inaccessible branch target', async () => {
    const { db, scoped } = matching();
    db.pharmacySettlementBatch.findFirst.mockResolvedValue(null);
    await expect(reconcileSettlementBankLine(scoped, scope, { statementLineId: 'line', settlementBatchId: 'batch', amountMinor: 100 })).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(db.pharmacyBankReconciliation.create).not.toHaveBeenCalled();
  });
});
