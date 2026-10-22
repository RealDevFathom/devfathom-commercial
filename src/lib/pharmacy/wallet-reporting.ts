import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { StoredValueDb } from '@/lib/stored-value/ledger';

/** Wallet liabilities are surfaced separately and are never folded into sales/tax. */
export async function readWalletLiability(db: StoredValueDb, organizationId: string, branchId?: string, businessDate?: Date) {
  const [liability, topUps] = await Promise.all([
    db.$queryRaw<Array<{ liabilityMinor: bigint }>>(Prisma.sql`
      SELECT COALESCE(sum("balanceMinor"), 0)::bigint AS "liabilityMinor" FROM stored_value_accounts
      WHERE "organizationId"=${organizationId} AND kind='CUSTOMER_LIABILITY'::"StoredValueAccountKind"
    `),
    db.$queryRaw<Array<{ topUpCashInMinor: bigint }>>(Prisma.sql`
      SELECT COALESCE(sum(e."amountMinor"), 0)::bigint AS "topUpCashInMinor"
      FROM stored_value_journals j JOIN stored_value_entries e
        ON e."organizationId"=j."organizationId" AND e."journalId"=j.id
      JOIN stored_value_accounts a ON a."organizationId"=e."organizationId" AND a.id=e."accountId"
      WHERE j."organizationId"=${organizationId} AND (${branchId ?? null}::text IS NULL OR j."branchId"=${branchId ?? null})
        AND (${businessDate ?? null}::timestamp IS NULL OR j."occurredAt"::date=${businessDate ?? null}::timestamp::date)
        AND j.kind='TOP_UP'::"StoredValueEntryKind" AND a.kind='CUSTOMER_LIABILITY'::"StoredValueAccountKind"
    `),
  ]);
  return { liabilityMinor: Number(liability[0]?.liabilityMinor ?? 0n), topUpCashInMinor: Number(topUps[0]?.topUpCashInMinor ?? 0n) };
}
