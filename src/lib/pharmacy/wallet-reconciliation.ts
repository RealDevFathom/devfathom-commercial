/**
 * Read-only reconciliation of the funded-wallet subledger to the ONE canonical
 * finance journal. A matching net balance alone is never acceptance: every
 * immutable event must have exactly one matching, balanced canonical posting.
 * Dates are UTC instants and the report interval is [from, to).
 */
export type WalletReconciliationScope = {
  organizationId: string;
  branchId: string;
  from: Date;
  to: Date;
};

export type WalletEventSnapshot = {
  sourceId: string;
  organizationId: string;
  branchId: string | null;
  currency: string;
  occurredAt: Date;
  kind: string;
  /** Explicit event provenance; legacy null is not inferred from its accounts. */
  journalCurrency: string | null;
  originalJournalId: string | null;
  actorId: string;
  currencyCount: bigint;
  customerMismatchCount: bigint;
  saleId: string | null;
  tender: string | null;
  counterAccountKind: string | null;
  liabilityDeltaMinor: bigint;
  balanceMinor: bigint;
  lineCount: bigint;
  liabilityLegCount: bigint;
};

export type WalletCanonicalSnapshot = {
  entryId: string;
  sourceId: string;
  organizationId: string;
  branchId: string | null;
  currency: string;
  occurredAt: Date;
  reversesEntryId: string | null;
  reversalReason: string | null;
  headerBranchId: string | null;
  idempotencyKey: string;
  actorId: string;
  sourceLineMismatchCount: bigint;
  counterAccountCode: string | null;
  liabilityDeltaMinor: bigint;
  balanceMinor: bigint;
  lineCount: bigint;
  liabilityLegCount: bigint;
  wrongBranchCount: bigint;
  /** Actual branch line amount, not source-attributed all-branch amount. */
  branchLiabilityDeltaMinor: bigint;
};

export type WalletReconciliationIssueCode =
  | 'DUPLICATE_WALLET_SOURCE'
  | 'MISSING_CANONICAL'
  | 'ORPHAN_CANONICAL'
  | 'DUPLICATE_CANONICAL_SOURCE'
  | 'INVALID_WALLET_ENTRY'
  | 'INVALID_CANONICAL_ENTRY'
  | 'MISSING_EVENT_PROVENANCE'
  | 'SOURCE_PROVENANCE_MISMATCH'
  | 'UNSUPPORTED_EVENT'
  | 'UNSUPPORTED_REVERSAL'
  | 'CURRENCY_MISMATCH'
  | 'TIME_MISMATCH'
  | 'DIMENSION_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'COUNTER_ACCOUNT_MISMATCH';

type Issue = { sourceId: string; code: WalletReconciliationIssueCode };
type Balances = {
  walletOpening: bigint;
  walletChange: bigint;
  canonicalOpening: bigint;
  canonicalChange: bigint;
};

export function assertWalletReportScope(scope: WalletReconciliationScope): void {
  if (
    !scope.organizationId.trim() ||
    !scope.branchId.trim() ||
    !Number.isFinite(scope.from.getTime()) ||
    !Number.isFinite(scope.to.getTime()) ||
    scope.from >= scope.to
  )
    throw new RangeError('INVALID_WALLET_REPORT_SCOPE');
}

/** Only funded events with a currently established contra-account are mapped. */
function expectedCounterAccount(event: WalletEventSnapshot): string | null {
  // A reference is not refund approval, nor valid TOP_UP/SPEND provenance.
  if (event.originalJournalId !== null) return null;
  if (
    event.kind === 'SPEND' &&
    event.saleId &&
    event.tender === null &&
    event.currency === 'PKR' &&
    event.journalCurrency === 'PKR' &&
    event.liabilityDeltaMinor < BigInt('0') &&
    event.counterAccountKind === 'SALES_CLEARING'
  )
    return 'SALES_CLEARING';
  if (
    event.kind !== 'TOP_UP' ||
    event.saleId ||
    event.liabilityDeltaMinor <= BigInt('0') ||
    event.counterAccountKind !== 'CASH_CLEARING'
  )
    return null;
  if (event.tender === 'CASH') return 'CASH';
  if (event.tender === 'BANK_TRANSFER') return 'BANK';
  // CARD has no approved bridge funding path; provider-WALLET and earned
  // LOYALTY remain separate. This reader does not approve historical tenders.
  // CREDIT, LOYALTY and WALLET are not new deposited funds. Refund provenance,
  // expiry and manual-adjustment recognition are deliberately not invented.
  return null;
}

