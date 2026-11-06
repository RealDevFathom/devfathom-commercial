import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { financialStatements, projectProfitAndLoss } from './financial-statements';

const total = (accountCode: string, currency: string, debit: bigint, credit: bigint) => ({
  accountCode,
  currency,
  opening: BigInt(0),
  debit,
  credit,
});

describe('journal display projection', () => {
  it('enriches only scoped page entries and preserves journal evidence and amounts', async () => {
    const entries = [
      {
        id: 'e1',
        sourceKind: 'PHARMACY_SALE_LINE',
        sourceId: 'line',
        reversesEntryId: null,
        lines: [{ amountMinor: 125 }],
      },
      {
        id: 'e2',
        sourceKind: 'PHARMACY_REFUND',
        sourceId: 'refund',
        reversesEntryId: 'original',
        lines: [{ amountMinor: 75 }],
      },
      { id: 'e3', sourceKind: 'UNKNOWN', sourceId: 'missing', reversesEntryId: null, lines: [] },
    ];
    const query = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'e1', billNumber: 42, actorDisplayName: 'Ayesha' },
        { id: 'e2', billNumber: null, actorDisplayName: null },
      ]);
    const findMany = vi.fn().mockResolvedValue(entries);
    const db = {
      $queryRaw: query,
      financeJournalEntry: { findMany, count: vi.fn().mockResolvedValue(3) },
    } as unknown as ScopedDb;
    const result = await financialStatements(
      db,
      { organizationId: 'org-a', branchId: 'branch-a' },
      { from: new Date('2026-01-01'), to: new Date('2027-01-01'), page: 1 }
    );
    expect(result.journal).toEqual([
      { ...entries[0], billNumber: 42, actorDisplayName: 'Ayesha', eventLabel: 'Sale' },
      { ...entries[1], billNumber: null, actorDisplayName: null, eventLabel: 'Reversal: Refund' },
      { ...entries[2], billNumber: null, actorDisplayName: null, eventLabel: 'Journal entry' },
    ]);
    const sql = query.mock.calls[2]![0];
    expect(sql.values).toContain('org-a');
    expect(sql.values).toContain('branch-a');
    expect(sql.values).toEqual(expect.arrayContaining(['e1', 'e2', 'e3']));
    expect(sql.sql).toContain('u."organizationId"=');
    for (const alias of ['sl', 'rl', 'h', 'returned', 't', 'r', 's']) {
      expect(sql.sql).toContain(`${alias}."organizationId"=`);
      expect(sql.sql).toContain(`${alias}."branchId"=`);
    }
    expect(sql.sql).toContain('EXISTS (SELECT 1 FROM finance_journal_lines');
    expect(findMany.mock.calls[0]![0].where).toMatchObject({
      organizationId: 'org-a',
      lines: { some: { organizationId: 'org-a', branchId: 'branch-a' } },
    });
  });
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
