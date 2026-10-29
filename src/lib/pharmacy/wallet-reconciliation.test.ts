import { describe, expect, it } from 'vitest';
import {
  reconcileWalletJournals,
  type WalletCanonicalSnapshot,
  type WalletEventSnapshot,
  type WalletReconciliationIssueCode,
} from './wallet-reconciliation';

const scope = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  from: new Date('2026-10-24T00:00:00Z'),
  to: new Date('2026-10-25T00:00:00Z'),
};
const instant = new Date('2026-10-24T12:00:00Z');
function wallet(overrides: Partial<WalletEventSnapshot> = {}): WalletEventSnapshot {
  return {
    sourceId: 'event-1',
    organizationId: 'org-a',
    branchId: 'branch-a',
    currency: 'PKR',
    occurredAt: instant,
    kind: 'TOP_UP',
    journalCurrency: overrides.currency ?? 'PKR',
    originalJournalId: null,
    actorId: 'actor-a',
    saleId: null,
    tender: 'CASH',
    counterAccountKind: 'CASH_CLEARING',
    liabilityDeltaMinor: BigInt('20000'),
    balanceMinor: BigInt('0'),
    lineCount: BigInt('2'),
    liabilityLegCount: BigInt('1'),
    currencyCount: BigInt('1'),
    customerMismatchCount: BigInt('0'),
    ...overrides,
  };
}
function canonical(overrides: Partial<WalletCanonicalSnapshot> = {}): WalletCanonicalSnapshot {
  return {
    entryId: 'canonical-1',
    sourceId: 'event-1',
    organizationId: 'org-a',
    branchId: 'branch-a',
    currency: 'PKR',
    occurredAt: instant,
    reversesEntryId: null,
    reversalReason: null,
    headerBranchId: 'branch-a',
    idempotencyKey: `finance:PHARMACY_STORED_VALUE_JOURNAL:${overrides.sourceId ?? 'event-1'}`,
    actorId: 'actor-a',
    sourceLineMismatchCount: BigInt('0'),
    counterAccountCode: 'CASH',
    liabilityDeltaMinor: BigInt('20000'),
    balanceMinor: BigInt('0'),
    lineCount: BigInt('2'),
    liabilityLegCount: BigInt('1'),
    wrongBranchCount: BigInt('0'),
    branchLiabilityDeltaMinor: overrides.liabilityDeltaMinor ?? BigInt('20000'),
    ...overrides,
  };
}
function issue(
  events: WalletEventSnapshot[],
  entries: WalletCanonicalSnapshot[],
  code: WalletReconciliationIssueCode
) {
  const result = reconcileWalletJournals(scope, events, entries);
  expect(result.status).toBe('HOLD');
  expect(result.issues.map((row) => row.code)).toContain(code);
  return result;
}

