import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { classifyCashEvidence, loadCashFlowProjection, type CashFlowEvidence } from './cash-flow';

const evidence = (
  sourceKind: string,
  sourceDetail: string | null,
  lines: CashFlowEvidence['lines']
): CashFlowEvidence => ({
  id: 'entry',
  sourceKind,
  sourceId: 'source',
  sourceDetail,
  description: 'test',
  currency: 'PKR',
  occurredAt: new Date('2026-10-01T00:00:00Z'),
  reversesEntryId: null,
  lines,
});
const debit = (accountCode: string, amountMinor: bigint) => ({
  accountCode,
  amountMinor,
  side: 'DEBIT' as const,
});
const credit = (accountCode: string, amountMinor: bigint) => ({
  accountCode,
  amountMinor,
  side: 'CREDIT' as const,
});

describe('classified cash-flow policy', () => {
  it.each([
    [
      'cash sale/collection',
      evidence('PHARMACY_TENDER', null, [
        debit('CASH', BigInt(500)),
        credit('SALES_CLEARING', BigInt(500)),
      ]),
      'OPERATING',
      BigInt(500),
    ],
    [
      'customer collection',
      evidence('PHARMACY_BOOKKEEPING_TRANSACTION', 'CUSTOMER_RECEIPT', [
        debit('BANK', BigInt(700)),
        credit('ACCOUNTS_RECEIVABLE', BigInt(700)),
      ]),
      'OPERATING',
      BigInt(700),
    ],
    [
      'supplier payment',
      evidence('PHARMACY_BOOKKEEPING_TRANSACTION', 'SUPPLIER_PAYMENT', [
        debit('ACCOUNTS_PAYABLE', BigInt(300)),
        credit('BANK', BigInt(300)),
      ]),
      'OPERATING',
      BigInt(-300),
    ],
    [
      'operating expense',
      evidence('PHARMACY_BOOKKEEPING_TRANSACTION', 'EXPENSE', [
        debit('OPERATING_EXPENSE', BigInt(200)),
        credit('CASH', BigInt(200)),
      ]),
      'OPERATING',
      BigInt(-200),
    ],
    [
      'opening funding',
      evidence('PHARMACY_OPENING_LEDGER', null, [
        debit('CASH', BigInt(900)),
        credit('OPENING_BALANCE_EQUITY', BigInt(900)),
      ]),
      'FINANCING',
      BigInt(900),
    ],
    [
      'unknown future account',
      evidence('PHARMACY_TENDER', null, [
        debit('CASH', BigInt(50)),
        credit('FUTURE_ACCOUNT', BigInt(50)),
      ]),
      'UNCLASSIFIED',
      BigInt(50),
    ],
    [
      'mixed counterpart',
      evidence('PHARMACY_TENDER', null, [
        debit('CASH', BigInt(100)),
        credit('SALES_CLEARING', BigInt(80)),
        credit('FUTURE_ACCOUNT', BigInt(20)),
      ]),
      'UNCLASSIFIED',
      BigInt(100),
    ],
  ])('%s is conservative and integer safe', (_name, entry, classification, netMinor) =>
    expect(classifyCashEvidence(entry)).toMatchObject({ classification, netMinor })
  );

  it('nets a cash-to-bank transfer to zero', () =>
    expect(
      classifyCashEvidence(
        evidence('PHARMACY_BOOKKEEPING_TRANSACTION', 'BANK_DEPOSIT', [
          debit('BANK', BigInt(2) ** BigInt(60)),
          credit('CASH', BigInt(2) ** BigInt(60)),
        ])
      )
    ).toMatchObject({ netMinor: BigInt(0) }));
  it('excludes a noncash journal entry', () =>
    expect(
      classifyCashEvidence(
        evidence('PHARMACY_SALE_LINE', null, [
          debit('SALES_CLEARING', BigInt(100)),
          credit('SALES_REVENUE', BigInt(100)),
        ])
      )
    ).toMatchObject({ netMinor: BigInt(0) }));
  it('preserves reversal direction and link evidence', () => {
    const original = evidence('PHARMACY_TENDER', null, [
      debit('CASH', BigInt(100)),
      credit('SALES_CLEARING', BigInt(100)),
    ]);
    const reversal = {
      ...original,
      id: 'reversal',
      reversesEntryId: original.id,
      lines: [credit('CASH', BigInt(100)), debit('SALES_CLEARING', BigInt(100))],
    };
    expect(classifyCashEvidence(reversal)).toMatchObject({
      classification: 'OPERATING',
      netMinor: BigInt(-100),
    });
    expect(reversal.reversesEntryId).toBe('entry');
  });
});

