import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  reverseBookkeepingTransaction,
  postBookkeepingTransaction,
} from '@/lib/pharmacy/bookkeeping';
import {
  apReversalAuditRecorderId,
  apSettlementPaymentKey,
  invoiceSettlementClocks,
  normalizeApInvoice,
  normalizePayeeKey,
  outstandingMinor,
  parseCalendarDate,
  payableMinorFrom,
  payApInvoice,
  recordApInvoice,
  reverseApInvoice,
  reverseApSettlement,
  searchApReversals,
} from './ap-invoices';
import { payApInvoiceSchema, recordApInvoiceSchema } from './ap-invoices-schema';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const scope = { organizationId: 'org_1', branchId: 'branch_1', actorId: 'owner_1' };
/** The recorder reverses their own entry: allowed only because nobody else could approve. */
const SOLO = { soleApprover: async () => true, now: NOW };

const recordInput = {
  branchId: 'branch_1',
  createKey: 'create-key-0001',
  reference: 'AP-0001',
  payeeName: '  K-Electric   Ltd ',
  supplierInvoiceRef: 'KE-2026-11',
  invoiceDate: '2026-11-01',
  dueDate: '2026-11-20',
  amountMinor: 1_250_00,
  currency: 'PKR' as const,
  description: 'November electricity',
  evidenceReference: 'Bill scan 2026-11',
};

type Row = Record<string, unknown> & { id: string };

/** In-memory ledger + AP tables, enough to exercise the commands end to end. */
function memoryDb(options: { closedPeriod?: boolean } = {}) {
  const calls: string[] = [];
  const invoices: Row[] = [];
  const settlements: Row[] = [];
  const transactions: Row[] = [];
  const entries: Row[] = [];
  let seq = 0;
  const next = (prefix: string) => `${prefix}_${++seq}`;
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'in' in (value as object)) {
        return ((value as { in: unknown[] }).in ?? []).includes(row[key]);
      }
      return row[key] === value;
    });
  const withSettlements = (invoice: Row, args?: { include?: { settlements?: unknown } }) =>
    args?.include?.settlements
      ? {
          ...invoice,
          settlements: settlements.filter(
            (settlement) =>
              settlement.invoiceId === invoice.id &&
              matches(
                settlement,
                ((args.include!.settlements as { where?: Record<string, unknown> }).where ??
                  {}) as Record<string, unknown>
              )
          ),
        }
      : invoice;
  const db = {
    $queryRaw: vi.fn(async (sql: { strings: string[]; values: unknown[] }) => {
      const text = sql.strings.join('?');
      calls.push(
        text.includes('pg_advisory_xact_lock')
          ? 'ledger-lock'
          : text.includes('pharmacy_ap_invoice_settlements')
            ? 'settlement-lock'
            : text.includes('pharmacy_ap_invoices')
              ? 'invoice-lock'
              : 'raw'
      );
      return [];
    }),
    pharmacyAccountingPeriod: {
      findFirst: vi.fn(async () => (options.closedPeriod ? { id: 'closed' } : null)),
    },
    pharmacyApInvoice: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown>; include?: never }) => {
        const found = invoices.find((row) => matches(row, args.where));
        return found ? withSettlements(found, args) : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        calls.push('invoice.create');
        const row = { status: 'POSTED', reversedAt: null, reverseCommandKey: null, ...data };
        invoices.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        calls.push('invoice.update');
        const row = invoices.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    pharmacyApInvoiceSettlement: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        return settlements.find((row) => matches(row, args.where)) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Omit<Row, 'id'> }) => {
        calls.push('settlement.create');
        const row: Row = {
          status: 'ACTIVE',
          reverseCommandKey: null,
          ...data,
          id: next('settlement'),
        };
        settlements.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        calls.push('settlement.update');
        const row = settlements.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    pharmacyBookkeepingTransaction: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const found = transactions.find((row) => matches(row, args.where));
        return found ? { ...found, bankMatches: [] } : null;
      }),
      create: vi.fn(async ({ data }: { data: Row & { allocations: { create: Row[] } } }) => {
        calls.push('transaction.create');
        const { allocations, ...rest } = data;
        const row = {
          ...rest,
          id: next('txn'),
          status: 'PENDING',
          allocations: allocations.create,
        };
        transactions.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        calls.push('transaction.update');
        const row = transactions.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    pharmacyBankReconciliation: { updateMany: vi.fn() },
    pharmacyBankStatementLine: { updateMany: vi.fn() },
    financeJournalEntry: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const found = entries.find((row) => matches(row, args.where));
        return found ?? null;
      }),
      findFirstOrThrow: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const found = entries.find((row) => matches(row, args.where));
        if (!found) throw new Error('not found');
        return found;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        calls.push(`entry.create:${String(data.sourceKind)}`);
        const row = { reversesEntryId: null, ...data, id: next('entry'), lines: [] as Row[] };
        entries.push(row);
        return row;
      }),
    },
    financeJournalLine: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const entry = entries.find((row) => row.id === data.entryId)!;
        (entry.lines as Row[]).push(data);
        return data;
      }),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        for (const line of data) {
          const entry = entries.find((row) => row.id === line.entryId)!;
          (entry.lines as Row[]).push(line);
        }
        return { count: data.length };
      }),
    },
  };
  return {
    db,
    scoped: db as unknown as ScopedDb,
    calls,
    invoices,
    settlements,
    transactions,
    entries,
  };
}

