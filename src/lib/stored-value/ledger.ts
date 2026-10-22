import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { assertMinor } from './accounts';

export type StoredValueKind = 'TOP_UP' | 'SPEND' | 'REFUND' | 'EXPIRY' | 'ADJUSTMENT';
export type StoredValueDb = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

export class StoredValueError extends Error {
  constructor(readonly reason: 'INSUFFICIENT_BALANCE' | 'IDEMPOTENCY_CONFLICT' | 'ACCOUNT_NOT_FOUND') {
    super(reason);
  }
}

/** Lock before calculating a spend. Tenant predicate is mandatory even with RLS. */
export async function lockStoredValueAccount(db: StoredValueDb, organizationId: string, accountId: string) {
  const rows = await db.$queryRaw<Array<{ id: string; balanceMinor: number }>>(Prisma.sql`
    SELECT id, "balanceMinor" FROM stored_value_accounts
    WHERE "organizationId"=${organizationId} AND id=${accountId} FOR UPDATE
  `);
  if (!rows[0]) throw new StoredValueError('ACCOUNT_NOT_FOUND');
  return rows[0];
}

/**
 * Posts both sides and updates the lockable balance cache in the same transaction.
 * A conditional update is a second line of defence against a negative balance.
 */
export async function postStoredValueJournal(
  db: StoredValueDb,
  input: {
    organizationId: string; journalId: string; idempotencyKey: string; kind: StoredValueKind;
    accountId: string; counterpartyAccountId: string; amountMinor: number; direction: 'CREDIT' | 'DEBIT';
    actorId: string; branchId?: string; saleId?: string; tender?: string; reason?: string;
  }
) {
  assertMinor(input.amountMinor);
  if (input.kind === 'ADJUSTMENT' && !input.reason?.trim()) throw new RangeError('ADJUSTMENT_REASON_REQUIRED');
  const delta = input.direction === 'CREDIT' ? input.amountMinor : -input.amountMinor;
  await lockStoredValueAccount(db, input.organizationId, input.accountId);
  const changed = await db.$executeRaw(Prisma.sql`
    UPDATE stored_value_accounts SET "balanceMinor"="balanceMinor" + ${delta}, "updatedAt"=CURRENT_TIMESTAMP
    WHERE "organizationId"=${input.organizationId} AND id=${input.accountId}
      AND kind='CUSTOMER_LIABILITY'::"StoredValueAccountKind" AND "balanceMinor" + ${delta} >= 0
  `);
  if (changed !== 1) throw new StoredValueError('INSUFFICIENT_BALANCE');
  await db.$executeRaw(Prisma.sql`
    INSERT INTO stored_value_journals (id, "organizationId", "branchId", kind, "idempotencyKey", "saleId", "actorId", tender, reason)
    VALUES (${input.journalId}, ${input.organizationId}, ${input.branchId ?? null}, ${input.kind}::"StoredValueEntryKind", ${input.idempotencyKey},
      ${input.saleId ?? null}, ${input.actorId}, ${input.tender ?? null}::"PharmacyTenderType", ${input.reason ?? null})
  `);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO stored_value_entries (id, "organizationId", "journalId", "accountId", "amountMinor") VALUES
      (${`${input.journalId}:wallet`}, ${input.organizationId}, ${input.journalId}, ${input.accountId}, ${delta}),
      (${`${input.journalId}:counterparty`}, ${input.organizationId}, ${input.journalId}, ${input.counterpartyAccountId}, ${-delta})
  `);
  return { balanceDeltaMinor: delta };
}

export async function readStoredValueStatement(db: StoredValueDb, organizationId: string, accountId: string) {
  return db.$queryRaw(Prisma.sql`
    SELECT * FROM stored_value_customer_statements WHERE "organizationId"=${organizationId} AND "accountId"=${accountId}
    ORDER BY "occurredAt", "journalId"
  `);
}