describe('cash-flow loader reconciliation', () => {
  const from = new Date('2026-10-01T00:00:00Z');
  const to = new Date('2026-11-01T00:00:00Z');
  const scope = { organizationId: 'org', branchId: 'branch' };
  const raw = (entry: CashFlowEvidence) => ({
    ...entry,
    occurredAt: entry.occurredAt.toISOString(),
    lines: entry.lines.map((line) => ({ ...line, amountMinor: String(line.amountMinor) })),
  });
  const load = (
    snapshot: { balances: unknown; evidence: unknown },
    controls: Array<{ accountCode: string; currency: string; closingMinor: string }>
  ) => {
    const queryRaw = vi.fn().mockResolvedValueOnce([snapshot]);
    return {
      queryRaw,
      result: loadCashFlowProjection(
        { $queryRaw: queryRaw } as unknown as ScopedDb,
        scope,
        { from, to },
        controls
      ),
    };
  };

  it('reads one bounded snapshot and reports a canonical-control mismatch', async () => {
    const { queryRaw, result } = load(
      {
        balances: [{ currency: 'PKR', opening: '0' }],
        evidence: [
          raw({
            ...evidence('PHARMACY_TENDER', null, [
              debit('CASH', BigInt(100)),
              credit('SALES_CLEARING', BigInt(100)),
            ]),
            occurredAt: from,
          }),
        ],
      },
      [
        { accountCode: 'CASH', currency: 'PKR', closingMinor: '60' },
        { accountCode: 'BANK', currency: 'PKR', closingMinor: '43' },
        { accountCode: 'SALES_CLEARING', currency: 'PKR', closingMinor: '-100' },
      ]
    );
    const projection = await result;

    expect(queryRaw).toHaveBeenCalledOnce();
    const sql = (queryRaw.mock.calls[0][0] as { sql: string }).sql;
    expect(sql).toMatch(/"accountCode" IN \('CASH','BANK'\)/);
    expect(sql).toMatch(/m\.net<>0/);
    expect(projection.period.bounds).toBe('[from,to)');
    expect(projection.evidence[0].occurredAt).toEqual(from);
    expect(projection.totals[0]).toMatchObject({
      opening: BigInt(0),
      operating: BigInt(100),
      closing: BigInt(100),
      canonicalClosing: BigInt(103),
      discrepancy: BigInt(3),
    });
  });

  it('keeps currencies separate and integer safe beyond Number precision', async () => {
    const huge = BigInt(2) ** BigInt(60);
    const { result } = load(
      {
        balances: [
          { currency: 'USD', opening: huge.toString() },
          { currency: 'PKR', opening: '5' },
        ],
        evidence: [
          raw({
            ...evidence('PHARMACY_TENDER', null, [
              debit('CASH', huge + BigInt(1)),
              credit('SALES_CLEARING', huge + BigInt(1)),
            ]),
            id: 'usd',
            currency: 'USD',
          }),
          raw({
            ...evidence('PHARMACY_OPENING_LEDGER', null, [
              debit('BANK', BigInt(7)),
              credit('OPENING_BALANCE_EQUITY', BigInt(7)),
            ]),
            id: 'pkr',
          }),
        ],
      },
      [
        {
          accountCode: 'CASH',
          currency: 'USD',
          closingMinor: (huge * BigInt(2) + BigInt(1)).toString(),
        },
        { accountCode: 'BANK', currency: 'PKR', closingMinor: '12' },
      ]
    );
    const { totals } = await result;
    expect(totals.map((row) => row.currency)).toEqual(['PKR', 'USD']);
    expect(totals[0]).toMatchObject({
      opening: BigInt(5),
      financing: BigInt(7),
      discrepancy: BigInt(0),
    });
    expect(totals[1]).toMatchObject({
      opening: huge,
      operating: huge + BigInt(1),
      closing: huge * BigInt(2) + BigInt(1),
      discrepancy: BigInt(0),
    });
  });

  it('shows a canonical-only currency as a discrepancy rather than hiding it', async () => {
    const { result } = load({ balances: null, evidence: null }, [
      { accountCode: 'CASH', currency: 'USD', closingMinor: '9' },
    ]);
    expect((await result).totals).toEqual([
      expect.objectContaining({ currency: 'USD', closing: BigInt(0), discrepancy: BigInt(9) }),
    ]);
  });
});