const payInput = (invoiceId: string, overrides: Record<string, unknown> = {}) => ({
  branchId: 'branch_1',
  invoiceId,
  commandKey: 'pay-command-0001',
  reference: 'PAY-0001',
  amountMinor: 50_000,
  paidAt: '2026-11-10T09:00:00.000Z',
  fundingAccount: 'BANK' as const,
  ...overrides,
});

describe('AP invoice identity and validation', () => {
  it('normalizes the payee into a durable identity key', () => {
    expect(normalizePayeeKey('  K-Electric   LTD ')).toBe('k-electric ltd');
    expect(normalizePayeeKey('Ｋ-Electric Ltd')).toBe('k-electric ltd');
  });

  it('accepts only real calendar dates inside the allowed range', () => {
    expect(parseCalendarDate('2026-11-01', NOW).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    for (const bad of ['2026-02-30', '2026-1-01', '1999-12-31', '2026-11-17']) {
      expect(() => parseCalendarDate(bad, NOW), bad).toThrow('INVALID_DATE');
    }
  });

  it('refuses a due date before the invoice date or beyond the term bound', () => {
    expect(() => normalizeApInvoice({ ...recordInput, dueDate: '2026-10-31' }, NOW)).toThrow(
      'INVALID_DATE'
    );
    expect(() => normalizeApInvoice({ ...recordInput, dueDate: '2037-01-01' }, NOW)).toThrow(
      'INVALID_DATE'
    );
  });

  it('refuses non-integer, zero and oversized amounts on the server', () => {
    for (const amountMinor of [0, -1, 1.5, 1_000_000_000]) {
      expect(() => normalizeApInvoice({ ...recordInput, amountMinor }, NOW)).toThrow(
        'INVALID_AMOUNT'
      );
    }
  });

  it('wire schemas are strict and bounded', () => {
    expect(recordApInvoiceSchema.safeParse({ ...recordInput, extra: 1 }).success).toBe(false);
    expect(
      recordApInvoiceSchema.safeParse({ ...recordInput, invoiceDate: '2026-11-01T00:00:00Z' })
        .success
    ).toBe(false);
    expect(payApInvoiceSchema.safeParse(payInput('x', { fundingAccount: 'CARD' })).success).toBe(
      false
    );
    expect(payApInvoiceSchema.safeParse(payInput('x', { amountMinor: 0 })).success).toBe(false);
  });
});

describe('recordApInvoice', () => {
  it('posts exactly one canonical expense/payable entry under the ledger lock', async () => {
    const { scoped, calls, entries, invoices } = memoryDb();
    const result = await recordApInvoice(scoped, scope, recordInput, NOW);
    expect(calls[0]).toBe('ledger-lock');
    expect(result.replayed).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sourceKind: 'PHARMACY_AP_INVOICE',
      sourceId: result.invoice.id,
      idempotencyKey: `ap-invoice:${result.invoice.id}`,
      occurredAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(
      (entries[0]!.lines as Row[]).map((line) => [line.accountCode, line.side, line.amountMinor])
    ).toEqual([
      ['OPERATING_EXPENSE', 'DEBIT', 125_000],
      ['ACCOUNTS_PAYABLE', 'CREDIT', 125_000],
    ]);
    expect(invoices[0]).toMatchObject({
      payeeName: 'K-Electric Ltd',
      payeeKey: 'k-electric ltd',
      journalEntryId: entries[0]!.id,
      createdByUserId: 'owner_1',
    });
  });

  it('replays the same create key with the same payload without posting again', async () => {
    const { scoped, entries } = memoryDb();
    const first = await recordApInvoice(scoped, scope, recordInput, NOW);
    const replay = await recordApInvoice(scoped, scope, recordInput, NOW);
    expect(replay).toMatchObject({ replayed: true, invoice: { id: first.invoice.id } });
    expect(entries).toHaveLength(1);
  });

  it('refuses the same create key with a different payload or branch', async () => {
    const { scoped, entries } = memoryDb();
    await recordApInvoice(scoped, scope, recordInput, NOW);
    await expect(
      recordApInvoice(scoped, scope, { ...recordInput, amountMinor: 1 }, NOW)
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      recordApInvoice(scoped, { ...scope, branchId: 'branch_2' }, recordInput, NOW)
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    expect(entries).toHaveLength(1);
  });

  it('refuses a second live invoice with the same payee and supplier reference', async () => {
    const { scoped, entries } = memoryDb();
    await recordApInvoice(scoped, scope, recordInput, NOW);
    await expect(
      recordApInvoice(
        scoped,
        scope,
        {
          ...recordInput,
          createKey: 'create-key-0002',
          reference: 'AP-0002',
          payeeName: 'k-electric ltd',
        },
        NOW
      )
    ).rejects.toMatchObject({ reason: 'DUPLICATE_INVOICE' });
    expect(entries).toHaveLength(1);
  });

  it('refuses a duplicate internal reference', async () => {
    const { scoped } = memoryDb();
    await recordApInvoice(scoped, scope, recordInput, NOW);
    await expect(
      recordApInvoice(
        scoped,
        scope,
        { ...recordInput, createKey: 'create-key-0002', supplierInvoiceRef: 'OTHER' },
        NOW
      )
    ).rejects.toMatchObject({ reason: 'DUPLICATE_REFERENCE' });
  });

  it('maps the live-identity unique index race to DUPLICATE_INVOICE', async () => {
    const { db, scoped } = memoryDb();
    db.pharmacyApInvoice.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' })
    );
    await expect(recordApInvoice(scoped, scope, recordInput, NOW)).rejects.toMatchObject({
      reason: 'DUPLICATE_INVOICE',
    });
  });

  it('refuses an invoice dated in a closed period before posting', async () => {
    const { scoped, entries } = memoryDb({ closedPeriod: true });
    await expect(recordApInvoice(scoped, scope, recordInput, NOW)).rejects.toMatchObject({
      reason: 'PERIOD_CLOSED',
    });
    expect(entries).toHaveLength(0);
  });
});

describe('payApInvoice', () => {
  async function recorded() {
    const memory = memoryDb();
    const { invoice } = await recordApInvoice(memory.scoped, scope, recordInput, NOW);
    return { ...memory, invoice };
  }

  it('posts one canonical SUPPLIER_PAYMENT allocated to the invoice and links it natively', async () => {
    const { scoped, calls, transactions, settlements, entries, invoice } = await recorded();
    calls.length = 0;
    const result = await payApInvoice(scoped, scope, payInput(invoice.id), NOW);
    expect(calls.slice(0, 2)).toEqual(['ledger-lock', 'invoice-lock']);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      kind: 'SUPPLIER_PAYMENT',
      status: 'POSTED',
      amountMinor: 50_000,
      idempotencyKey: apSettlementPaymentKey('pay-command-0001'),
      counterpartyName: 'K-Electric Ltd',
      allocations: [
        {
          sourceKind: 'EXPENSE',
          sourceId: invoice.id,
          sourceReference: 'AP-0001',
          amountMinor: 50_000,
        },
      ],
    });
    const payment = entries.find(
      (entry) => entry.sourceKind === 'PHARMACY_BOOKKEEPING_TRANSACTION'
    )!;
    expect(
      (payment.lines as Row[]).map((line) => [line.accountCode, line.side, line.amountMinor])
    ).toEqual([
      ['ACCOUNTS_PAYABLE', 'DEBIT', 50_000],
      ['BANK', 'CREDIT', 50_000],
    ]);
    expect(settlements).toHaveLength(1);
    expect(result.settlement).toMatchObject({
      invoiceId: invoice.id,
      transactionId: transactions[0]!.id,
      amountMinor: 50_000,
      status: 'ACTIVE',
    });
  });

  it('replays the same command without a second payment and refuses a changed payload', async () => {
    const { scoped, transactions, invoice } = await recorded();
    await payApInvoice(scoped, scope, payInput(invoice.id), NOW);
    const replay = await payApInvoice(scoped, scope, payInput(invoice.id), NOW);
    expect(replay.replayed).toBe(true);
    await expect(
      payApInvoice(scoped, scope, payInput(invoice.id, { amountMinor: 1 }), NOW)
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    expect(transactions).toHaveLength(1);
  });

  it('caps payments at the exact outstanding amount', async () => {
    const { scoped, transactions, invoice } = await recorded();
    await payApInvoice(scoped, scope, payInput(invoice.id, { amountMinor: 125_000 - 1 }), NOW);
    await expect(
      payApInvoice(
        scoped,
        scope,
        payInput(invoice.id, {
          commandKey: 'pay-command-0002',
          reference: 'PAY-0002',
          amountMinor: 2,
        }),
        NOW
      )
    ).rejects.toMatchObject({ reason: 'OVERPAYMENT' });
    await payApInvoice(
      scoped,
      scope,
      payInput(invoice.id, {
        commandKey: 'pay-command-0003',
        reference: 'PAY-0003',
        amountMinor: 1,
      }),
      NOW
    );
    expect(transactions).toHaveLength(2);
  });

  it('refuses a payment dated before the invoice or in the future', async () => {
    const { scoped, transactions, invoice } = await recorded();
    await expect(
      payApInvoice(scoped, scope, payInput(invoice.id, { paidAt: '2026-10-31T23:59:59.000Z' }), NOW)
    ).rejects.toMatchObject({ reason: 'INVALID_DATE' });
    await expect(
      payApInvoice(scoped, scope, payInput(invoice.id, { paidAt: '2026-11-17T00:00:00.000Z' }), NOW)
    ).rejects.toMatchObject({ reason: 'INVALID_DATE' });
    expect(transactions).toHaveLength(0);
  });

  it('refuses paying an unknown or reversed invoice', async () => {
    const { scoped, invoice, invoices } = await recorded();
    await expect(payApInvoice(scoped, scope, payInput('missing'), NOW)).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
    invoices[0]!.status = 'REVERSED';
    await expect(payApInvoice(scoped, scope, payInput(invoice.id), NOW)).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
  });
});