export function reconcileWalletJournals(
  scope: WalletReconciliationScope,
  events: readonly WalletEventSnapshot[],
  entries: readonly WalletCanonicalSnapshot[]
) {
  assertWalletReportScope(scope);
  const issues: Issue[] = [];
  const issueKeys = new Set<string>();
  const addIssue = (sourceId: string, code: WalletReconciliationIssueCode) => {
    const key = JSON.stringify([sourceId, code]);
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push({ sourceId, code });
    }
  };
  const walletById = new Map<string, WalletEventSnapshot>();
  const canonicalBySource = new Map<string, WalletCanonicalSnapshot[]>();
  const totals = new Map<string, Balances>();
  const addBalance = (row: WalletEventSnapshot | WalletCanonicalSnapshot, canonical: boolean) => {
    if (row.occurredAt >= scope.to) return;
    let balance = totals.get(row.currency);
    if (!balance) {
      balance = {
        walletOpening: BigInt('0'),
        walletChange: BigInt('0'),
        canonicalOpening: BigInt('0'),
        canonicalChange: BigInt('0'),
      };
      totals.set(row.currency, balance);
    }
    if (canonical) {
      const branchDelta = (row as WalletCanonicalSnapshot).branchLiabilityDeltaMinor;
      if (row.occurredAt < scope.from) balance.canonicalOpening += branchDelta;
      else balance.canonicalChange += branchDelta;
    } else {
      if (row.occurredAt < scope.from) balance.walletOpening += row.liabilityDeltaMinor;
      else balance.walletChange += row.liabilityDeltaMinor;
    }
  };
  for (const event of events) {
    // Fail closed instead of returning another tenant's/branch's identifiers.
    if (event.organizationId !== scope.organizationId || event.branchId !== scope.branchId)
      throw new Error('WALLET_REPORT_SCOPE_MISMATCH');
    if (
      !event.sourceId ||
      !event.currency ||
      !Number.isFinite(event.occurredAt.getTime()) ||
      event.occurredAt >= scope.to
    )
      throw new Error('INVALID_WALLET_REPORT_ROW');
    if (walletById.has(event.sourceId)) addIssue(event.sourceId, 'DUPLICATE_WALLET_SOURCE');
    else walletById.set(event.sourceId, event);
    if (
      event.lineCount !== BigInt('2') ||
      event.liabilityLegCount !== BigInt('1') ||
      event.currencyCount !== BigInt('1') ||
      event.customerMismatchCount !== BigInt('0') ||
      event.balanceMinor !== BigInt('0') ||
      event.liabilityDeltaMinor === BigInt('0')
    )
      addIssue(event.sourceId, 'INVALID_WALLET_ENTRY');
    if (!event.journalCurrency || !event.actorId)
      addIssue(event.sourceId, 'MISSING_EVENT_PROVENANCE');
    if (event.journalCurrency !== null && event.journalCurrency !== event.currency)
      addIssue(event.sourceId, 'CURRENCY_MISMATCH');
    if (!expectedCounterAccount(event)) addIssue(event.sourceId, 'UNSUPPORTED_EVENT');
    addBalance(event, false);
  }
  for (const entry of entries) {
    if (entry.organizationId !== scope.organizationId)
      throw new Error('WALLET_REPORT_SCOPE_MISMATCH');
    if (
      !entry.entryId ||
      !entry.sourceId ||
      !entry.currency ||
      !Number.isFinite(entry.occurredAt.getTime())
    )
      throw new Error('INVALID_WALLET_REPORT_ROW');
    const group = canonicalBySource.get(entry.sourceId) ?? [];
    group.push(entry);
    canonicalBySource.set(entry.sourceId, group);
    if (
      entry.branchId !== scope.branchId ||
      entry.headerBranchId !== scope.branchId ||
      entry.wrongBranchCount !== BigInt('0')
    )
      addIssue(entry.sourceId, 'DIMENSION_MISMATCH');
    if (
      entry.lineCount !== BigInt('2') ||
      entry.liabilityLegCount !== BigInt('1') ||
      entry.balanceMinor !== BigInt('0') ||
      entry.liabilityDeltaMinor === BigInt('0')
    )
      addIssue(entry.sourceId, 'INVALID_CANONICAL_ENTRY');
    if (
      entry.idempotencyKey !== `finance:PHARMACY_STORED_VALUE_JOURNAL:${entry.sourceId}` ||
      !entry.actorId ||
      entry.sourceLineMismatchCount !== BigInt('0')
    )
      addIssue(entry.sourceId, 'SOURCE_PROVENANCE_MISMATCH');
    if (entry.reversesEntryId !== null || entry.reversalReason !== null)
      addIssue(entry.sourceId, 'UNSUPPORTED_REVERSAL');
    addBalance(entry, true);
  }
  for (const [sourceId, event] of walletById) {
    const group = canonicalBySource.get(sourceId) ?? [];
    if (!group.length) addIssue(sourceId, 'MISSING_CANONICAL');
    if (group.length > 1) addIssue(sourceId, 'DUPLICATE_CANONICAL_SOURCE');
    for (const entry of group) {
      if (entry.actorId !== event.actorId) addIssue(sourceId, 'SOURCE_PROVENANCE_MISMATCH');
      if (entry.currency !== event.currency) addIssue(sourceId, 'CURRENCY_MISMATCH');
      if (entry.occurredAt.getTime() !== event.occurredAt.getTime())
        addIssue(sourceId, 'TIME_MISMATCH');
      if (entry.liabilityDeltaMinor !== event.liabilityDeltaMinor)
        addIssue(sourceId, 'AMOUNT_MISMATCH');
      const expected = expectedCounterAccount(event);
      if (expected && entry.counterAccountCode !== expected)
        addIssue(sourceId, 'COUNTER_ACCOUNT_MISMATCH');
    }
  }
  for (const [sourceId, group] of canonicalBySource) {
    if (!walletById.has(sourceId)) addIssue(sourceId, 'ORPHAN_CANONICAL');
    if (group.length > 1) addIssue(sourceId, 'DUPLICATE_CANONICAL_SOURCE');
  }
  const currencies = [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, balance]) => {
      const walletClosing = balance.walletOpening + balance.walletChange;
      const canonicalClosing = balance.canonicalOpening + balance.canonicalChange;
      return {
        currency,
        walletOpeningMinor: balance.walletOpening.toString(),
        walletChangeMinor: balance.walletChange.toString(),
        walletClosingMinor: walletClosing.toString(),
        canonicalOpeningMinor: balance.canonicalOpening.toString(),
        canonicalChangeMinor: balance.canonicalChange.toString(),
        canonicalClosingMinor: canonicalClosing.toString(),
        openingDifferenceMinor: (balance.walletOpening - balance.canonicalOpening).toString(),
        changeDifferenceMinor: (balance.walletChange - balance.canonicalChange).toString(),
        closingDifferenceMinor: (walletClosing - canonicalClosing).toString(),
      };
    });
  const balanced = currencies.every(
    (row) =>
      row.openingDifferenceMinor === '0' &&
      row.changeDifferenceMinor === '0' &&
      row.closingDifferenceMinor === '0'
  );
  return {
    from: scope.from,
    to: scope.to,
    branchId: scope.branchId,
    status:
      !events.length && !entries.length
        ? ('EMPTY' as const)
        : issues.length === 0 && balanced
          ? ('RECONCILED' as const)
          : ('HOLD' as const),
    walletEventCount: events.length,
    canonicalEntryCount: entries.length,
    issues: issues.sort(
      (a, b) => a.sourceId.localeCompare(b.sourceId) || a.code.localeCompare(b.code)
    ),
    currencies,
  };
}
