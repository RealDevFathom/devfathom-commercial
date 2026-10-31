import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { voidSupplierExpenseInvoice, createSupplierExpenseInvoice, nativeApAgingCsv, reverseSupplierExpenseSettlement, settleSupplierExpenseInvoice, supplierExpenseAging } from './native-ap';

const postJournalEntry = vi.fn();
const reverseJournalEntry = vi.fn();
const scoped = (db: unknown) => db as ScopedDb;
const postBookkeepingTransaction = vi.fn();
const reverseBookkeepingTransaction = vi.fn();
vi.mock('@/lib/finance/journal', () => ({ postJournalEntry: (...args: unknown[]) => postJournalEntry(...args), reverseJournalEntry: (...args: unknown[]) => reverseJournalEntry(...args) }));
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
    $queryRaw: vi.fn().mockResolvedValue([]),
    auditLog: { create: vi.fn() },
    pharmacySupplier: { findFirst: vi.fn().mockResolvedValue({ id: 'supplier-a' }) },
    pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacySupplierExpenseInvoice: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: { data: Prisma.PharmacySupplierExpenseInvoiceUncheckedCreateInput }) => ({ id: 'invoice-a', ...data })),
    },
  };
}

const createInput = {
  supplierId: 'supplier-a', supplierInvoiceRef: 'UTIL-42', description: 'Electricity',
  issuedAt: new Date('2026-10-01Z'), dueAt: new Date('2026-10-31Z'),
  amountMinor: 12_500, idempotencyKey: 'create-a', lines: [{ description: 'Electricity', amountMinor: 12_500 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  postJournalEntry.mockResolvedValue({ id: 'journal-a' });
  reverseJournalEntry.mockResolvedValue({ id: 'void-journal-a' });
  postBookkeepingTransaction.mockResolvedValue({ id: 'transaction-a' });
  reverseBookkeepingTransaction.mockResolvedValue({ id: 'reversal-a' });
});

describe('native non-stock AP', () => {
  it('posts one balanced expense/payable accrual and persists its journal identity', async () => {
    const db = invoiceDb();
    const invoice = await createSupplierExpenseInvoice(scoped(db), scope, {
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
    const data = db.pharmacySupplierExpenseInvoice.create.mock.calls[0]![0].data;
    expect(data.lines).toEqual({ create: [{ description: 'Electricity', amountMinor: 12_500 }] });
    expect(data.events).toEqual({ create: { kind: 'CREATED', actorId: scope.actorId, occurredAt: new Date('2026-10-01Z') } });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      actorId: scope.actorId, targetId: invoice.id, action: 'pharmacyFinance.createExpenseInvoice',
    }) });
  });

  it('rejects a duplicate supplier/reference under a different key before journal writes', async () => {
    const db = invoiceDb();
    db.pharmacySupplierExpenseInvoice.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'existing' });
    await expect(createSupplierExpenseInvoice(scoped(db), scope, createInput)).rejects.toThrow('INVALID_STATE');
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(db.pharmacySupplierExpenseInvoice.findFirst).toHaveBeenLastCalledWith({
      where: { organizationId: scope.organizationId, supplierId: createInput.supplierId, supplierInvoiceRef: createInput.supplierInvoiceRef, status: { not: 'VOID' } },
      select: { id: true },
    });
  });

  it('takes the transaction key lock before reading a matching replay without rewriting evidence', async () => {
    const db = invoiceDb();
    db.pharmacySupplierExpenseInvoice.findFirst.mockResolvedValue({ ...createInput, id: 'existing', branchId: scope.branchId });
    const invoice = await createSupplierExpenseInvoice(scoped(db), scope, createInput);
    expect(invoice.id).toBe('existing');
    expect(db.$queryRaw.mock.calls[0]![0].strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.pharmacySupplierExpenseInvoice.findFirst.mock.invocationCallOrder[0]!);
    expect(postJournalEntry).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('propagates an audit failure so the owning transaction can roll back the invoice', async () => {
    const db = invoiceDb();
    db.auditLog.create.mockRejectedValue(new Error('audit failed'));
    await expect(createSupplierExpenseInvoice(scoped(db), scope, createInput)).rejects.toThrow('audit failed');
  });

  it('rejects mismatched line totals before journal or durable writes', async () => {
    const db = invoiceDb();
    await expect(createSupplierExpenseInvoice(scoped(db), scope, {
      supplierId: 'supplier-a', supplierInvoiceRef: 'BAD', description: 'Bad total',
      issuedAt: new Date('2026-10-01T00:00:00Z'), dueAt: new Date('2026-10-02T00:00:00Z'),
      amountMinor: 100, idempotencyKey: 'bad', lines: [{ description: 'line', amountMinor: 99 }],
    })).rejects.toThrow('INVALID_AMOUNT');
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('rejects an accrual in a closed period before journal or invoice writes', async () => {
    const db = invoiceDb();
    db.pharmacyAccountingPeriod.findFirst.mockResolvedValue({ id: 'closed-period' });
    await expect(createSupplierExpenseInvoice(scoped(db), scope, {
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
    await expect(createSupplierExpenseInvoice(scoped(db), scope, {
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
    await expect(createSupplierExpenseInvoice(scoped(db), scope, {
      supplierId: 'supplier-a', supplierInvoiceRef: 'UTIL-42', description: 'Electricity and gas',
      issuedAt: new Date('2026-10-01T00:00:00Z'), dueAt: new Date('2026-10-31T00:00:00Z'),
      amountMinor: 12_500, idempotencyKey: 'create-a', lines: [{ description: 'Electricity and gas', amountMinor: 12_500 }],
    })).rejects.toThrow('INVALID_STATE');
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('bounds historical aging by database time, window and result count', async () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const db = { $queryRaw: vi.fn().mockResolvedValueOnce([{ now }]) };
    await expect(supplierExpenseAging(scoped(db), scope, {
      from: new Date('2025-10-25T00:00:00Z'), asOf: now, limit: 200,
    })).rejects.toThrow('INVALID_STATE');
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects a payment before its invoice and performs no canonical posting', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-a', amountMinor: 100, supplierInvoiceRef: 'A', issuedAt: new Date('2026-10-02Z') }]) };
    await expect(settleSupplierExpenseInvoice(scoped(db), scope, { invoiceId: 'invoice-a', amountMinor: 100, occurredAt: new Date('2026-10-01Z'), reference: 'PAY', idempotencyKey: 'pay-a' })).rejects.toThrow('INVALID_STATE');
    expect(postBookkeepingTransaction).not.toHaveBeenCalled();
  });

  it('rejects a conflicting settlement replay after taking the invoice lock', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-a', amountMinor: 100, supplierInvoiceRef: 'A', issuedAt: new Date('2026-10-01Z') }]),
      pharmacySupplierExpenseSettlement: { findFirst: vi.fn().mockResolvedValue({ invoiceId: 'invoice-a', invoice: { branchId: 'branch-a' }, amountMinor: 99, reference: 'PAY', fundingAccount: 'BANK', occurredAt: new Date('2026-10-02Z') }) },
    };
    await expect(settleSupplierExpenseInvoice(scoped(db), scope, { invoiceId: 'invoice-a', amountMinor: 100, occurredAt: new Date('2026-10-02Z'), reference: 'PAY', idempotencyKey: 'pay-a' })).rejects.toThrow('INVALID_STATE');
  });

  it('rejects a canonical idempotency collision instead of attaching it to an invoice', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-a', amountMinor: 100, supplierInvoiceRef: 'A', issuedAt: new Date('2026-10-01Z') }]),
      pharmacySupplierExpenseSettlement: { findFirst: vi.fn().mockResolvedValue(null), aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: 0 } }) },
      pharmacyBookkeepingTransaction: { findFirst: vi.fn().mockResolvedValue({ id: 'unrelated' }) },
    };
    await expect(settleSupplierExpenseInvoice(scoped(db), scope, { invoiceId: 'invoice-a', amountMinor: 100, occurredAt: new Date('2026-10-02Z'), reference: 'PAY', idempotencyKey: 'pay-a' })).rejects.toThrow('INVALID_STATE');
    expect(postBookkeepingTransaction).not.toHaveBeenCalled();
  });

  it('records the payment actor, invoice event and targeted audit, including a partial payment', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-a', amountMinor: 100, supplierInvoiceRef: 'A', issuedAt: new Date('2026-10-01Z') }]),
      pharmacySupplierExpenseSettlement: {
        findFirst: vi.fn().mockResolvedValue(null), aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: 0 } }),
        create: vi.fn().mockResolvedValue({ id: 'settlement-a' }),
      },
      pharmacyBookkeepingTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacySupplierExpenseInvoice: { updateMany: vi.fn() },
      pharmacySupplierExpenseInvoiceEvent: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const input = { invoiceId: 'invoice-a', amountMinor: 70, occurredAt: new Date('2026-10-02Z'), reference: 'PAY', idempotencyKey: 'pay-a' };
    await settleSupplierExpenseInvoice(scoped(db), scope, input);
    expect(db.pharmacySupplierExpenseSettlement.create).toHaveBeenCalledWith({ data: expect.objectContaining({ createdByUserId: scope.actorId }) });
    expect(db.pharmacySupplierExpenseInvoiceEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      kind: 'SETTLED', actorId: scope.actorId, invoiceId: input.invoiceId, detail: 'settlement-a', occurredAt: input.occurredAt,
    }) });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      targetId: 'settlement-a', actorId: scope.actorId, action: 'pharmacyFinance.settleExpenseInvoice',
      changes: expect.objectContaining({ amountMinor: 70, bookkeepingTransactionId: 'transaction-a' }),
    }) });
    expect(db.pharmacySupplierExpenseInvoice.updateMany).not.toHaveBeenCalled();
    db.pharmacySupplierExpenseSettlement.findFirst.mockResolvedValue({ ...input, id: 'settlement-a', fundingAccount: 'BANK', invoice: { branchId: scope.branchId } });
    await settleSupplierExpenseInvoice(scoped(db), scope, input);
    expect(db.pharmacySupplierExpenseSettlement.create).toHaveBeenCalledTimes(1);
    expect(db.pharmacySupplierExpenseInvoiceEvent.create).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects reversal before settlement and leaves the canonical payment untouched', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ id: 'settlement-a', invoiceId: 'invoice-a', status: 'POSTED', occurredAt: new Date('2026-10-03Z') }]) };
    await expect(reverseSupplierExpenseSettlement(scoped(db), scope, { settlementId: 'settlement-a', reason: 'mistake', at: new Date('2026-10-02Z'), idempotencyKey: 'reverse-a' })).rejects.toThrow('INVALID_STATE');
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
    };
    await expect(reverseSupplierExpenseSettlement(scoped(db), scope, {
      settlementId: 'settlement-a', reason, at, idempotencyKey: 'reverse-a',
    })).rejects.toThrow('INVALID_STATE');
    expect(reverseBookkeepingTransaction).not.toHaveBeenCalled();
  });

  it('locks the settlement before evaluating reversal status and replay', async () => {
    const order: string[] = [];
    const db = {
      $queryRaw: vi.fn<(statement: Prisma.Sql) => Promise<unknown[]>>().mockImplementation(async () => {
        order.push('lock');
        return [{ id: 'settlement-a', invoiceId: 'invoice-a', bookkeepingTransactionId: 'transaction-a', status: 'POSTED', occurredAt: new Date('2026-10-03Z') }];
      }),
      pharmacySupplierExpenseSettlementReversal: { findFirst: vi.fn().mockImplementation(async () => { order.push('replay'); return null; }), create: vi.fn().mockResolvedValue({ id: 'reversal-a' }) },
      pharmacySupplierExpenseSettlement: { updateMany: vi.fn() },
      pharmacySupplierExpenseInvoiceEvent: { create: vi.fn() },
      auditLog: { create: vi.fn() },
      pharmacySupplierExpenseInvoice: { updateMany: vi.fn() },
    };
    await reverseSupplierExpenseSettlement(scoped(db), scope, {
      settlementId: 'settlement-a', reason: 'mistake', at: new Date('2026-10-04Z'), idempotencyKey: 'reverse-a',
    });
    expect(order).toEqual(['lock', 'replay']);
    expect(db.$queryRaw.mock.calls[0]![0].strings.join('?')).toContain('FOR UPDATE OF s');
    expect(reverseBookkeepingTransaction).toHaveBeenCalledTimes(1);
    expect(db.pharmacySupplierExpenseInvoiceEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      invoiceId: 'invoice-a', kind: 'SETTLEMENT_REVERSED', actorId: scope.actorId, detail: 'reversal-a',
    }) });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      actorId: scope.actorId, targetId: 'reversal-a', action: 'pharmacyFinance.reverseExpenseSettlement',
      changes: expect.objectContaining({ settlementId: 'settlement-a', reason: 'mistake' }),
    }) });
  });

  it('applies effective and durable cutoffs to invoices, settlements and reversals', async () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const db = { $queryRaw: vi.fn().mockResolvedValueOnce([{ now }]).mockResolvedValueOnce([]) };
    await supplierExpenseAging(scoped(db), scope, { from: new Date('2026-01-01Z'), asOf: new Date('2026-10-01Z') });
    const sql = db.$queryRaw.mock.calls[1]![0].strings.join('?');
    expect(sql).not.toContain('i."dueAt" >=');
    expect(sql).toContain('i."createdAt" <= ');
    expect(sql).toContain('s."createdAt" <= ');
    expect(sql).toContain('r."createdAt" <= ');
    expect(sql).toContain("v.kind='VOID'");
    expect(sql).toContain('v."occurredAt" <= ');
    expect(sql).toContain('v."occurredAt" <= ? AND v."createdAt" <= ? AND v."createdAt" <= ?');
    expect(sql).not.toContain("i.status <> 'VOID'");
  });

  it('anchors a current aging snapshot to database time without a due-date cutoff', async () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const db = { $queryRaw: vi.fn().mockResolvedValueOnce([{ now }]).mockResolvedValueOnce([]) };
    const report = await supplierExpenseAging(scoped(db), scope, {});
    expect(report.asOf).toEqual(now);
    expect(db.$queryRaw.mock.calls[1]![0].strings.join('?')).not.toContain('i."dueAt" >=');
  });

  it('uses an explicit issue-date filter and exposes the next page beyond the row bound', async () => {
    const now = new Date('2026-10-26T12:00:00Z');
    const from = new Date('2026-10-01Z');
    const rows = Array.from({ length: 201 }, (_, index) => ({
      id: `invoice-${index}`, dueAt: from, outstandingMinor: BigInt(100),
    }));
    const db = { $queryRaw: vi.fn().mockResolvedValueOnce([{ now }]).mockResolvedValueOnce(rows) };
    const report = await supplierExpenseAging(scoped(db), scope, { from, offset: 200 });
    expect(report.rows).toHaveLength(200);
    expect(report.pagination).toEqual({ offset: 200, limit: 200, hasMore: true, nextOffset: 400 });
    const statement = db.$queryRaw.mock.calls[1]![0] as Prisma.Sql;
    expect(statement.strings.join('?')).toContain('i."issuedAt" >= ?');
    expect(statement.values).toContain(from);
    expect(statement.values.slice(-2)).toEqual([201, 200]);
  });

  it('voids an unpaid invoice with a journal reversal, event and audit, and binds replay evidence', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-a', status: 'OPEN', issuedAt: new Date('2026-10-01Z'), journalEntryId: 'journal-a' }]),
      pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacySupplierExpenseSettlement: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacySupplierExpenseInvoice: { updateMany: vi.fn() },
      pharmacySupplierExpenseInvoiceEvent: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const input = { invoiceId: 'invoice-a', reason: 'Duplicate bill', at: new Date('2026-10-02Z'), idempotencyKey: 'void-a' };
    await expect(voidSupplierExpenseInvoice(scoped(db), scope, input)).resolves.toEqual({ id: 'invoice-a', status: 'VOID' });
    expect(reverseJournalEntry).toHaveBeenCalledWith(expect.anything(), scope, expect.objectContaining({ entryId: 'journal-a', reason: input.reason }));
    expect(db.pharmacySupplierExpenseInvoiceEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'VOID', actorId: scope.actorId }) });
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const event = db.pharmacySupplierExpenseInvoiceEvent.create.mock.calls[0]![0].data;
    db.pharmacySupplierExpenseInvoiceEvent.findFirst.mockResolvedValue(event);
    await voidSupplierExpenseInvoice(scoped(db), scope, input);
    expect(reverseJournalEntry).toHaveBeenCalledTimes(1);
    await expect(voidSupplierExpenseInvoice(scoped(db), scope, { ...input, reason: 'Changed' })).rejects.toThrow('INVALID_STATE');
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects voiding an invoice with unreversed payments before journal or audit writes', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'invoice-a', status: 'OPEN', issuedAt: new Date('2026-10-01Z') }]),
      pharmacySupplierExpenseInvoiceEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacySupplierExpenseSettlement: { findFirst: vi.fn().mockResolvedValue({ id: 'payment' }) },
    };
    await expect(voidSupplierExpenseInvoice(scoped(db), scope, { invoiceId: 'invoice-a', reason: 'mistake', at: new Date('2026-10-02Z'), idempotencyKey: 'void-a' })).rejects.toThrow('INVALID_STATE');
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it.each(['=cmd', '+cmd', '-cmd', '@cmd', '\t=cmd', '\r=cmd', '\n=cmd'])('escapes spreadsheet value %j and emits fixed native-only CSV columns', (reference) => {
    const csv = nativeApAgingCsv({
      asOf: new Date(), from: new Date(), retrievedAt: new Date(), bounds: { maxRows: 200, maxWindowDays: 366 }, pagination: { offset: 0, limit: 200, hasMore: false, nextOffset: null },
      rows: [{ id: 'i', supplierInvoiceRef: reference, description: 'Power, "October"', issuedAt: new Date('2026-10-01Z'), dueAt: new Date('2026-10-02Z'), amountMinor: 100, outstandingMinor: 100, daysPastDue: 2 }],
    });
    expect(csv).toContain(`"'${reference}"`);
    expect(csv).toContain('"Power, ""October"""');
    expect(csv.split('\r\n')).toHaveLength(3);
  });
});
