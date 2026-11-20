import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  bookkeepingJournalLines,
  closeAccountingPeriod,
  createSettlementBatch,
  pharmacyLedgerLockKey,
  postBookkeepingTransaction,
  reconcileSettlementBankLine,
  reopenAccountingPeriod,
  reverseBookkeepingTransaction,
} from './bookkeeping';

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
          organizationId: 'org-a',
          branchId: 'branch-a',
          expectedMinor: 1000,
          // DEV-918: member rows inherit organizationId from the batch through the
          // composite relation; Prisma rejects it on a nested create, so every
          // real batch creation failed while a mock accepted that shape.
          tenders: {
            create: [
              { tenderId: 'tender-1', amountMinor: 700 },
              { tenderId: 'tender-2', amountMinor: 300 },
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

describe('counter khata repayment receipts (DEV-731)', () => {
  it('refuses a journal-only reversal that would desync the khata ledger and drawer', async () => {
    const db = {
      $queryRaw: vi.fn(),
      pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacyBookkeepingTransaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'txn-1',
          status: 'POSTED',
          journalEntryId: 'entry-1',
          idempotencyKey: 'khata-repayment:abc',
          bankMatches: [],
        }),
        update: vi.fn(),
      },
      financeJournalEntry: { findFirst: vi.fn(), create: vi.fn() },
    };
    await expect(
      reverseBookkeepingTransaction(
        db as unknown as ScopedDb,
        { organizationId: 'org', branchId: 'branch', actorId: 'owner' },
        { transactionId: 'txn-1', at: new Date(), reason: 'Wrong amount', idempotencyKey: 'k' }
      )
    ).rejects.toMatchObject({ reason: 'COUNTER_KHATA_RECEIPT' });
    expect(db.pharmacyBookkeepingTransaction.update).not.toHaveBeenCalled();
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
  });
});

describe('common org+branch ledger lock (CEO-JVCORE-20261025)', () => {
  const scope = { organizationId: 'org', branchId: 'branch', actorId: 'owner' };

  function lockingDb() {
    const calls: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (sql: { strings: string[]; values: unknown[] }) => {
        calls.push(sql.strings.join('?').includes('pg_advisory_xact_lock') ? 'lock' : 'raw');
        return [];
      }),
      pharmacyAccountingPeriod: {
        findFirst: vi.fn(async () => {
          calls.push('period.findFirst');
          return null;
        }),
        create: vi.fn(async () => {
          calls.push('period.create');
          return { id: 'period' };
        }),
        update: vi.fn(),
      },
      pharmacyBookkeepingTransaction: {
        findFirst: vi.fn(async () => {
          calls.push('transaction.findFirst');
          return null;
        }),
      },
    };
    return { db, calls };
  }

  it('keys the lock on organization and branch', () => {
    expect(pharmacyLedgerLockKey(scope)).toBe('pharmacy-ledger:org:branch');
    expect(pharmacyLedgerLockKey({ ...scope, branchId: 'other' })).not.toBe(
      pharmacyLedgerLockKey(scope)
    );
  });

  it('locks the branch ledger before reading for post, reverse, close and reopen', async () => {
    const runs: Array<[string, (db: ScopedDb) => Promise<unknown>]> = [
      [
        'post',
        (db) =>
          postBookkeepingTransaction(db, scope, { ...base, kind: 'EXPENSE' }).catch(() => null),
      ],
      [
        'reverse',
        (db) =>
          reverseBookkeepingTransaction(db, scope, {
            transactionId: 't',
            at: new Date(),
            reason: 'r',
            idempotencyKey: 'k',
          }).catch(() => null),
      ],
      [
        'close',
        (db) =>
          closeAccountingPeriod(db, scope, {
            startsAt: new Date('2026-10-01T00:00:00Z'),
            endsAt: new Date('2026-11-01T00:00:00Z'),
          }),
      ],
      [
        'reopen',
        (db) => reopenAccountingPeriod(db, scope, { periodId: 'p', reason: 'r' }).catch(() => null),
      ],
    ];
    for (const [name, run] of runs) {
      const { db, calls } = lockingDb();
      await run(db as unknown as ScopedDb);
      expect(calls[0], name).toBe('lock');
      const values = db.$queryRaw.mock.calls[0]![0].values;
      expect(values, name).toEqual(['pharmacy-ledger:org:branch']);
    }
  });
});
