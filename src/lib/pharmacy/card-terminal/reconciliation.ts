import 'server-only';

import type { ProviderSettlementRecord } from './contract';
import type { TerminalIntent } from './intent';
import { TERMINAL_UNRESOLVED_STATES } from './intent';

/**
 * DEV-743 — three-way terminal reconciliation for one branch day.
 *
 * Compares (1) terminal intents, (2) settlement ledger rows (tenders and refunds
 * written by `applyPharmacyTender` / `refundPharmacyTender` with an integrated
 * provider) and (3) the provider's settlement report. Pure and deterministic: the
 * same inputs in any order give the same report. It recommends actions only. It
 * never voids, refunds or edits a tender.
 *
 * Manual "received externally" card tenders (DEV-713, provider MANUAL_TERMINAL) are
 * not terminal intents and are excluded by provider name before calling this.
 */

export type LedgerMoneyRow = {
  id: string;
  kind: 'TENDER' | 'REFUND';
  provider: string | null;
  providerRef: string | null;
  amountMinor: number;
};

export type ReconciliationIssue =
  /** Charged (intent approved, or provider shows it) but no tender: possible double charge. */
  | 'APPROVED_NOT_SETTLED'
  /** The provider reports an operation DevFathom has no intent for. */
  | 'PROVIDER_RECORD_WITHOUT_INTENT'
  /** A settled intent or ledger row the provider report does not contain (yet). */
  | 'MISSING_FROM_PROVIDER_REPORT'
  /** A ledger row with a terminal provider but no matching intent. */
  | 'LEDGER_ROW_WITHOUT_INTENT'
  | 'AMOUNT_MISMATCH'
  | 'DUPLICATE_PROVIDER_REF'
  /** The outcome is still unknown. Recover before closing the day. */
  | 'UNRESOLVED_INTENT';

export type ReconciliationAction =
  'NONE' | 'RECOVER_STATUS' | 'REVIEW_VOID_OR_REFUND' | 'INVESTIGATE' | 'RECHECK_AFTER_BATCH';

export type ReconciliationLine = {
  providerRef: string | null;
  intentRef: string | null;
  ledgerId: string | null;
  issue: ReconciliationIssue | null;
  action: ReconciliationAction;
  intentAmountMinor: number | null;
  ledgerAmountMinor: number | null;
  providerAmountMinor: number | null;
};

export type TerminalReconciliationReport = {
  providerName: string;
  lines: ReconciliationLine[];
  totals: {
    providerSalesMinor: number;
    providerReversalsMinor: number;
    ledgerTendersMinor: number;
    ledgerRefundsMinor: number;
  };
  /** True only when every line matched and totals agree. A day with issues must not close silently. */
  balanced: boolean;
};

const ACTION: Record<ReconciliationIssue, ReconciliationAction> = {
  APPROVED_NOT_SETTLED: 'REVIEW_VOID_OR_REFUND',
  PROVIDER_RECORD_WITHOUT_INTENT: 'INVESTIGATE',
  MISSING_FROM_PROVIDER_REPORT: 'RECHECK_AFTER_BATCH',
  LEDGER_ROW_WITHOUT_INTENT: 'INVESTIGATE',
  AMOUNT_MISMATCH: 'INVESTIGATE',
  DUPLICATE_PROVIDER_REF: 'INVESTIGATE',
  UNRESOLVED_INTENT: 'RECOVER_STATUS',
};

