import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  reverseBookkeepingTransaction,
  postBookkeepingTransaction,
} from '@/lib/pharmacy/bookkeeping';
import {
  apSettlementPaymentKey,
  normalizeApInvoice,
  normalizePayeeKey,
  outstandingMinor,
  parseCalendarDate,
  payApInvoice,
  recordApInvoice,
  reverseApInvoice,
  reverseApSettlement,
} from './ap-invoices';
import { payApInvoiceSchema, recordApInvoiceSchema } from './ap-invoices-schema';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const scope = { organizationId: 'org_1', branchId: 'branch_1', actorId: 'owner_1' };

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
    const result = await reverseApSettlement(scoped, scope, input, NOW);
    expect(result.settlement).toMatchObject({
      status: 'REVERSED',
      reverseCommandKey: 'reverse-pay-0001',
    });
    expect(transactions[0]).toMatchObject({ status: 'REVERSED' });
    expect(entries.filter((entry) => entry.reversesEntryId)).toHaveLength(1);
    const replay = await reverseApSettlement(scoped, scope, input, NOW);
    expect(replay.replayed).toBe(true);
    await expect(
      reverseApSettlement(scoped, scope, { ...input, reason: 'Other' }, NOW)
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      reverseApSettlement(scoped, scope, { ...input, commandKey: 'reverse-pay-0002' }, NOW)
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
        NOW
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
    await expect(reverseApInvoice(scoped, scope, reverseInvoiceInput, NOW)).rejects.toMatchObject({
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
      NOW
    );
    const result = await reverseApInvoice(scoped, scope, reverseInvoiceInput, NOW);
    expect(result.invoice).toMatchObject({ status: 'REVERSED', reversalReason: 'Duplicate bill' });
    const reversal = entries.find((entry) => entry.reversesEntryId === invoice.journalEntryId)!;
    expect(reversal).toMatchObject({ sourceKind: 'PHARMACY_AP_INVOICE', sourceId: invoice.id });
    await expect(
      reverseApInvoice(
        scoped,
        scope,
        { ...reverseInvoiceInput, commandKey: 'reverse-inv-0002' },
        NOW
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
      NOW
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
      NOW
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
      NOW
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
      reverseApInvoice(scoped, scope, { ...input, at: '2026-11-05T00:00:00.000Z' }, NOW)
    ).rejects.toMatchObject({ reason: 'INVALID_DATE' });
    expect(
      entries.filter((entry) => entry.reversesEntryId === invoice.journalEntryId)
    ).toHaveLength(0);
    const result = await reverseApInvoice(
      scoped,
      scope,
      { ...input, at: '2026-11-10T00:00:00.000Z' },
      NOW
    );
    expect(result.invoice.status).toBe('REVERSED');
  });
});
