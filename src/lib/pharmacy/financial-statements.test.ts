import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { financialStatements, projectProfitAndLoss } from './financial-statements';

vi.mock('server-only', () => ({}));

const scope = { organizationId: 'organization_1', branchId: 'branch_1' };
const period = { from: new Date('2026-10-01Z'), to: new Date('2026-11-01Z'), page: 1 };
const entry = (changes: Record<string, unknown> = {}) => ({
  id: 'entry_1',
  sourceKind: 'PHARMACY_REFUND',
  sourceId: 'refund_1',
  description: 'Refund of tender tender_1',
  currency: 'PKR',
  occurredAt: new Date('2026-10-25Z'),
  reversesEntryId: null,
  lines: [{ id: 'line_1', accountCode: 'CASH', side: 'CREDIT', amountMinor: 35400, lotId: null }],
  ...changes,
});

function fixture(journal: ReturnType<typeof entry>[]) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    financeJournalEntry: {
      findMany: vi.fn().mockResolvedValue(journal),
      count: vi.fn().mockResolvedValue(journal.length),
    },
    pharmacyRefund: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'refund_1', originalTenderId: 'tender_1', originalTender: { type: 'CASH' }, sale: { receiptNumber: 123 } },
      ]),
    },
    pharmacyTender: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'tender_1', type: 'BANK_TRANSFER', sale: { receiptNumber: 124 } },
      ]),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'lot_1', supplierInvoiceRef: 'INV-12', batch: { batchNumber: 'B-100', medicine: { productName: 'Paracetamol' } } },
      ]),
    },
  };
  return { db, read: () => financialStatements(db as unknown as ScopedDb, scope, period) };
}

