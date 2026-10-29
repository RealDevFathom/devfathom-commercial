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
  it('uses half-open evidence and reports an independently established discrepancy', async () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-11-01T00:00:00Z');
    const rows = [
      evidence('PHARMACY_TENDER', null, [
        debit('CASH', BigInt(100)),
        credit('SALES_CLEARING', BigInt(100)),
      ]),
    ].map((entry) => ({
      ...entry,
      occurredAt: from,
      lines: entry.lines.map((line) => ({ ...line, amountMinor: String(line.amountMinor) })),
    }));
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ currency: 'PKR', closing: BigInt(103) }]);

    const result = await loadCashFlowProjection(
      { $queryRaw: queryRaw } as unknown as ScopedDb,
      { organizationId: 'org', branchId: 'branch' },
      { from, to }
    );

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(result.period.bounds).toBe('[from,to)');
    expect(result.totals[0]).toMatchObject({
      opening: BigInt(0),
      operating: BigInt(100),
      closing: BigInt(100),
      discrepancy: BigInt(3),
    });
  });
});
