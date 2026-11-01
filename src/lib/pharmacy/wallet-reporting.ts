import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { StoredValueDb } from '@/lib/stored-value/ledger';
import {
  assertWalletReportScope,
  reconcileWalletJournals,
  type WalletCanonicalSnapshot,
  type WalletEventSnapshot,
  type WalletReconciliationScope,
} from './wallet-reconciliation';

function safeMinor(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new RangeError('WALLET_REPORT_AMOUNT_OUT_OF_RANGE');
  return amount;
}

/**
 * Current attributed liability and daily funding are separate from sales/tax.
 * A branch is an event dimension, NOT ownership of a customer's entire wallet:
 * money may be deposited at one branch and spent at another. Never return the
 * tenant-wide balance cache as if it were a branch balance.
 */
export async function readWalletLiability(
  db: StoredValueDb,
  organizationId: string,
  branchId?: string,
  businessDate?: Date
) {
  if (
    !organizationId.trim() ||
    (branchId !== undefined && !branchId.trim()) ||
    (businessDate && !Number.isFinite(businessDate.getTime()))
  )
    throw new RangeError('INVALID_WALLET_REPORT_SCOPE');
  const from = businessDate
    ? new Date(
        Date.UTC(
          businessDate.getUTCFullYear(),
          businessDate.getUTCMonth(),
          businessDate.getUTCDate()
        )
      )
    : null;
  const to = from ? new Date(from.getTime() + 86_400_000) : null;
  const [row] = await db.$queryRaw<
    Array<{
      liabilityMinor: bigint;
      topUpCashInMinor: bigint;
      currencyCount: bigint;
      currency: string | null;
    }>
  >(Prisma.sql`
    SELECT COALESCE(sum(e."amountMinor"),0)::bigint AS "liabilityMinor",
      COALESCE(sum(e."amountMinor") FILTER (WHERE j.kind='TOP_UP'::"StoredValueEntryKind"
        AND (${from}::timestamp IS NULL OR j."occurredAt">=${from})
        AND (${to}::timestamp IS NULL OR j."occurredAt"<${to})
        AND j.tender::text IN ('CASH','CARD','BANK_TRANSFER') AND j."saleId" IS NULL
        AND EXISTS (SELECT 1 FROM stored_value_entries f JOIN stored_value_accounts fa
          ON fa."organizationId"=f."organizationId" AND fa.id=f."accountId"
          WHERE f."organizationId"=j."organizationId" AND f."journalId"=j.id AND fa.kind='CASH_CLEARING')
      ),0)::bigint AS "topUpCashInMinor",
      count(DISTINCT a.currency)::bigint AS "currencyCount", min(a.currency) AS currency
    FROM stored_value_journals j JOIN stored_value_entries e
      ON e."organizationId"=j."organizationId" AND e."journalId"=j.id
    JOIN stored_value_accounts a ON a."organizationId"=e."organizationId" AND a.id=e."accountId"
    WHERE j."organizationId"=${organizationId} AND (${branchId ?? null}::text IS NULL OR j."branchId"=${branchId ?? null})
      AND a.kind='CUSTOMER_LIABILITY'::"StoredValueAccountKind"
  `);
  // This legacy response is denominated in paisa. Multi-currency reconciliation
  // below is explicit; never add unlike currencies or silently drop one here.
  if (row && (row.currencyCount > BigInt('1') || (row.currency !== null && row.currency !== 'PKR')))
    throw new RangeError('WALLET_REPORT_CURRENCY_REQUIRED');
  return {
    liabilityMinor: safeMinor(row?.liabilityMinor ?? BigInt('0')),
    topUpCashInMinor: safeMinor(row?.topUpCashInMinor ?? BigInt('0')),
  };
}

type ReconciliationRow =
  | (WalletEventSnapshot & { rowKind: 'WALLET' })
  | (WalletCanonicalSnapshot & { rowKind: 'CANONICAL' });

