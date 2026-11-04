import { describe, expect, it } from 'vitest';

import type { TerminalIntent } from './intent';
import { reconcileTerminalDay, type LedgerMoneyRow } from './reconciliation';

const P = 'SCRIPTED_TERMINAL';

function intent(ref: string, patch: Partial<TerminalIntent>): TerminalIntent {
  return {
    intentRef: ref,
    organizationId: 'org-1',
    branchId: 'branch-1',
    saleId: 'sale-1',
    kind: 'SALE',
    attemptKey: ref,
    payloadHash: 'h',
    terminalId: 'term-1',
    providerName: P,
    amountMinor: 1_000,
    currency: 'PKR',
    state: 'SETTLED',
    version: 3,
    createdAt: '2026-11-04T10:00:00.000Z',
    updatedAt: '2026-11-04T10:00:00.000Z',
    createdBy: 'cashier-1',
    recoveryAttempts: 0,
    history: [],
    ...patch,
  };
}

const tender = (id: string, providerRef: string, amountMinor = 1_000): LedgerMoneyRow => ({
  id,
  kind: 'TENDER',
  provider: P,
  providerRef,
  amountMinor,
});

describe('card-terminal reconciliation (DEV-743)', () => {
  it('balances a clean day', () => {
    const report = reconcileTerminalDay({
      providerName: P,
      intents: [intent('i1', { providerRef: 'p1', ledgerRef: 't1' })],
      ledger: [tender('t1', 'p1')],
      providerRecords: [{ providerRef: 'p1', kind: 'SALE', amountMinor: 1_000 }],
    });
    expect(report.balanced).toBe(true);
    expect(report.lines).toEqual([expect.objectContaining({ issue: null, action: 'NONE' })]);
  });

  it('flags every mismatch class with a safe action and never balances', () => {
    const report = reconcileTerminalDay({
      providerName: P,
      intents: [
        intent('approved-no-tender', { state: 'APPROVED', providerRef: 'p-orphan' }),
        intent('unknown', { state: 'UNKNOWN' }),
        intent('mismatch', { providerRef: 'p-mismatch', ledgerRef: 't-mismatch' }),
        intent('not-in-report', { providerRef: 'p-late', ledgerRef: 't-late' }),
        intent('late-charge', { state: 'FAILED' }),
      ],
      ledger: [
        tender('t-mismatch', 'p-mismatch', 900),
        tender('t-late', 'p-late'),
        tender('t-stray', 'p-stray'),
        // DEV-713 manual card tenders are not terminal rows and are ignored.
        {
          id: 't-manual',
          kind: 'TENDER',
          provider: 'MANUAL_TERMINAL',
          providerRef: '1234',
          amountMinor: 50,
        },
      ],
      providerRecords: [
        { providerRef: 'p-orphan', kind: 'SALE', amountMinor: 1_000 },
        { providerRef: 'p-mismatch', kind: 'SALE', amountMinor: 1_000 },
        { providerRef: 'p-unknown-to-us', kind: 'SALE', amountMinor: 700 },
        { providerRef: 'p-dup', kind: 'SALE', amountMinor: 100 },
        { providerRef: 'p-dup', kind: 'SALE', amountMinor: 100 },
        {
          providerRef: 'p-late-charge',
          kind: 'SALE',
          amountMinor: 1_000,
          operationRef: 'late-charge',
        },
      ],
    });
    const byIssue = Object.fromEntries(
      report.lines.map((line) => [
        `${line.issue}:${line.intentRef ?? line.providerRef ?? line.ledgerId}`,
        line.action,
      ])
    );
    expect(byIssue).toMatchObject({
      'APPROVED_NOT_SETTLED:approved-no-tender': 'REVIEW_VOID_OR_REFUND',
      'APPROVED_NOT_SETTLED:late-charge': 'REVIEW_VOID_OR_REFUND',
      'UNRESOLVED_INTENT:unknown': 'RECOVER_STATUS',
      'AMOUNT_MISMATCH:mismatch': 'INVESTIGATE',
      'MISSING_FROM_PROVIDER_REPORT:not-in-report': 'RECHECK_AFTER_BATCH',
      'LEDGER_ROW_WITHOUT_INTENT:p-stray': 'INVESTIGATE',
      'PROVIDER_RECORD_WITHOUT_INTENT:p-unknown-to-us': 'INVESTIGATE',
      'DUPLICATE_PROVIDER_REF:p-dup': 'INVESTIGATE',
    });
    expect(report.lines.some((line) => line.ledgerId === 't-manual')).toBe(false);
    expect(report.balanced).toBe(false);
  });

  it('is deterministic regardless of input order', () => {
    const intents = [
      intent('a', { providerRef: 'pa', ledgerRef: 'ta' }),
      intent('b', { state: 'APPROVED', providerRef: 'pb' }),
    ];
    const ledger = [tender('ta', 'pa')];
    const providerRecords = [
      { providerRef: 'pa', kind: 'SALE' as const, amountMinor: 1_000 },
      { providerRef: 'px', kind: 'SALE' as const, amountMinor: 5 },
    ];
    const one = reconcileTerminalDay({ providerName: P, intents, ledger, providerRecords });
    const two = reconcileTerminalDay({
      providerName: P,
      intents: [...intents].reverse(),
      ledger,
      providerRecords: [...providerRecords].reverse(),
    });
    expect(one).toEqual(two);
  });
});