describe('native reversal interlock', () => {
  async function paid() {
    const memory = memoryDb();
    const { invoice } = await recordApInvoice(memory.scoped, scope, recordInput, NOW);
    const { settlement } = await payApInvoice(memory.scoped, scope, payInput(invoice.id), NOW);
    return { ...memory, invoice, settlement };
  }

  it('the generic bookkeeping reverse refuses a native AP payment before status or replay', async () => {
    const { scoped, transactions, entries } = await paid();
    const reverse = () =>
      reverseBookkeepingTransaction(scoped, scope, {
        transactionId: transactions[0]!.id as string,
        at: NOW,
        reason: 'Wrong',
        idempotencyKey: 'generic-1',
      });
    await expect(reverse()).rejects.toMatchObject({ reason: 'NATIVE_AP_SETTLEMENT' });
    // Even once reversed natively, a generic call does not get a replayed success.
    transactions[0]!.status = 'REVERSED';
    await expect(reverse()).rejects.toMatchObject({ reason: 'NATIVE_AP_SETTLEMENT' });
    expect(entries.filter((entry) => entry.reversesEntryId)).toHaveLength(0);
  });

  it('the generic bookkeeping post refuses the reserved native payment key', async () => {
    const { scoped } = memoryDb();
    await expect(
      postBookkeepingTransaction(scoped, scope, {
        reference: 'X',
        kind: 'SUPPLIER_PAYMENT',
        amountMinor: 1,
        occurredAt: NOW,
        idempotencyKey: apSettlementPaymentKey('forged-key-1'),
      })
    ).rejects.toMatchObject({ reason: 'NATIVE_AP_SETTLEMENT' });
  });

  it('reverses a settlement through the canonical transaction exactly once and restores the balance', async () => {
    const { scoped, settlement, transactions, entries, invoice, settlements } = await paid();
    const input = {
      branchId: 'branch_1',
      settlementId: settlement.id,
      commandKey: 'reverse-pay-0001',
      reason: 'Bank rejected transfer',
      at: '2026-11-12T00:00:00.000Z',
    };
    const result = await reverseApSettlement(scoped, scope, input, SOLO);
    expect(result.settlement).toMatchObject({
      status: 'REVERSED',
      reverseCommandKey: 'reverse-pay-0001',
    });
    expect(transactions[0]).toMatchObject({ status: 'REVERSED' });
    expect(entries.filter((entry) => entry.reversesEntryId)).toHaveLength(1);
    const replay = await reverseApSettlement(scoped, scope, input, SOLO);
    expect(replay.replayed).toBe(true);
    await expect(
      reverseApSettlement(scoped, scope, { ...input, reason: 'Other' }, SOLO)
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      reverseApSettlement(scoped, scope, { ...input, commandKey: 'reverse-pay-0002' }, SOLO)
    ).rejects.toMatchObject({ reason: 'ALREADY_REVERSED' });
    expect(entries.filter((entry) => entry.reversesEntryId)).toHaveLength(1);
    expect(
      outstandingMinor({ amountMinor: invoice.amountMinor, settlements: settlements as never })
    ).toBe(125_000);
  });

  it('refuses a settlement reversal dated before the payment', async () => {
    const { scoped, settlement, transactions } = await paid();
    await expect(
      reverseApSettlement(
        scoped,
        scope,
        {
          branchId: 'branch_1',
          settlementId: settlement.id,
          commandKey: 'reverse-pay-0001',
          reason: 'Early',
          at: '2026-11-09T00:00:00.000Z',
        },
        SOLO
      )
    ).rejects.toMatchObject({ reason: 'INVALID_DATE' });
    expect(transactions[0]).toMatchObject({ status: 'POSTED' });
  });

  it('an invoice with an active settlement cannot be reversed; once settled payments are reversed it can', async () => {
    const { scoped, settlement, invoice, entries } = await paid();
    const reverseInvoiceInput = {
      branchId: 'branch_1',
      invoiceId: invoice.id,
      commandKey: 'reverse-inv-0001',
      reason: 'Duplicate bill',
      at: '2026-11-13T00:00:00.000Z',
    };
    await expect(reverseApInvoice(scoped, scope, reverseInvoiceInput, SOLO)).rejects.toMatchObject({
      reason: 'ACTIVE_SETTLEMENTS',
    });
    await reverseApSettlement(
      scoped,
      scope,
      {
        branchId: 'branch_1',
        settlementId: settlement.id,
        commandKey: 'reverse-pay-0001',
        reason: 'Duplicate bill',
        at: '2026-11-12T00:00:00.000Z',
      },
      SOLO
    );
    const result = await reverseApInvoice(scoped, scope, reverseInvoiceInput, SOLO);
    expect(result.invoice).toMatchObject({ status: 'REVERSED', reversalReason: 'Duplicate bill' });
    const reversal = entries.find((entry) => entry.reversesEntryId === invoice.journalEntryId)!;
    expect(reversal).toMatchObject({ sourceKind: 'PHARMACY_AP_INVOICE', sourceId: invoice.id });
    await expect(
      reverseApInvoice(
        scoped,
        scope,
        { ...reverseInvoiceInput, commandKey: 'reverse-inv-0002' },
        SOLO
      )
    ).rejects.toMatchObject({ reason: 'ALREADY_REVERSED' });
  });

  it('a reversed invoice frees its identity for a corrected invoice', async () => {
    const { scoped, invoice, settlement } = await paid();
    await reverseApSettlement(
      scoped,
      scope,
      {
        branchId: 'branch_1',
        settlementId: settlement.id,
        commandKey: 'reverse-pay-0001',
        reason: 'x',
        at: '2026-11-12T00:00:00.000Z',
      },
      SOLO
    );
    await reverseApInvoice(
      scoped,
      scope,
      {
        branchId: 'branch_1',
        invoiceId: invoice.id,
        commandKey: 'reverse-inv-0001',
        reason: 'x',
        at: '2026-11-12T00:00:00.000Z',
      },
      SOLO
    );
    const corrected = await recordApInvoice(
      scoped,
      scope,
      { ...recordInput, createKey: 'create-key-0002', reference: 'AP-0002' },
      NOW
    );
    expect(corrected.replayed).toBe(false);
  });
});