describe('existing wallet to canonical Accounts reconciliation', () => {
  it('reconciles immutable funded topup without treating deposits as revenue', () => {
    const result = reconcileWalletJournals(scope, [wallet()], [canonical()]);
    expect(result.status).toBe('RECONCILED');
    expect(result.issues).toEqual([]);
    expect(result.currencies[0]).toMatchObject({
      walletChangeMinor: '20000',
      canonicalChangeMinor: '20000',
      closingDifferenceMinor: '0',
    });
    expect(JSON.stringify(result)).not.toContain('salesRevenue');
  });
  it.each(['BANK_TRANSFER'])('maps supported %s funded tender to BANK only', (tender) => {
    expect(
      reconcileWalletJournals(
        scope,
        [wallet({ tender })],
        [canonical({ counterAccountCode: 'BANK' })]
      ).status
    ).toBe('RECONCILED');
  });
  it('reconciles spend as liability release to clearing, not repeated sale revenue', () => {
    const result = reconcileWalletJournals(
      scope,
      [
        wallet({
          kind: 'SPEND',
          saleId: 'sale-1',
          tender: null,
          counterAccountKind: 'SALES_CLEARING',
          liabilityDeltaMinor: -BigInt('2000'),
        }),
      ],
      [canonical({ counterAccountCode: 'SALES_CLEARING', liabilityDeltaMinor: -BigInt('2000') })]
    );
    expect(result.status).toBe('RECONCILED');
  });
  it('separates opening and half-open UTC reporting-period movement', () => {
    const opening = new Date('2026-10-23T23:59:59Z');
    const result = reconcileWalletJournals(
      scope,
      [
        wallet({ sourceId: 'opening', occurredAt: opening }),
        wallet({ sourceId: 'at-start', occurredAt: scope.from }),
      ],
      [
        canonical({ sourceId: 'opening', entryId: 'open-entry', occurredAt: opening }),
        canonical({ sourceId: 'at-start', occurredAt: scope.from }),
      ]
    );
    expect(result.status).toBe('RECONCILED');
    expect(result.currencies[0]).toMatchObject({
      walletOpeningMinor: '20000',
      walletChangeMinor: '20000',
      walletClosingMinor: '40000',
    });
  });
  it('does not round large minor-unit totals through JS numbers', () => {
    const large = BigInt('9007199254740993');
    const result = reconcileWalletJournals(
      scope,
      [wallet({ liabilityDeltaMinor: large })],
      [canonical({ liabilityDeltaMinor: large })]
    );
    expect(result.currencies[0].walletClosingMinor).toBe('9007199254740993');
  });
  it('keeps currencies separate', () => {
    const result = reconcileWalletJournals(
      scope,
      [wallet(), wallet({ sourceId: 'usd', currency: 'USD' })],
      [canonical(), canonical({ entryId: 'usd-entry', sourceId: 'usd', currency: 'USD' })]
    );
    expect(result.status).toBe('RECONCILED');
    expect(result.currencies.map((row) => row.currency)).toEqual(['PKR', 'USD']);
  });
  it('is deterministic and read-only', () => {
    const event = Object.freeze(wallet());
    const entry = Object.freeze(canonical());
    expect(reconcileWalletJournals(scope, [event], [entry])).toEqual(
      reconcileWalletJournals(scope, [event], [entry])
    );
    expect(event.liabilityDeltaMinor).toBe(BigInt('20000'));
  });
  it('returns EMPTY, not a false affirmative on a branch with no evidence', () => {
    expect(reconcileWalletJournals(scope, [], []).status).toBe('EMPTY');
  });
  it('detects a missing posting', () => {
    issue([wallet()], [], 'MISSING_CANONICAL');
  });
  it('detects an orphan posting', () => {
    issue([], [canonical()], 'ORPHAN_CANONICAL');
  });
  it('detects duplicate immutable wallet identities', () => {
    issue([wallet(), wallet()], [canonical()], 'DUPLICATE_WALLET_SOURCE');
  });
  it('detects canonical duplicate posting even when totals are zero', () => {
    const result = issue(
      [wallet()],
      [canonical(), canonical({ entryId: 'duplicate', liabilityDeltaMinor: -BigInt('20000') })],
      'DUPLICATE_CANONICAL_SOURCE'
    );
    expect(result.canonicalEntryCount).toBe(2);
  });
  it('detects missing/orphan event substitution despite equal totals', () => {
    const result = issue([wallet()], [canonical({ sourceId: 'other-event' })], 'MISSING_CANONICAL');
    expect(result.issues.map((row) => row.code)).toContain('ORPHAN_CANONICAL');
    expect(result.currencies[0].closingDifferenceMinor).toBe('0');
  });
  it('detects equal-net opposite per-event amount errors', () => {
    const result = issue(
      [wallet(), wallet({ sourceId: 'second' })],
      [
        canonical({ liabilityDeltaMinor: BigInt('19000') }),
        canonical({
          sourceId: 'second',
          entryId: 'second-entry',
          liabilityDeltaMinor: BigInt('21000'),
        }),
      ],
      'AMOUNT_MISMATCH'
    );
    expect(result.currencies[0].closingDifferenceMinor).toBe('0');
    expect(result.issues.filter((row) => row.code === 'AMOUNT_MISMATCH')).toHaveLength(2);
  });
  it('detects currency mismatch', () => {
    issue([wallet()], [canonical({ currency: 'USD' })], 'CURRENCY_MISMATCH');
  });
  it('detects shifted canonical period even with equal closing totals', () => {
    const result = issue(
      [wallet()],
      [canonical({ occurredAt: new Date('2026-10-23T23:59:59Z') })],
      'TIME_MISMATCH'
    );
    expect(result.currencies[0].closingDifferenceMinor).toBe('0');
    expect(result.currencies[0].openingDifferenceMinor).toBe('-20000');
  });
  it('detects canonical date beyond report end linked to an in-scope event', () => {
    issue([wallet()], [canonical({ occurredAt: scope.to })], 'TIME_MISMATCH');
  });
  it.each([{ branchId: 'other-branch' }, { branchId: null }, { wrongBranchCount: BigInt('1') }])(
    'detects wrong or null canonical branch case %#',
    (overrides) => {
      issue([wallet()], [canonical(overrides)], 'DIMENSION_MISMATCH');
    }
  );
  it('keeps wrong-branch canonical money out of actual branch balances', () => {
    const result = issue(
      [wallet()],
      [
        canonical({
          branchId: 'other-branch',
          wrongBranchCount: BigInt('2'),
          branchLiabilityDeltaMinor: BigInt('0'),
        }),
      ],
      'DIMENSION_MISMATCH'
    );
    expect(result.currencies[0]).toMatchObject({
      canonicalClosingMinor: '0',
      closingDifferenceMinor: '20000',
    });
  });
  it.each([
    { balanceMinor: BigInt('1') },
    { lineCount: BigInt('1') },
    { liabilityLegCount: BigInt('0') },
    { liabilityDeltaMinor: BigInt('0') },
    { currencyCount: BigInt('2') },
  ])('detects invalid wallet legs case %#', (overrides) => {
    issue([wallet(overrides)], [canonical()], 'INVALID_WALLET_ENTRY');
  });
  it.each([
    { balanceMinor: BigInt('1') },
    { lineCount: BigInt('3') },
    { liabilityLegCount: BigInt('0') },
    { liabilityDeltaMinor: BigInt('0') },
  ])('detects invalid canonical legs case %#', (overrides) => {
    issue([wallet()], [canonical(overrides)], 'INVALID_CANONICAL_ENTRY');
  });
  it('refuses to conceal a reversal as an original posting', () => {
    issue([wallet()], [canonical({ reversesEntryId: 'reversed' })], 'UNSUPPORTED_REVERSAL');
  });
  it('does not accept revenue, loyalty or expense as a deposit contra-account', () => {
    issue(
      [wallet()],
      [canonical({ counterAccountCode: 'SALES_REVENUE' })],
      'COUNTER_ACCOUNT_MISMATCH'
    );
  });
  it.each(['CARD', 'CREDIT', 'LOYALTY', 'WALLET', null])(
    'holds nonfunded topup tender %s',
    (tender) => {
      issue([wallet({ tender })], [canonical()], 'UNSUPPORTED_EVENT');
    }
  );
  it.each(['REFUND', 'EXPIRY', 'ADJUSTMENT'])('holds unresolved %s policy/provenance', (kind) => {
    issue([wallet({ kind })], [canonical()], 'UNSUPPORTED_EVENT');
  });
  it.each([
    {
      kind: 'SPEND',
      saleId: null,
      counterAccountKind: 'SALES_CLEARING',
      liabilityDeltaMinor: -BigInt('20000'),
    },
    {
      kind: 'SPEND',
      saleId: 'sale',
      counterAccountKind: 'SALES_CLEARING',
      liabilityDeltaMinor: BigInt('20000'),
    },
    { counterAccountKind: 'LOYALTY_EXPENSE' },
    { saleId: 'unexpected-sale' },
  ])('holds invalid event semantics case %#', (overrides) => {
    issue([wallet(overrides)], [canonical()], 'UNSUPPORTED_EVENT');
  });
  it('holds legacy missing event currency rather than inferring it from accounts', () => {
    issue([wallet({ journalCurrency: null })], [canonical()], 'MISSING_EVENT_PROVENANCE');
  });
  it('holds journal/account currency disagreement even when both ledgers net equally', () => {
    const result = issue([wallet({ journalCurrency: 'USD' })], [canonical()], 'CURRENCY_MISMATCH');
    expect(result.currencies[0].closingDifferenceMinor).toBe('0');
  });
  it('holds non-PKR spend instead of adopting the sale default or silently converting', () => {
    issue(
      [
        wallet({
          kind: 'SPEND',
          saleId: 'sale-1',
          tender: null,
          currency: 'USD',
          counterAccountKind: 'SALES_CLEARING',
          liabilityDeltaMinor: -BigInt('2000'),
        }),
      ],
      [
        canonical({
          currency: 'USD',
          counterAccountCode: 'SALES_CLEARING',
          liabilityDeltaMinor: -BigInt('2000'),
        }),
      ],
      'UNSUPPORTED_EVENT'
    );
  });
  it.each(['TOP_UP', 'SPEND'])('does not approve %s with an original-funding reference', (kind) => {
    issue([wallet({ kind, originalJournalId: 'old-funding' })], [canonical()], 'UNSUPPORTED_EVENT');
  });
  it('holds an undeclared spend tender without remapping provider WALLET', () => {
    issue(
      [
        wallet({
          kind: 'SPEND',
          saleId: 'sale-1',
          tender: 'WALLET',
          counterAccountKind: 'SALES_CLEARING',
          liabilityDeltaMinor: -BigInt('2000'),
        }),
      ],
      [canonical({ counterAccountCode: 'SALES_CLEARING', liabilityDeltaMinor: -BigInt('2000') })],
      'UNSUPPORTED_EVENT'
    );
  });
  it('holds a canonical header branch mismatch but preserves actual-line branch balances', () => {
    const result = issue(
      [wallet()],
      [canonical({ headerBranchId: 'other-branch' })],
      'DIMENSION_MISMATCH'
    );
    expect(result.currencies[0].canonicalClosingMinor).toBe('20000');
  });
  it.each([
    { idempotencyKey: 'unrelated-key' },
    { sourceLineMismatchCount: BigInt('1') },
    { actorId: 'other-actor' },
  ])('holds immutable canonical source-provenance mismatch case %#', (overrides) => {
    issue([wallet()], [canonical(overrides)], 'SOURCE_PROVENANCE_MISMATCH');
  });
  it('holds legacy missing actor provenance', () => {
    issue([wallet({ actorId: '' })], [canonical()], 'MISSING_EVENT_PROVENANCE');
  });
  it('does not conceal a reversal reason without an original reversal link', () => {
    issue(
      [wallet()],
      [canonical({ reversalReason: 'unapproved correction' })],
      'UNSUPPORTED_REVERSAL'
    );
  });
  it('holds wallet account customer mismatch even when source and canonical net equally', () => {
    const result = issue(
      [wallet({ customerMismatchCount: BigInt('1') })],
      [canonical()],
      'INVALID_WALLET_ENTRY'
    );
    expect(result.currencies[0].closingDifferenceMinor).toBe('0');
  });
  it('does not conceal a missing persisted customer under a balanced event', () => {
    issue([wallet({ customerMismatchCount: BigInt('2') })], [canonical()], 'INVALID_WALLET_ENTRY');
  });
  it('rejects foreign-tenant wallet rows without leaking source ids', () => {
    expect(() => reconcileWalletJournals(scope, [wallet({ organizationId: 'other' })], [])).toThrow(
      'WALLET_REPORT_SCOPE_MISMATCH'
    );
  });
  it('rejects foreign-branch wallet rows', () => {
    expect(() => reconcileWalletJournals(scope, [wallet({ branchId: 'other' })], [])).toThrow(
      'WALLET_REPORT_SCOPE_MISMATCH'
    );
  });
  it('rejects foreign-tenant canonical rows', () => {
    expect(() =>
      reconcileWalletJournals(scope, [], [canonical({ organizationId: 'other' })])
    ).toThrow('WALLET_REPORT_SCOPE_MISMATCH');
  });
  it.each([
    { from: scope.to },
    { to: scope.from },
    { branchId: '' },
    { organizationId: '' },
    { from: new Date('invalid') },
  ])('rejects invalid scope case %#', (overrides) => {
    expect(() => reconcileWalletJournals({ ...scope, ...overrides }, [], [])).toThrow(
      'INVALID_WALLET_REPORT_SCOPE'
    );
  });
  it('rejects a wallet event on the excluded upper boundary', () => {
    expect(() => reconcileWalletJournals(scope, [wallet({ occurredAt: scope.to })], [])).toThrow(
      'INVALID_WALLET_REPORT_ROW'
    );
  });
});
