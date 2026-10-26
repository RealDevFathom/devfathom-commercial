import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupplierExpenseInvoice, nativeApAgingCsv, supplierExpenseAging } from './native-ap';

const postJournalEntry = vi.fn();
vi.mock('@/lib/finance/journal', () => ({ postJournalEntry: (...args: unknown[]) => postJournalEntry(...args) }));

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };
function invoiceDb() {
  return {
    pharmacySupplier: { findFirst: vi.fn().mockResolvedValue({ id: 'supplier-a' }) },
    pharmacySupplierExpenseInvoice: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => ({ id: 'invoice-a', ...data })),
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  postJournalEntry.mockResolvedValue({ id: 'journal-a' });
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

  it('bounds historical aging by database time, window and result count', async () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const db = { $queryRaw: vi.fn().mockResolvedValueOnce([{ now }]) } as any;
    await expect(supplierExpenseAging(db, scope, {
      from: new Date('2025-10-25T00:00:00Z'), asOf: now, limit: 200,
    })).rejects.toThrow('INVALID_STATE');
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
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