describe('DEV-103: who may approve a reversal', () => {
  const manager = { ...scope, actorId: 'manager_2' };
  async function paid() {
    const memory = memoryDb();
    const { invoice } = await recordApInvoice(memory.scoped, scope, recordInput, NOW);
    const { settlement } = await payApInvoice(memory.scoped, scope, payInput(invoice.id), NOW);
    return { ...memory, invoice, settlement };
  }
  const reversePay = (settlementId: string, commandKey = 'reverse-pay-0001') => ({
    branchId: 'branch_1',
    settlementId,
    commandKey,
    reason: 'Paid twice by mistake',
  });
  const reverseInv = (invoiceId: string) => ({
    branchId: 'branch_1',
    invoiceId,
    commandKey: 'reverse-inv-0001',
    reason: 'Entered against the wrong payee',
  });

  it('refuses the recorder reversing their own payment while someone else could approve; nothing moves', async () => {
    const { scoped, settlement, transactions, entries } = await paid();
    const soleApprover = vi.fn(async () => false);
    await expect(
      reverseApSettlement(scoped, scope, reversePay(settlement.id), { soleApprover, now: NOW })
    ).rejects.toMatchObject({ reason: 'SELF_APPROVAL' });
    expect(soleApprover).toHaveBeenCalledTimes(1);
    expect(transactions[0]).toMatchObject({ status: 'POSTED' });
    expect(entries.filter((entry) => entry.reversesEntryId)).toHaveLength(0);
    expect(settlement).toMatchObject({ status: 'ACTIVE' });
  });

  it('refuses the recorder reversing their own invoice while someone else could approve; nothing moves', async () => {
    const { scoped, invoice, settlement, entries } = await paid();
    await reverseApSettlement(scoped, manager, reversePay(settlement.id), {
      soleApprover: async () => false,
      now: NOW,
    });
    await expect(
      reverseApInvoice(scoped, scope, reverseInv(invoice.id), {
        soleApprover: async () => false,
        now: NOW,
      })
    ).rejects.toMatchObject({ reason: 'SELF_APPROVAL' });
    expect(invoice).toMatchObject({ status: 'POSTED' });
    expect(
      entries.filter((entry) => entry.reversesEntryId === invoice.journalEntryId)
    ).toHaveLength(0);
  });

  it('a different manager reverses without the solo rule, and is recorded as the approver', async () => {
    const { scoped, invoice, settlement } = await paid();
    const soleApprover = vi.fn(async () => false);
    const pay = await reverseApSettlement(scoped, manager, reversePay(settlement.id), {
      soleApprover,
      now: NOW,
    });
    expect(pay).toMatchObject({ policy: 'PHARMACY_AP_REVERSAL_MANAGER_PIN' });
    expect(pay.settlement).toMatchObject({
      status: 'REVERSED',
      reversedByUserId: 'manager_2',
      createdByUserId: 'owner_1',
    });
    const inv = await reverseApInvoice(scoped, manager, reverseInv(invoice.id), {
      soleApprover,
      now: NOW,
    });
    expect(inv).toMatchObject({ policy: 'PHARMACY_AP_REVERSAL_MANAGER_PIN' });
    expect(inv.invoice).toMatchObject({ status: 'REVERSED', reversedByUserId: 'manager_2' });
    expect(soleApprover).not.toHaveBeenCalled();
  });

  it('a solo owner reverses their own entries under the sole-approver policy', async () => {
    const { scoped, invoice, settlement } = await paid();
    const pay = await reverseApSettlement(scoped, scope, reversePay(settlement.id), SOLO);
    expect(pay).toMatchObject({ policy: 'PHARMACY_AP_REVERSAL_SOLE_APPROVER_PIN' });
    const inv = await reverseApInvoice(scoped, scope, reverseInv(invoice.id), SOLO);
    expect(inv).toMatchObject({ policy: 'PHARMACY_AP_REVERSAL_SOLE_APPROVER_PIN' });
  });

  it('an undated reversal takes the server clock and replays a double submit exactly once', async () => {
    const { scoped, settlement, entries, invoice, settlements } = await paid();
    const first = await reverseApSettlement(scoped, manager, reversePay(settlement.id), {
      soleApprover: async () => false,
      now: NOW,
    });
    expect(first.settlement).toMatchObject({ reversedAt: NOW });
    const later = new Date(NOW.getTime() + 5_000);
    const again = await reverseApSettlement(scoped, manager, reversePay(settlement.id), {
      soleApprover: async () => false,
      now: later,
    });
    expect(again.replayed).toBe(true);
    expect(entries.filter((entry) => entry.reversesEntryId)).toHaveLength(1);
    // The same key for another payment is a conflict, never a replay.
    await expect(
      reverseApSettlement(scoped, manager, reversePay('settlement_other'), {
        soleApprover: async () => false,
        now: later,
      })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    // The invoice owes the full amount again, exactly.
    expect(
      outstandingMinor({ amountMinor: invoice.amountMinor, settlements: settlements as never })
    ).toBe(invoice.amountMinor);
  });

  it('a reversal dated in a closed period is refused and changes nothing', async () => {
    const memory = memoryDb();
    const { invoice } = await recordApInvoice(memory.scoped, scope, recordInput, NOW);
    // The period of the reversal day closes after the invoice was recorded.
    memory.db.pharmacyAccountingPeriod.findFirst.mockResolvedValue({ id: 'closed' });
    const soleApprover = vi.fn(async () => true);
    await expect(
      reverseApInvoice(memory.scoped, scope, reverseInv(invoice.id), { soleApprover, now: NOW })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    expect(invoice).toMatchObject({ status: 'POSTED' });
    expect(memory.entries.filter((entry) => entry.reversesEntryId)).toHaveLength(0);
  });
});

describe('historical settlement timeline (two clocks)', () => {
  /** A full payment on Nov 2, reversed on Nov 10. */
  async function paidThenReversed() {
    const memory = memoryDb();
    const { invoice } = await recordApInvoice(memory.scoped, scope, recordInput, NOW);
    const { settlement } = await payApInvoice(
      memory.scoped,
      scope,
      payInput(invoice.id, { amountMinor: 125_000, paidAt: '2026-11-02T00:00:00.000Z' }),
      NOW
    );
    await reverseApSettlement(
      memory.scoped,
      scope,
      {
        branchId: 'branch_1',
        settlementId: settlement.id,
        commandKey: 'reverse-pay-0001',
        reason: 'Bank rejected transfer',
        at: '2026-11-10T00:00:00.000Z',
      },
      SOLO
    );
    return { ...memory, invoice };
  }

  it('refuses a replacement payment backdated before the reversal that freed the balance', async () => {
    const { scoped, transactions, invoice } = await paidThenReversed();
    await expect(
      payApInvoice(
        scoped,
        scope,
        payInput(invoice.id, {
          commandKey: 'pay-command-0002',
          reference: 'PAY-0002',
          amountMinor: 125_000,
          paidAt: '2026-11-05T00:00:00.000Z',
        }),
        NOW
      )
    ).rejects.toMatchObject({ reason: 'OVERPAYMENT' });
    expect(transactions).toHaveLength(1);
  });

  it('accepts the replacement payment dated on or after that reversal', async () => {
    const { scoped, transactions, invoice } = await paidThenReversed();
    await payApInvoice(
      scoped,
      scope,
      payInput(invoice.id, {
        commandKey: 'pay-command-0002',
        reference: 'PAY-0002',
        amountMinor: 125_000,
        paidAt: '2026-11-10T00:00:00.000Z',
      }),
      NOW
    );
    expect(transactions).toHaveLength(2);
  });

  it('refuses a backdated payment that would over-settle against a later active payment', async () => {
    const memory = memoryDb();
    const { invoice } = await recordApInvoice(memory.scoped, scope, recordInput, NOW);
    await payApInvoice(
      memory.scoped,
      scope,
      payInput(invoice.id, { amountMinor: 100_000, paidAt: '2026-11-12T00:00:00.000Z' }),
      NOW
    );
    await expect(
      payApInvoice(
        memory.scoped,
        scope,
        payInput(invoice.id, {
          commandKey: 'pay-command-0002',
          reference: 'PAY-0002',
          amountMinor: 25_001,
          paidAt: '2026-11-05T00:00:00.000Z',
        }),
        NOW
      )
    ).rejects.toMatchObject({ reason: 'OVERPAYMENT' });
  });

  it('refuses an invoice reversal dated before its payment reversal', async () => {
    const { scoped, invoice, entries } = await paidThenReversed();
    const input = {
      branchId: 'branch_1',
      invoiceId: invoice.id,
      commandKey: 'reverse-inv-0001',
      reason: 'Duplicate bill',
    };
    await expect(
      reverseApInvoice(scoped, scope, { ...input, at: '2026-11-05T00:00:00.000Z' }, SOLO)
    ).rejects.toMatchObject({ reason: 'INVALID_DATE' });
    expect(
      entries.filter((entry) => entry.reversesEntryId === invoice.journalEntryId)
    ).toHaveLength(0);
    const result = await reverseApInvoice(
      scoped,
      scope,
      { ...input, at: '2026-11-10T00:00:00.000Z' },
      SOLO
    );
    expect(result.invoice.status).toBe('REVERSED');
  });
});

describe('DEV-694: approved credit-note set-offs settle the bill', () => {
  const at = new Date('2026-11-15T00:00:00.000Z');
  const setOffInvoice = {
    id: 'inv_9',
    branchId: 'branch_1',
    reference: 'AP-9',
    status: 'POSTED',
    amountMinor: 100,
    invoiceDate: new Date('2026-11-01T00:00:00.000Z'),
    journalEntryId: 'entry_9',
    settlements: [],
    creditSetOffs: [{ amountMinor: 40, decidedAt: new Date('2026-11-10T00:00:00.000Z') }],
  };
  const lockedDb = () =>
    ({
      $queryRaw: vi.fn(async () => []),
      pharmacyApInvoice: {
        // The command-key replay lookup finds nothing; the locked read finds the bill.
        findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
          'reverseCommandKey' in args.where ? null : setOffInvoice
        ),
      },
      pharmacyApInvoiceSettlement: { findFirst: vi.fn(async () => null) },
    }) as unknown as ScopedDb;

  it('counts them as active settlement clocks from their approval instant', () => {
    const clocks = invoiceSettlementClocks(setOffInvoice);
    expect(payableMinorFrom({ amountMinor: 100, settlements: clocks }, at)).toBe(60);
    // A payment backdated before the set-off still cannot over-settle the bill.
    expect(
      payableMinorFrom(
        { amountMinor: 100, settlements: clocks },
        new Date('2026-11-05T00:00:00.000Z')
      )
    ).toBe(60);
  });

  it('refuses a payment above what the set-off left owing', async () => {
    await expect(
      payApInvoice(
        lockedDb(),
        scope,
        {
          branchId: 'branch_1',
          invoiceId: 'inv_9',
          commandKey: 'pay-key-0009',
          reference: 'PAY-9',
          amountMinor: 61,
          paidAt: '2026-11-15T00:00:00.000Z',
          fundingAccount: 'CASH',
        },
        NOW
      )
    ).rejects.toMatchObject({ reason: 'OVERPAYMENT' });
  });

  it('refuses to reverse a bill a credit note was set off against', async () => {
    await expect(
      reverseApInvoice(
        lockedDb(),
        scope,
        {
          branchId: 'branch_1',
          invoiceId: 'inv_9',
          commandKey: 'rev-inv-0009',
          reason: 'Duplicate',
          at: '2026-11-15T00:00:00.000Z',
        },
        SOLO
      )
    ).rejects.toMatchObject({ reason: 'ACTIVE_SETTLEMENTS' });
  });

  it('allows reversing the bill once its set-off is reversed, but not before that instant', async () => {
    const reversedInvoice = {
      ...setOffInvoice,
      creditSetOffs: [
        {
          amountMinor: 40,
          decidedAt: new Date('2026-11-10T00:00:00.000Z'),
          status: 'REVERSED',
          reversedAt: new Date('2026-11-12T00:00:00.000Z'),
        },
      ],
    };
    const db = () =>
      ({
        $queryRaw: vi.fn(async () => []),
        pharmacyApInvoice: {
          findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
            'reverseCommandKey' in args.where ? null : reversedInvoice
          ),
        },
        pharmacyAccountingPeriod: { findFirst: vi.fn(async () => null) },
      }) as unknown as ScopedDb;
    const clocks = invoiceSettlementClocks(reversedInvoice);
    // In force on 11-11, gone after its reversal on 11-12.
    expect(
      payableMinorFrom({ amountMinor: 100, settlements: clocks }, new Date('2026-11-11T00:00:00Z'))
    ).toBe(60);
    expect(
      payableMinorFrom({ amountMinor: 100, settlements: clocks }, new Date('2026-11-15T00:00:00Z'))
    ).toBe(100);
    // The bill cannot be reversed at an instant before the set-off's reversal.
    await expect(
      reverseApInvoice(
        db(),
        scope,
        {
          branchId: 'branch_1',
          invoiceId: 'inv_9',
          commandKey: 'rev-inv-0010',
          reason: 'Duplicate',
          at: '2026-11-11T00:00:00.000Z',
        },
        SOLO
      )
    ).rejects.toMatchObject({ reason: 'INVALID_DATE' });
  });
});