export function reconcileTerminalDay(input: {
  providerName: string;
  intents: readonly TerminalIntent[];
  ledger: readonly LedgerMoneyRow[];
  providerRecords: readonly ProviderSettlementRecord[];
}): TerminalReconciliationReport {
  const intents = input.intents.filter((row) => row.providerName === input.providerName);
  const ledger = input.ledger.filter((row) => row.provider === input.providerName);
  const lines: ReconciliationLine[] = [];
  const line = (
    issue: ReconciliationIssue | null,
    fields: Partial<ReconciliationLine>
  ): ReconciliationLine => ({
    providerRef: null,
    intentRef: null,
    ledgerId: null,
    intentAmountMinor: null,
    ledgerAmountMinor: null,
    providerAmountMinor: null,
    ...fields,
    issue,
    action: issue ? ACTION[issue] : 'NONE',
  });

  // Duplicate provider references in the report are flagged once and not matched.
  const recordsByRef = new Map<string, ProviderSettlementRecord[]>();
  for (const record of input.providerRecords) {
    recordsByRef.set(record.providerRef, [...(recordsByRef.get(record.providerRef) ?? []), record]);
  }
  for (const [ref, records] of recordsByRef) {
    if (records.length > 1)
      lines.push(
        line('DUPLICATE_PROVIDER_REF', {
          providerRef: ref,
          providerAmountMinor: records.reduce((sum, row) => sum + row.amountMinor, 0),
        })
      );
  }
  const uniqueRecord = (ref: string | undefined) => {
    const rows = ref ? recordsByRef.get(ref) : undefined;
    return rows?.length === 1 ? rows[0] : undefined;
  };

  const ledgerByRef = new Map<string, LedgerMoneyRow[]>();
  for (const row of ledger) {
    if (!row.providerRef) {
      lines.push(
        line('LEDGER_ROW_WITHOUT_INTENT', { ledgerId: row.id, ledgerAmountMinor: row.amountMinor })
      );
      continue;
    }
    ledgerByRef.set(row.providerRef, [...(ledgerByRef.get(row.providerRef) ?? []), row]);
  }
  for (const [ref, rows] of ledgerByRef) {
    if (rows.length > 1)
      lines.push(
        line('DUPLICATE_PROVIDER_REF', {
          providerRef: ref,
          ledgerAmountMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0),
        })
      );
  }

  const seenRefs = new Set<string>();
  const seenLedger = new Set<string>();
  for (const intent of intents) {
    const base = { intentRef: intent.intentRef, intentAmountMinor: intent.amountMinor };
    if (TERMINAL_UNRESOLVED_STATES.has(intent.state)) {
      if (intent.providerRef) seenRefs.add(intent.providerRef);
      lines.push(line('UNRESOLVED_INTENT', { ...base, providerRef: intent.providerRef ?? null }));
      continue;
    }
    if (intent.state === 'DECLINED' || intent.state === 'FAILED') {
      // A provider record for a declined or failed intent is investigated below.
      continue;
    }
    const ref = intent.providerRef ?? null;
    if (ref) seenRefs.add(ref);
    const record = uniqueRecord(ref ?? undefined);
    const ledgerRows = ref ? (ledgerByRef.get(ref) ?? []) : [];
    const ledgerRow =
      ledgerRows.length === 1
        ? ledgerRows[0]
        : intent.ledgerRef
          ? ledger.find((row) => row.id === intent.ledgerRef)
          : undefined;
    if (ledgerRow) seenLedger.add(ledgerRow.id);
    const fields = {
      ...base,
      providerRef: ref,
      ledgerId: ledgerRow?.id ?? null,
      ledgerAmountMinor: ledgerRow?.amountMinor ?? null,
      providerAmountMinor: record?.amountMinor ?? null,
    };
    if (ref && (recordsByRef.get(ref)?.length ?? 0) > 1) continue; // already flagged
    if (ref && ledgerRows.length > 1) continue; // already flagged
    if (intent.state === 'APPROVED' || !ledgerRow) {
      lines.push(line('APPROVED_NOT_SETTLED', fields));
      continue;
    }
    if (
      ledgerRow.amountMinor !== intent.amountMinor ||
      (record && record.amountMinor !== intent.amountMinor)
    ) {
      lines.push(line('AMOUNT_MISMATCH', fields));
      continue;
    }
    if (!record) {
      lines.push(line('MISSING_FROM_PROVIDER_REPORT', fields));
      continue;
    }
    lines.push(line(null, fields));
  }

  for (const row of ledger) {
    if (!row.providerRef || seenLedger.has(row.id)) continue;
    if ((ledgerByRef.get(row.providerRef)?.length ?? 0) > 1) continue;
    lines.push(
      line('LEDGER_ROW_WITHOUT_INTENT', {
        ledgerId: row.id,
        providerRef: row.providerRef,
        ledgerAmountMinor: row.amountMinor,
        providerAmountMinor: uniqueRecord(row.providerRef)?.amountMinor ?? null,
      })
    );
    seenRefs.add(row.providerRef);
  }

  const closedByOperationRef = new Map(
    intents
      .filter((row) => row.state === 'DECLINED' || row.state === 'FAILED')
      .map((row) => [row.intentRef, row])
  );
  for (const [ref, records] of recordsByRef) {
    if (records.length > 1 || seenRefs.has(ref)) continue;
    // The provider charged an operation DevFathom closed as declined or not charged
    // (for example a late approval after a NOT_FOUND). That is money taken without a
    // tender: review for void or refund.
    const late = records[0]!.operationRef
      ? closedByOperationRef.get(records[0]!.operationRef)
      : undefined;
    if (late) {
      lines.push(
        line('APPROVED_NOT_SETTLED', {
          providerRef: ref,
          intentRef: late.intentRef,
          intentAmountMinor: late.amountMinor,
          providerAmountMinor: records[0]!.amountMinor,
        })
      );
      continue;
    }
    lines.push(
      line('PROVIDER_RECORD_WITHOUT_INTENT', {
        providerRef: ref,
        providerAmountMinor: records[0]!.amountMinor,
      })
    );
  }

  const sortKey = (row: ReconciliationLine) =>
    [row.issue ?? '~', row.providerRef ?? '', row.intentRef ?? '', row.ledgerId ?? ''].join(
      '\u0000'
    );
  lines.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));

  const sum = (rows: readonly { amountMinor: number }[]) =>
    rows.reduce((total, row) => total + row.amountMinor, 0);
  const totals = {
    providerSalesMinor: sum(input.providerRecords.filter((row) => row.kind === 'SALE')),
    providerReversalsMinor: sum(input.providerRecords.filter((row) => row.kind !== 'SALE')),
    ledgerTendersMinor: sum(ledger.filter((row) => row.kind === 'TENDER')),
    ledgerRefundsMinor: sum(ledger.filter((row) => row.kind === 'REFUND')),
  };
  const balanced =
    lines.every((row) => row.issue === null) &&
    totals.providerSalesMinor === totals.ledgerTendersMinor &&
    totals.providerReversalsMinor === totals.ledgerRefundsMinor;

  return { providerName: input.providerName, lines, totals, balanced };
}
