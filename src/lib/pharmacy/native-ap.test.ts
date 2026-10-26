import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupplierExpenseInvoice, nativeApAgingCsv, reverseSupplierExpenseSettlement, settleSupplierExpenseInvoice, supplierExpenseAging } from './native-ap';

const postJournalEntry = vi.fn();
const postBookkeepingTransaction = vi.fn();
const reverseBookkeepingTransaction = vi.fn();
vi.mock('@/lib/finance/journal', () => ({ postJournalEntry: (...args: unknown[]) => postJournalEntry(...args) }));
vi.mock('@/lib/pharmacy/bookkeeping', async (original) => {
  const actual = await original<typeof import('@/lib/pharmacy/bookkeeping')>();
  return {
    ...actual,
    postBookkeepingTransaction: (...args: unknown[]) => postBookkeepingTransaction(...args),
    reverseBookkeepingTransaction: (...args: unknown[]) => reverseBookkeepingTransaction(...args),
  };
});

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };
function invoiceDb() {
  return {
    pharmacySupplier: { findFirst: vi.fn().mockResolvedValue({ id: 'supplier-a' }) },
    pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacySupplierExpenseInvoice: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => ({ id: 'invoice-a', ...data })),
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  postJournalEntry.mockResolvedValue({ id: 'journal-a' });
  postBookkeepingTransaction.mockResolvedValue({ id: 'transaction-a' });
  reverseBookkeepingTransaction.mockResolvedValue({ id: 'reversal-a' });
});

