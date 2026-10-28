import { describe, expect, it } from 'vitest';
import { classifyCashEvidence, type CashFlowEvidence } from './cash-flow';

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
      evidence('PHARMACY_TENDER', null, [debit('CASH', 500n), credit('SALES_CLEARING', 500n)]),
      'OPERATING',
      500n,
    ],
    [
      'customer collection',
      evidence('PHARMACY_BOOKKEEPING_TRANSACTION', 'CUSTOMER_RECEIPT', [
        debit('BANK', 700n),
        credit('ACCOUNTS_RECEIVABLE', 700n),
      ]),
      'OPERATING',
      700n,
    ],
    [
      'supplier payment',
      evidence('PHARMACY_BOOKKEEPING_TRANSACTION', 'SUPPLIER_PAYMENT', [
        debit('ACCOUNTS_PAYABLE', 300n),
        credit('BANK', 300n),
      ]),
      'OPERATING',
      -300n,
    ],
    [
      'operating expense',
      evidence('PHARMACY_BOOKKEEPING_TRANSACTION', 'EXPENSE', [
        debit('OPERATING_EXPENSE', 200n),
        credit('CASH', 200n),
      ]),
      'OPERATING',
      -200n,
    ],
    [
      'opening funding',
      evidence('PHARMACY_OPENING_LEDGER', null, [
        debit('CASH', 900n),
        credit('OPENING_BALANCE_EQUITY', 900n),
      ]),
      'FINANCING',
      900n,
    ],
    [
      'unknown future account',
      evidence('PHARMACY_TENDER', null, [debit('CASH', 50n), credit('FUTURE_ACCOUNT', 50n)]),
      'UNCLASSIFIED',
      50n,
    ],
    [
      'mixed counterpart',
      evidence('PHARMACY_TENDER', null, [
        debit('CASH', 100n),
        credit('SALES_CLEARING', 80n),
        credit('FUTURE_ACCOUNT', 20n),
      ]),
      'UNCLASSIFIED',
      100n,
    ],
  ])('%s is conservative and integer safe', (_name, entry, classification, netMinor) =>
    expect(classifyCashEvidence(entry)).toMatchObject({ classification, netMinor })
  );

  it('nets a cash-to-bank transfer to zero', () =>
    expect(
      classifyCashEvidence(
        evidence('PHARMACY_BOOKKEEPING_TRANSACTION', 'BANK_DEPOSIT', [
          debit('BANK', 2n ** 60n),
          credit('CASH', 2n ** 60n),
        ])
      )
    ).toMatchObject({ netMinor: 0n }));
  it('excludes a noncash journal entry', () =>
    expect(
      classifyCashEvidence(
        evidence('PHARMACY_SALE_LINE', null, [
          debit('SALES_CLEARING', 100n),
          credit('SALES_REVENUE', 100n),
        ])
      )
    ).toMatchObject({ netMinor: 0n }));
  it('preserves reversal direction and link evidence', () => {
    const original = evidence('PHARMACY_TENDER', null, [
      debit('CASH', 100n),
      credit('SALES_CLEARING', 100n),
    ]);
    const reversal = {
      ...original,
      id: 'reversal',
      reversesEntryId: original.id,
      lines: [credit('CASH', 100n), debit('SALES_CLEARING', 100n)],
    };
    expect(classifyCashEvidence(reversal)).toMatchObject({
      classification: 'OPERATING',
      netMinor: -100n,
    });
    expect(reversal.reversesEntryId).toBe('entry');
  });
});
