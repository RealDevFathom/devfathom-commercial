import { describe, expect, it, vi } from 'vitest';
import { loadCashFlowProjection, projectCashFlow, type CashFlowPosting } from './cash-flow';

const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`);
const row = (overrides: Partial<CashFlowPosting> = {}): CashFlowPosting => ({
  entryId: 'entry',
  sourceKind: 'PHARMACY_TENDER',
  sourceId: 'source',
  description: 'Cash collection',
  currency: 'PKR',
  occurredAt: at(10),
  createdAt: at(10),
  reversesEntryId: null,
  accountCode: 'CASH',
  side: 'DEBIT',
  amountMinor: BigInt(100),
  ...overrides,
});
const period = { from: at(5), to: at(20) };

describe('classified cash-flow projection', () => {
  it('nets CASH and BANK per entry so internal transfers and noncash entries contribute zero', () => {
    const result = projectCashFlow(
      [
        row({
          entryId: 'transfer',
          sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
          accountCode: 'CASH',
          side: 'CREDIT',
        }),
        row({
          entryId: 'transfer',
          sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
          accountCode: 'BANK',
          side: 'DEBIT',
        }),
        row({ entryId: 'noncash', accountCode: 'INVENTORY', side: 'DEBIT' }),
        row({ entryId: 'noncash', accountCode: 'ACCOUNTS_PAYABLE', side: 'CREDIT' }),
      ],
      period
    );
    expect(result[0]).toMatchObject({ movementMinor: '0', closingMinor: '0', evidence: [] });
  });

  it('classifies explicit collections/payments and leaves unknown or mixed evidence unclassified', () => {
    const postings = [
      row({ entryId: 'sale' }),
      row({ entryId: 'sale', accountCode: 'SALES_CLEARING', side: 'CREDIT' }),
      row({
        entryId: 'supplier',
        sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
        side: 'CREDIT',
        amountMinor: BigInt(40),
      }),
      row({
        entryId: 'supplier',
        sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
        accountCode: 'ACCOUNTS_PAYABLE',
        side: 'DEBIT',
        amountMinor: BigInt(40),
      }),
      row({
        entryId: 'mixed',
        sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
        amountMinor: BigInt(30),
      }),
      row({
        entryId: 'mixed',
        sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
        accountCode: 'OPERATING_EXPENSE',
        side: 'CREDIT',
        amountMinor: BigInt(20),
      }),
      row({
        entryId: 'mixed',
        sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
        accountCode: 'OPENING_BALANCE_EQUITY',
        side: 'CREDIT',
        amountMinor: BigInt(10),
      }),
      row({ entryId: 'future', sourceKind: 'FUTURE_ADAPTER', amountMinor: BigInt(9) }),
      row({
        entryId: 'future',
        sourceKind: 'FUTURE_ADAPTER',
        accountCode: 'FUTURE_ACCOUNT',
        side: 'CREDIT',
        amountMinor: BigInt(9),
      }),
    ];
    const result = projectCashFlow(postings, period)[0]!;
    expect(result).toMatchObject({
      operatingMinor: '60',
      unclassifiedMinor: '39',
      movementMinor: '99',
    });
    expect(result.evidence.filter((item) => item.category === 'UNCLASSIFIED')).toHaveLength(2);
  });

  it('classifies a balanced operating-expense payment as operating cash flow', () => {
    const result = projectCashFlow(
      [
        row({
          entryId: 'expense',
          sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
          side: 'CREDIT',
          amountMinor: BigInt(75),
        }),
        row({
          entryId: 'expense',
          sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
          accountCode: 'OPERATING_EXPENSE',
          side: 'DEBIT',
          amountMinor: BigInt(75),
        }),
      ],
      period
    )[0]!;

    expect(result).toMatchObject({
      operatingMinor: '-75',
      unclassifiedMinor: '0',
      movementMinor: '-75',
    });
    expect(result.evidence).toEqual([
      expect.objectContaining({
        category: 'OPERATING',
        netMinor: '-75',
        counterpartAccounts: ['OPERATING_EXPENSE'],
      }),
    ]);
  });

  it('fails closed for opposing allowed counterparts and branch-partial entries', () => {
    const result = projectCashFlow(
      [
        row({ entryId: 'ambiguous', sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION' }),
        row({
          entryId: 'ambiguous',
          sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
          accountCode: 'ACCOUNTS_PAYABLE',
          side: 'DEBIT',
          amountMinor: BigInt(40),
        }),
        row({
          entryId: 'ambiguous',
          sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
          accountCode: 'ACCOUNTS_RECEIVABLE',
          side: 'CREDIT',
          amountMinor: BigInt(140),
        }),
        // This represents the selected-branch slice of an entry whose remaining credit is on
        // another (or null) branch. The unexplained residual must not be classified.
        row({ entryId: 'partial', sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION' }),
        row({
          entryId: 'partial',
          sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
          accountCode: 'ACCOUNTS_PAYABLE',
          side: 'CREDIT',
          amountMinor: BigInt(60),
        }),
      ],
      period
    )[0]!;
    expect(result).toMatchObject({ operatingMinor: '0', unclassifiedMinor: '200' });
    expect(result.evidence.every((item) => item.category === 'UNCLASSIFIED')).toBe(true);
  });

  it('handles opening funding, reversals, boundaries, currencies and bigint precision', () => {
    const huge = BigInt('9007199254740993000');
    const result = projectCashFlow(
      [
        row({ entryId: 'before', occurredAt: at(4), amountMinor: huge }),
        row({
          entryId: 'opening',
          sourceKind: 'PHARMACY_OPENING_LEDGER',
          amountMinor: BigInt(500),
        }),
        row({
          entryId: 'opening',
          sourceKind: 'PHARMACY_OPENING_LEDGER',
          accountCode: 'OPENING_BALANCE_EQUITY',
          side: 'CREDIT',
          amountMinor: BigInt(500),
        }),
        row({
          entryId: 'reversal',
          side: 'CREDIT',
          amountMinor: BigInt(25),
          reversesEntryId: 'sale',
          currency: 'USD',
        }),
        row({
          entryId: 'reversal',
          accountCode: 'SALES_CLEARING',
          side: 'DEBIT',
          amountMinor: BigInt(25),
          reversesEntryId: 'sale',
          currency: 'USD',
        }),
        row({ entryId: 'at-to', occurredAt: at(20) }),
      ],
      period
    );
    expect(result.find((item) => item.currency === 'PKR')).toMatchObject({
      openingMinor: huge.toString(),
      financingMinor: '500',
      equationBalances: true,
    });
    expect(result.find((item) => item.currency === 'USD')).toMatchObject({
      operatingMinor: '-25',
      closingMinor: '-25',
    });
    expect(result.find((item) => item.currency === 'USD')!.evidence[0]!.reversesEntryId).toBe(
      'sale'
    );
  });

  it('reads more than one journal page with scope predicates and without paging', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => [
      row({ entryId: `sale-${index}` }),
      row({ entryId: `sale-${index}`, accountCode: 'SALES_CLEARING', side: 'CREDIT' }),
    ]).flat();
    const queryRaw = vi.fn().mockResolvedValue(rows);
    const result = await loadCashFlowProjection(
      { $queryRaw: queryRaw } as never,
      { organizationId: 'org-a', branchId: 'branch-a' },
      period
    );
    expect(result[0]).toMatchObject({ operatingMinor: '3000', movementMinor: '3000' });
    const query = queryRaw.mock.calls[0]![0];
    expect(query.sql).toContain('e."organizationId"=?');
    expect(query.sql).toContain('l."organizationId"=?');
    expect(query.sql).toContain('l."branchId"=?');
    expect(query.sql).not.toMatch(/LIMIT|take|skip/i);
    expect(query.values).toEqual(expect.arrayContaining(['org-a', 'branch-a']));
  });

  it('shows independent control mismatches even when opening and movement cancel', () => {
    const result = projectCashFlow(
      [
        row({ occurredAt: at(4), amountMinor: BigInt(10) }),
        row({
          occurredAt: at(4),
          accountCode: 'SALES_CLEARING',
          side: 'CREDIT',
          amountMinor: BigInt(10),
        }),
        row({ side: 'CREDIT', amountMinor: BigInt(10) }),
        row({ accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: BigInt(10) }),
      ],
      period,
      [{ currency: 'PKR', openingMinor: '0', closingMinor: '0', movementMinor: '0' }]
    )[0]!;
    expect(result).toMatchObject({
      canonicalOpeningDiscrepancyMinor: '10',
      canonicalMovementDiscrepancyMinor: '-10',
      canonicalClosingDiscrepancyMinor: '0',
      canonicalControlMatches: false,
    });
    expect(result.metadata.classifiedCompleteness).toBe('unknown');
  });

  it('shows a discrepancy for a canonical control currency without projection postings', () => {
    const result = projectCashFlow([], period, [
      { currency: 'USD', openingMinor: '100', movementMinor: '25', closingMinor: '125' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      currency: 'USD',
      openingMinor: '0',
      movementMinor: '0',
      closingMinor: '0',
      canonicalOpeningDiscrepancyMinor: '-100',
      canonicalMovementDiscrepancyMinor: '-25',
      canonicalClosingDiscrepancyMinor: '-125',
      canonicalControlMatches: false,
    });
  });
});