/**
 * One SQL statement gives both ledgers the same MVCC snapshot. Use the existing
 * tenant-scoped transaction/capability guard; this is an internal reader, not a
 * new unguarded API. No CNIC, customer identifier, provider or operational write.
 * Requires the additive bridge schema: explicit journal currency/reference and
 * canonical actor/key/line provenance are read, never inferred for legacy rows.
 * The source kind is compared as text; no new enum member is cast in this query.
 */
export const MAX_WALLET_RECONCILIATION_ROWS = 10_000;

export async function readWalletReconciliation(
  db: StoredValueDb,
  scope: WalletReconciliationScope
) {
  assertWalletReportScope(scope);
  const rows = await db.$queryRaw<ReconciliationRow[]>(Prisma.sql`
    WITH wallet_events AS (
      SELECT j.id AS "sourceId",j."organizationId",j."branchId",j."occurredAt",j.kind::text AS kind,
        j."saleId",j.tender::text AS tender,j.currency::text AS "journalCurrency",j."originalJournalId",j."actorId",
        count(DISTINCT a.currency)::bigint AS "currencyCount",
        count(e.id) FILTER (WHERE
          (a.kind='CUSTOMER_LIABILITY' AND a."customerId" IS NULL)
          OR (a.kind<>'CUSTOMER_LIABILITY' AND a."customerId" IS NOT NULL))::bigint AS "customerMismatchCount",
        min(a.currency) FILTER (WHERE a.kind='CUSTOMER_LIABILITY') AS currency,
        min(a.kind::text) FILTER (WHERE a.kind<>'CUSTOMER_LIABILITY') AS "counterAccountKind",
        COALESCE(sum(e."amountMinor") FILTER (WHERE a.kind='CUSTOMER_LIABILITY'),0)::bigint AS "liabilityDeltaMinor",
        COALESCE(sum(e."amountMinor"),0)::bigint AS "balanceMinor",
        count(e.id)::bigint AS "lineCount",
        count(e.id) FILTER (WHERE a.kind='CUSTOMER_LIABILITY')::bigint AS "liabilityLegCount"
      FROM stored_value_journals j LEFT JOIN stored_value_entries e
        ON e."organizationId"=j."organizationId" AND e."journalId"=j.id
      LEFT JOIN stored_value_accounts a ON a."organizationId"=e."organizationId" AND a.id=e."accountId"
      WHERE j."organizationId"=${scope.organizationId} AND j."branchId"=${scope.branchId} AND j."occurredAt"<${scope.to}
      GROUP BY j.id,j."organizationId",j."branchId",j."occurredAt",j.kind,j."saleId",j.tender,j.currency,j."originalJournalId",j."actorId"
    ), canonical_events AS (
      SELECT e.id AS "entryId",e."sourceId",e."organizationId",min(l."branchId") AS "branchId",e.currency::text AS currency,
        e."occurredAt",e."reversesEntryId",e."reversalReason",e."branchId" AS "headerBranchId",e."idempotencyKey",e."actorId",
        count(l.id) FILTER (WHERE l."sourceLineId" IS DISTINCT FROM
          (e."sourceId" || CASE WHEN l."accountCode"::text='CUSTOMER_WALLET_LIABILITY' THEN ':wallet' ELSE ':counterparty' END)
          OR l."productId" IS NOT NULL OR l."lotId" IS NOT NULL OR l."locationId" IS NOT NULL
          OR l.memo IS NOT NULL OR l."amountMinor"<=0)::bigint AS "sourceLineMismatchCount",
        min(l."accountCode"::text) FILTER (WHERE l."accountCode"::text<>'CUSTOMER_WALLET_LIABILITY') AS "counterAccountCode",
        COALESCE(sum(CASE WHEN l.side='CREDIT' THEN l."amountMinor"::bigint ELSE -l."amountMinor"::bigint END)
          FILTER (WHERE l."accountCode"::text='CUSTOMER_WALLET_LIABILITY'),0)::bigint AS "liabilityDeltaMinor",
        COALESCE(sum(CASE WHEN l.side='DEBIT' THEN l."amountMinor"::bigint ELSE -l."amountMinor"::bigint END),0)::bigint AS "balanceMinor",
        count(l.id)::bigint AS "lineCount",
        count(l.id) FILTER (WHERE l."accountCode"::text='CUSTOMER_WALLET_LIABILITY')::bigint AS "liabilityLegCount",
        count(l.id) FILTER (WHERE l."branchId" IS DISTINCT FROM ${scope.branchId})::bigint AS "wrongBranchCount",
        COALESCE(sum(CASE WHEN l.side='CREDIT' THEN l."amountMinor"::bigint ELSE -l."amountMinor"::bigint END)
          FILTER (WHERE l."accountCode"::text='CUSTOMER_WALLET_LIABILITY' AND l."branchId"=${scope.branchId}),0)::bigint AS "branchLiabilityDeltaMinor"
      FROM finance_journal_entries e LEFT JOIN finance_journal_lines l
        ON l."organizationId"=e."organizationId" AND l."entryId"=e.id
      WHERE e."organizationId"=${scope.organizationId} AND e."sourceKind"::text='PHARMACY_STORED_VALUE_JOURNAL'
        AND ((e."occurredAt"<${scope.to} AND (e."branchId"=${scope.branchId} OR EXISTS (
          SELECT 1 FROM finance_journal_lines b WHERE b."organizationId"=e."organizationId" AND b."entryId"=e.id AND b."branchId"=${scope.branchId}
        ))) OR e."sourceId" IN (SELECT w."sourceId" FROM wallet_events w))
      GROUP BY e.id,e."sourceId",e."organizationId",e.currency,e."occurredAt",e."reversesEntryId",e."reversalReason",e."branchId",e."idempotencyKey",e."actorId"
    )
    SELECT 'WALLET'::text AS "rowKind",NULL::text AS "entryId",w."sourceId",w."organizationId",w."branchId",COALESCE(w.currency,'UNKNOWN') AS currency,
      w."occurredAt",w.kind,w."saleId",w.tender,w."counterAccountKind",NULL::text AS "counterAccountCode",NULL::text AS "reversesEntryId",
      w."journalCurrency",w."originalJournalId",w."actorId",NULL::text AS "reversalReason",NULL::text AS "headerBranchId",
      NULL::text AS "idempotencyKey",NULL::bigint AS "sourceLineMismatchCount",
      w."liabilityDeltaMinor",w."balanceMinor",w."lineCount",w."liabilityLegCount",0::bigint AS "wrongBranchCount",w."currencyCount",NULL::bigint AS "branchLiabilityDeltaMinor",w."customerMismatchCount"
    FROM wallet_events w
    UNION ALL
    SELECT 'CANONICAL'::text,e."entryId",e."sourceId",e."organizationId",e."branchId",e.currency,
      e."occurredAt",NULL::text,NULL::text,NULL::text,NULL::text,e."counterAccountCode",e."reversesEntryId",
      NULL::text,NULL::text,e."actorId",e."reversalReason",e."headerBranchId",e."idempotencyKey",e."sourceLineMismatchCount",
      e."liabilityDeltaMinor",e."balanceMinor",e."lineCount",e."liabilityLegCount",e."wrongBranchCount",1::bigint,e."branchLiabilityDeltaMinor",NULL::bigint
    FROM canonical_events e
    LIMIT ${MAX_WALLET_RECONCILIATION_ROWS + 1}
  `);
  // Historical source checks are intentionally included, but never silently
  // truncate or materialize unbounded application memory for a daily report.
  // Large histories need an explicitly paged/audited export, not a false PASS.
  if (rows.length > MAX_WALLET_RECONCILIATION_ROWS)
    throw new RangeError('WALLET_RECONCILIATION_RANGE_TOO_LARGE');
  return reconcileWalletJournals(
    scope,
    rows.filter(
      (row): row is WalletEventSnapshot & { rowKind: 'WALLET' } => row.rowKind === 'WALLET'
    ),
    rows.filter(
      (row): row is WalletCanonicalSnapshot & { rowKind: 'CANONICAL' } =>
        row.rowKind === 'CANONICAL'
    )
  );
}