describe('financial statement journal labels', () => {
  it('names the refund payment method and receipt without changing recorded evidence', async () => {
    const original = entry();
    const { read } = fixture([original]);
    const result = await read();
    expect(result.journal[0]).toMatchObject({
      ...original,
      displayTitle: 'Refund · Cash',
      sourceLabel: 'Refund · Cash · Receipt 123',
      originalTenderId: 'tender_1',
    });
    expect(original.description).toBe('Refund of tender tender_1');
  });

  it('preserves custom descriptions including identifiers and reversal notes', async () => {
    const custom = 'Refund of tender tender_1 approved after customer complaint';
    const { read } = fixture([
      entry({ description: custom }),
      entry({ id: 'entry_reversal', description: 'Reversal of entry_1: operator correction', reversesEntryId: 'entry_1' }),
    ]);
    const result = await read();
    expect(result.journal.map((row) => row.displayTitle)).toEqual([
      custom,
      'Reversal of entry_1: operator correction',
    ]);
    expect(result.journal[1].reversesEntryId).toBe('entry_1');
  });

  it('uses human fallbacks for unresolved generated titles, preserving raw evidence', async () => {
    const { db, read } = fixture([entry()]);
    db.pharmacyRefund.findMany.mockResolvedValue([]);
    expect((await read()).journal[0]).toMatchObject({
      displayTitle: 'Refund', sourceLabel: 'Refund', originalTenderId: null,
      description: 'Refund of tender tender_1', sourceId: 'refund_1',
    });
  });

  it('bulk resolves payment and stock labels within organization and branch scope', async () => {
    const { db, read } = fixture([
      entry(),
      entry({ id: 'entry_2', sourceKind: 'PHARMACY_TENDER', sourceId: 'tender_1', description: 'Pharmacy tender tender_1', currency: 'USD' }),
      entry({ id: 'entry_3', sourceKind: 'PHARMACY_GOODS_RECEIPT', sourceId: 'receipt_1', description: 'Received stock', lines: [{ id: 'line_3', accountCode: 'INVENTORY', side: 'DEBIT', amountMinor: 22500, lotId: 'lot_1' }] }),
      entry({ id: 'entry_4' }),
    ]);
    const result = await read();
    for (const model of [db.pharmacyRefund, db.pharmacyTender, db.pharmacyInventoryLot]) {
      expect(model.findMany).toHaveBeenCalledTimes(1);
      expect(model.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining(scope),
      }));
    }
    expect(db.pharmacyInventoryLot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ...scope, id: { in: ['lot_1'] } },
    }));
    expect(result.journal[1]).toMatchObject({ displayTitle: 'Payment · Bank transfer', currency: 'USD' });
    expect(result.journal[2].lines[0]).toMatchObject({ lotId: 'lot_1', lotLabel: 'B-100 · Paracetamol · Receipt INV-12' });
  });

  it('does not apply payment lookup labels to another source kind with the same ID', async () => {
    const { read } = fixture([
      entry(),
      entry({ id: 'entry_other', sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION', description: 'Manual adjustment for refund_1' }),
    ]);
    expect((await read()).journal[1]).toMatchObject({
      displayTitle: 'Manual adjustment for refund_1',
      sourceLabel: 'Bookkeeping transaction',
      originalTenderId: null,
    });
  });

  it('skips all enrichment reads on an empty journal page', async () => {
    const { db, read } = fixture([]);
    expect((await read()).journal).toEqual([]);
    expect(db.pharmacyRefund.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyTender.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
  });
});

const total = (accountCode: string, currency: string, debit: bigint, credit: bigint) => ({
  accountCode,
  currency,
  opening: BigInt(0),
  debit,
  credit,
});

describe('canonical-ledger net P&L projection', () => {
  it('projects each currency from revenue, contra-revenue, and every expense account', () => {
    const result = projectProfitAndLoss([
      total('SALES_REVENUE', 'PKR', BigInt(1_000), BigInt(101_000)),
      total('SALES_DISCOUNT', 'PKR', BigInt(4_000), BigInt(500)),
      total('COST_OF_GOODS_SOLD', 'PKR', BigInt(60_000), BigInt(2_000)),
      total('INVENTORY_WRITE_OFF', 'PKR', BigInt(1_000), BigInt(0)),
      total('INVENTORY_SHRINKAGE', 'PKR', BigInt(800), BigInt(300)),
      total('OPERATING_EXPENSE', 'PKR', BigInt(10_000), BigInt(1_000)),
      total('LOYALTY_REDEMPTION', 'PKR', BigInt(1_500), BigInt(0)),
      total('CASH_OVER_SHORT', 'PKR', BigInt(200), BigInt(50)),
      total('SALES_REVENUE', 'USD', BigInt(0), BigInt(1_000)),
      total('CASH', 'PKR', BigInt(999_999), BigInt(0)),
    ]);

    expect(result.map(({ currency }) => currency)).toEqual(['PKR', 'USD']);
    expect(result[0]).toMatchObject({ currency: 'PKR', netProfitMinor: '26350' });
    expect(
      Object.fromEntries(result[0]!.rows.map((row) => [row.accountCode, row.amountMinor]))
    ).toEqual({
      SALES_REVENUE: '100000',
      SALES_DISCOUNT: '3500',
      COST_OF_GOODS_SOLD: '58000',
      INVENTORY_WRITE_OFF: '1000',
      INVENTORY_SHRINKAGE: '500',
      OPERATING_EXPENSE: '9000',
      LOYALTY_REDEMPTION: '1500',
      CASH_OVER_SHORT: '150',
    });
    expect(result[1]).toMatchObject({ currency: 'USD', netProfitMinor: '1000' });
  });

  it('nets additive reversals and preserves exact bigint money beyond safe numbers', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(10);
    expect(
      projectProfitAndLoss([
        total('SALES_REVENUE', 'PKR', BigInt(10), huge),
        total('OPERATING_EXPENSE', 'PKR', BigInt(25), BigInt(5)),
      ])[0]
    ).toMatchObject({ netProfitMinor: (huge - BigInt(30)).toString() });
  });

  it('does not invent a zero statement without canonical P&L postings', () => {
    expect(
      projectProfitAndLoss([
        total('CASH', 'PKR', BigInt(100), BigInt(0)),
        {
          accountCode: 'SALES_REVENUE',
          currency: 'PKR',
          opening: BigInt(-100),
          debit: BigInt(0),
          credit: BigInt(0),
        },
      ])
    ).toEqual([]);
  });
});