describe('native non-stock AP', () => {
  it('posts one balanced expense/payable accrual and persists its journal identity', async () => {
    const db = invoiceDb();
    const invoice = await createSupplierExpenseInvoice(db, scope, {
      supplierId: 'supplier-a', supplierInvoiceRef: 'UTIL-42', description: 'Electricity',
      issuedAt: new Date('2026-10-01T00:00:00Z'), dueAt: new Date('2026-10-31T00:00:00Z'),
      amountMinor: 12_500, idempotencyKey: 'create-a', lines: [{ description: 'Electricity', amountMinor: 12_500 }],
    });
    const journal = postJournalEntry.mock.calls[0]![2];
    expect(journal.lines).toEqual([
      expect.objectContaining({ accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 12_500 }),
      expect.objectContaining({ accountCode: 'ACCOUNTS_PAYABLE', side: 'CREDIT', amountMinor: 12_500 }),
    ]);
    expect(invoice.journalEntryId).toBe('journal-a');
    expect(db.pharmacySupplierExpenseInvoice.create).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched line totals before journal or durable writes', async () => {
    const db = invoiceDb();
    await expect(createSupplierExpenseInvoice(db, scope, {
      supplierId: 'supplier-a', supplierInvoiceRef: 'BAD', description: 'Bad total',
      issuedAt: new Date('2026-10-01T00:00:00Z'), dueAt: new Date('2026-10-02T00:00:00Z'),
      amountMinor: 100, idempotencyKey: 'bad', lines: [{ description: 'line', amountMinor: 99 }],
    })).rejects.toThrow('INVALID_AMOUNT');
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('rejects an accrual in a closed period before journal or invoice writes', async () => {
    const db = invoiceDb();
    db.pharmacyAccountingPeriod.findFirst.mockResolvedValue({ id: 'closed-period' });
    await expect(createSupplierExpenseInvoice(db, scope, {
      supplierId: 'supplier-a', supplierInvoiceRef: 'CLOSED', description: 'October utilities',
      issuedAt: new Date('2026-10-01T00:00:00Z'), dueAt: new Date('2026-10-31T00:00:00Z'),
      amountMinor: 100, idempotencyKey: 'closed', lines: [{ description: 'Utilities', amountMinor: 100 }],
    })).rejects.toThrow('PERIOD_CLOSED');
    expect(db.pharmacyAccountingPeriod.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a', status: 'CLOSED' }),
    }));
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(db.pharmacySupplierExpenseInvoice.create).not.toHaveBeenCalled();
  });

  it('rejects an invoice replay from another branch without disclosing it', async () => {
    const db = invoiceDb();
    db.pharmacySupplierExpenseInvoice.findFirst.mockResolvedValue({
      branchId: 'branch-b', supplierId: 'supplier-a', supplierInvoiceRef: 'UTIL-42', description: 'Electricity',
      issuedAt: new Date('2026-10-01T00:00:00Z'), dueAt: new Date('2026-10-31T00:00:00Z'),
      amountMinor: 12_500, lines: [{ description: 'Electricity', amountMinor: 12_500 }],
    });
    await expect(createSupplierExpenseInvoice(db, scope, {
      supplierId: 'supplier-a', supplierInvoiceRef: 'UTIL-42', description: 'Electricity',
      issuedAt: new Date('2026-10-01T00:00:00Z'), dueAt: new Date('2026-10-31T00:00:00Z'),
      amountMinor: 12_500, idempotencyKey: 'create-a', lines: [{ description: 'Electricity', amountMinor: 12_500 }],
    })).rejects.toThrow('INVALID_STATE');
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('binds invoice replays to all durable request fields and lines', async () => {
    const db = invoiceDb();
    db.pharmacySupplierExpenseInvoice.findFirst.mockResolvedValue({
      branchId: 'branch-a', supplierId: 'supplier-a', supplierInvoiceRef: 'UTIL-42', description: 'Electricity',
      issuedAt: new Date('2026-10-01T00:00:00Z'), dueAt: new Date('2026-10-31T00:00:00Z'),
      amountMinor: 12_500, lines: [{ description: 'Electricity', amountMinor: 12_500 }],
    });
    await expect(createSupplierExpenseInvoice(db, scope, {
      supplierId: 'supplier-a', supplierInvoiceRef: 'UTIL-42', description: 'Electricity and gas',
      issuedAt: new Date('2026-10-01T00:00:00Z'), dueAt: new Date('2026-10-31T00:00:00Z'),
      amountMinor: 12_500, idempotencyKey: 'create-a', lines: [{ description: 'Electricity and gas', amountMinor: 12_500 }],
    })).rejects.toThrow('INVALID_STATE');
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('bounds historical aging by database time, window and result count', async () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const db = { $queryRaw: vi.fn().mockResolvedValueOnce([{ now }]) } as any;
    await expect(supplierExpenseAging(db, scope, {
      from: new Date('2025-10-25T00:00:00Z'), asOf: now, limit: 200,
    })).rejects.toThrow('INVALID_STATE');
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects a payment before its invoice and performs no canonical posting', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-a', amountMinor: 100, supplierInvoiceRef: 'A', issuedAt: new Date('2026-10-02Z') }]) } as any;
    await expect(settleSupplierExpenseInvoice(db, scope, { invoiceId: 'invoice-a', amountMinor: 100, occurredAt: new Date('2026-10-01Z'), reference: 'PAY', idempotencyKey: 'pay-a' })).rejects.toThrow('INVALID_STATE');
    expect(postBookkeepingTransaction).not.toHaveBeenCalled();
  });

  it('rejects a conflicting settlement replay after taking the invoice lock', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-a', amountMinor: 100, supplierInvoiceRef: 'A', issuedAt: new Date('2026-10-01Z') }]),
      pharmacySupplierExpenseSettlement: { findFirst: vi.fn().mockResolvedValue({ invoiceId: 'invoice-a', invoice: { branchId: 'branch-a' }, amountMinor: 99, reference: 'PAY', fundingAccount: 'BANK', occurredAt: new Date('2026-10-02Z') }) },
    } as any;
    await expect(settleSupplierExpenseInvoice(db, scope, { invoiceId: 'invoice-a', amountMinor: 100, occurredAt: new Date('2026-10-02Z'), reference: 'PAY', idempotencyKey: 'pay-a' })).rejects.toThrow('INVALID_STATE');
  });

  it('rejects a canonical idempotency collision instead of attaching it to an invoice', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-a', amountMinor: 100, supplierInvoiceRef: 'A', issuedAt: new Date('2026-10-01Z') }]),
      pharmacySupplierExpenseSettlement: { findFirst: vi.fn().mockResolvedValue(null), aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: 0 } }) },
      pharmacyBookkeepingTransaction: { findFirst: vi.fn().mockResolvedValue({ id: 'unrelated' }) },
    } as any;
    await expect(settleSupplierExpenseInvoice(db, scope, { invoiceId: 'invoice-a', amountMinor: 100, occurredAt: new Date('2026-10-02Z'), reference: 'PAY', idempotencyKey: 'pay-a' })).rejects.toThrow('INVALID_STATE');
    expect(postBookkeepingTransaction).not.toHaveBeenCalled();
  });

  it('rejects reversal before settlement and leaves the canonical payment untouched', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ id: 'settlement-a', invoiceId: 'invoice-a', status: 'POSTED', occurredAt: new Date('2026-10-03Z') }]) } as any;
    await expect(reverseSupplierExpenseSettlement(db, scope, { settlementId: 'settlement-a', reason: 'mistake', at: new Date('2026-10-02Z'), idempotencyKey: 'reverse-a' })).rejects.toThrow('INVALID_STATE');
    expect(reverseBookkeepingTransaction).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'different reason', at: new Date('2026-10-04Z') },
    { reason: 'mistake', at: new Date('2026-10-05Z') },
  ])('rejects reversal replays with conflicting audit evidence', async ({ reason, at }) => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{
        id: 'settlement-a', invoiceId: 'invoice-a', status: 'REVERSED',
        occurredAt: new Date('2026-10-03Z'), bookkeepingTransactionId: 'transaction-a',
      }]),
      pharmacySupplierExpenseSettlementReversal: { findFirst: vi.fn().mockResolvedValue({
        settlementId: 'settlement-a', reason: 'mistake', reversedAt: new Date('2026-10-04Z'),
      }) },
    } as any;
    await expect(reverseSupplierExpenseSettlement(db, scope, {
      settlementId: 'settlement-a', reason, at, idempotencyKey: 'reverse-a',
    })).rejects.toThrow('INVALID_STATE');
    expect(reverseBookkeepingTransaction).not.toHaveBeenCalled();
  });

  it('locks the settlement before evaluating reversal status and replay', async () => {
    const order: string[] = [];
    const db = {
      $queryRaw: vi.fn().mockImplementation(async () => {
        order.push('lock');
        return [{ id: 'settlement-a', invoiceId: 'invoice-a', bookkeepingTransactionId: 'transaction-a', status: 'POSTED', occurredAt: new Date('2026-10-03Z') }];
      }),
      pharmacySupplierExpenseSettlementReversal: { findFirst: vi.fn().mockImplementation(async () => { order.push('replay'); return null; }), create: vi.fn().mockResolvedValue({ id: 'reversal-a' }) },
      pharmacySupplierExpenseSettlement: { updateMany: vi.fn() },
      pharmacySupplierExpenseInvoice: { updateMany: vi.fn() },
    } as any;
    await reverseSupplierExpenseSettlement(db, scope, {
      settlementId: 'settlement-a', reason: 'mistake', at: new Date('2026-10-04Z'), idempotencyKey: 'reverse-a',
    });
    expect(order).toEqual(['lock', 'replay']);
    expect(db.$queryRaw.mock.calls[0]![0].strings.join('?')).toContain('FOR UPDATE OF s');
    expect(reverseBookkeepingTransaction).toHaveBeenCalledTimes(1);
  });

  it('applies effective and durable cutoffs to invoices, settlements and reversals', async () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const db = { $queryRaw: vi.fn().mockResolvedValueOnce([{ now }]).mockResolvedValueOnce([]) } as any;
    await supplierExpenseAging(db, scope, { from: new Date('2026-01-01Z'), asOf: new Date('2026-10-01Z') });
    const sql = db.$queryRaw.mock.calls[1]![0].strings.join('?');
    expect(sql).toContain('i."createdAt" <= ');
    expect(sql).toContain('s."createdAt" <= ');
    expect(sql).toContain('r."createdAt" <= ');
    expect(sql).toContain("v.kind='VOID'");
    expect(sql).toContain('v."occurredAt" <= ');
    expect(sql).toContain('v."occurredAt" <= ? AND v."createdAt" <= ? AND v."createdAt" <= ?');
    expect(sql).not.toContain("i.status <> 'VOID'");
  });

  it('escapes spreadsheet values and emits fixed native-only CSV columns', () => {
    const csv = nativeApAgingCsv({
      asOf: new Date(), from: new Date(), retrievedAt: new Date(), bounds: { maxRows: 200, maxWindowDays: 366 },
      rows: [{ id: 'i', supplierInvoiceRef: '=cmd', description: 'Power, "October"', issuedAt: new Date('2026-10-01Z'), dueAt: new Date('2026-10-02Z'), amountMinor: 100, outstandingMinor: 100, daysPastDue: 2 }],
    });
    expect(csv).toContain('"Power, ""October"""');
    expect(csv.split('\r\n')).toHaveLength(3);
  });
});