describe('DEV-103 apReversalAuditRecorderId', () => {
  it('reads the recorder from new entries and from entries written under the old name', () => {
    expect(apReversalAuditRecorderId({ recordedById: 'clerk_1', approverId: 'owner_1' })).toBe(
      'clerk_1'
    );
    expect(apReversalAuditRecorderId({ initiatedById: 'clerk_2', approverId: 'owner_1' })).toBe(
      'clerk_2'
    );
    expect(apReversalAuditRecorderId({ recordedById: 'clerk_1', initiatedById: 'old' })).toBe(
      'clerk_1'
    );
  });

  it('returns null for an entry without a recorder', () => {
    for (const metadata of [
      null,
      undefined,
      'x',
      [],
      {},
      { recordedById: '' },
      { initiatedById: 7 },
    ])
      expect(apReversalAuditRecorderId(metadata)).toBeNull();
  });
});

describe('DEV-103 searchApReversals', () => {
  const scope = { organizationId: 'org_1', branchId: 'branch_1' };
  const dated = new Date('2026-09-01T00:00:00.000Z');
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `inv_${String(i).padStart(2, '0')}`,
      invoiceDate: dated,
    }));
  const search = async (
    input: Parameters<typeof searchApReversals>[2],
    found = rows(0),
    beyond: { id: string } | null = null
  ) => {
    const findMany = vi.fn().mockResolvedValue(found);
    const findFirst = vi.fn().mockResolvedValue(beyond);
    const db = { pharmacyApInvoice: { findMany, findFirst } } as unknown as ScopedDb;
    const result = await searchApReversals(db, scope, input, 'Asia/Karachi');
    return { result, args: findMany.mock.calls[0]![0], findFirst };
  };
  const matching = { organizationId: 'org_1', branchId: 'branch_1', status: 'POSTED' };
  const cursor = { invoiceDate: '2026-09-05T00:00:00.000Z', id: 'inv_cursor' };
  const at = new Date(cursor.invoiceDate);

  it('reads posted invoices of this tenant and branch only, in a stable order', async () => {
    const { args, findFirst } = await search({});
    expect(args.where).toEqual(matching);
    expect(args.orderBy).toEqual([{ invoiceDate: 'desc' }, { id: 'asc' }]);
    expect(args.include).toEqual({
      settlements: { orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] },
    });
    expect(args).toMatchObject({ take: 26 });
    // DEV-967: never by position.
    expect(args).not.toHaveProperty('skip');
    expect(args).not.toHaveProperty('cursor');
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('pages by 25 from the newest page and names the row the older page starts after', async () => {
    const full = await search({}, rows(26));
    expect(full.result.invoices).toHaveLength(25);
    expect(full.result).toMatchObject({
      hasOlder: true,
      hasNewer: false,
      older: { invoiceDate: dated.toISOString(), id: 'inv_24' },
      newer: null,
    });
    const last = await search({}, rows(25));
    expect(last.result.invoices).toHaveLength(25);
    expect(last.result).toMatchObject({ hasOlder: false, older: null, newer: null });
  });

  it('DEV-967 reads the rows after an older cursor, by invoice date then id, never by offset', async () => {
    const { args, result, findFirst } = await search({ older: cursor }, rows(26), { id: 'x' });
    expect(args.where).toEqual({
      AND: [
        matching,
        { OR: [{ invoiceDate: { lt: at } }, { invoiceDate: at, id: { gt: 'inv_cursor' } }] },
      ],
    });
    expect(args.orderBy).toEqual([{ invoiceDate: 'desc' }, { id: 'asc' }]);
    expect(args).not.toHaveProperty('skip');
    expect(args).toMatchObject({ take: 26 });
    // Whether anything is newer is asked one row before this page's first row, inside the scope.
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        AND: [
          matching,
          { OR: [{ invoiceDate: { gt: dated } }, { invoiceDate: dated, id: { lt: 'inv_00' } }] },
        ],
      },
      select: { id: true },
    });
    expect(result).toMatchObject({
      hasOlder: true,
      hasNewer: true,
      older: { invoiceDate: dated.toISOString(), id: 'inv_24' },
      newer: { invoiceDate: dated.toISOString(), id: 'inv_00' },
    });
  });

  it('DEV-967 reads the rows before a newer cursor nearest first and returns them in list order', async () => {
    // Read toward the newest: the nearest row to the cursor comes back first.
    const nearestFirst = rows(26).reverse();
    const { args, result, findFirst } = await search({ newer: cursor }, nearestFirst, null);
    expect(args.where).toEqual({
      AND: [
        matching,
        { OR: [{ invoiceDate: { gt: at } }, { invoiceDate: at, id: { lt: 'inv_cursor' } }] },
      ],
    });
    expect(args.orderBy).toEqual([{ invoiceDate: 'asc' }, { id: 'desc' }]);
    expect(args).not.toHaveProperty('skip');
    // The 25 nearest rows, in list order; a 26th means a newer page exists.
    expect(result.invoices.map((row) => row.id)).toEqual(
      nearestFirst
        .slice(0, 25)
        .reverse()
        .map((row) => row.id)
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        AND: [
          matching,
          { OR: [{ invoiceDate: { lt: dated } }, { invoiceDate: dated, id: { gt: 'inv_25' } }] },
        ],
      },
      select: { id: true },
    });
    expect(result).toMatchObject({
      hasNewer: true,
      hasOlder: false,
      newer: { invoiceDate: dated.toISOString(), id: 'inv_01' },
      older: null,
    });
  });

  it('DEV-967 reports nothing either way on an empty turned page', async () => {
    const { result, findFirst } = await search({ older: cursor }, rows(0), { id: 'x' });
    expect(result).toMatchObject({
      invoices: [],
      hasOlder: false,
      hasNewer: false,
      older: null,
      newer: null,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('DEV-967 refuses a cursor each way', async () => {
    await expect(search({ older: cursor, newer: cursor })).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
  });

  it('DEV-967 matches percent, underscore and backslash as typed', async () => {
    const { args } = await search({ payee: '100%_off\\', reference: 'a_b%' });
    expect(args.where.AND).toEqual([
      { payeeName: { contains: '100\\%\\_off\\\\', mode: 'insensitive' } },
      {
        OR: [
          { reference: { contains: 'a\\_b\\%', mode: 'insensitive' } },
          { supplierInvoiceRef: { contains: 'a\\_b\\%', mode: 'insensitive' } },
        ],
      },
    ]);
  });

  it('applies every filter together, still inside the tenant and branch', async () => {
    const { args } = await search({
      payee: 'K-Elec',
      reference: 'KE-1',
      amountMinor: 23_456,
      from: '2026-08-01',
      to: '2026-09-30',
    });
    expect(args.where).toMatchObject({
      organizationId: 'org_1',
      branchId: 'branch_1',
      status: 'POSTED',
    });
    expect(args.where.AND).toEqual([
      { payeeName: { contains: 'K-Elec', mode: 'insensitive' } },
      {
        OR: [
          { reference: { contains: 'KE-1', mode: 'insensitive' } },
          { supplierInvoiceRef: { contains: 'KE-1', mode: 'insensitive' } },
        ],
      },
      {
        OR: [
          { amountMinor: 23_456 },
          { settlements: { some: { status: 'ACTIVE', amountMinor: 23_456 } } },
        ],
      },
      {
        OR: [
          {
            invoiceDate: {
              gte: new Date('2026-08-01T00:00:00.000Z'),
              lte: new Date('2026-09-30T00:00:00.000Z'),
            },
          },
          {
            settlements: {
              some: {
                status: 'ACTIVE',
                // Karachi is UTC+5: the shop's 1 August starts at 19:00 UTC the day before, and
                // its 30 September ends at 19:00 UTC on 30 September.
                paidAt: {
                  gte: new Date('2026-07-31T19:00:00.000Z'),
                  lt: new Date('2026-09-30T19:00:00.000Z'),
                },
              },
            },
          },
        ],
      },
    ]);
  });

  it('leaves an open end of the day range open', async () => {
    const { args } = await search({ from: '2026-08-01' });
    expect(args.where.AND).toEqual([
      {
        OR: [
          { invoiceDate: { gte: new Date('2026-08-01T00:00:00.000Z') } },
          {
            settlements: {
              some: { status: 'ACTIVE', paidAt: { gte: new Date('2026-07-31T19:00:00.000Z') } },
            },
          },
        ],
      },
    ]);
  });
});
