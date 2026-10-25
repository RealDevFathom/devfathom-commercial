import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { assertMinor } from './accounts';

export type StoredValueKind = 'TOP_UP' | 'SPEND' | 'REFUND' | 'EXPIRY' | 'ADJUSTMENT';
export type StoredValueDb = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};
export type StoredValueJournalInput = {
  organizationId: string;
  journalId: string;
  idempotencyKey: string;
  kind: StoredValueKind;
  accountId: string;
  counterpartyAccountId: string;
  amountMinor: number;
  direction: 'CREDIT' | 'DEBIT';
  currency: 'PKR' | 'USD';
  actorId: string;
  branchId?: string;
  saleId?: string;
  tender?: string;
  reason?: string;
  originalJournalId?: string;
};
export type StoredValueAccountRow = {
  id: string;
  customerId: string | null;
  kind: 'CUSTOMER_LIABILITY' | 'CASH_CLEARING' | 'SALES_CLEARING';
  currency: string;
  balanceMinor: number;
};
export type StoredValueJournalRow = {
  id: string;
  organizationId: string;
  branchId: string | null;
  kind: StoredValueKind;
  idempotencyKey: string;
  saleId: string | null;
  actorId: string;
  tender: string | null;
  reason: string | null;
  currency: string | null;
  originalJournalId: string | null;
  occurredAt: Date;
};
export type StoredValueEntryRow = { id: string; accountId: string; amountMinor: number };

export class StoredValueError extends Error {
  constructor(
    readonly reason:
      | 'INSUFFICIENT_BALANCE'
      | 'IDEMPOTENCY_CONFLICT'
      | 'ACCOUNT_NOT_FOUND'
      | 'INVALID_ACCOUNT'
      | 'CURRENCY_MISMATCH'
      | 'INVALID_INPUT'
  ) {
    super(reason);
    this.name = 'StoredValueError';
  }
}

/** Serialize even conflicting retries aimed at different customer accounts. */
export async function lockStoredValueOperation(
  db: StoredValueDb,
  organizationId: string,
  idempotencyKey: string
) {
  await db.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([organizationId, idempotencyKey])}, 0))::text
  `);
}

/** Lock before calculating a spend. Tenant predicate is mandatory even with RLS. */
export async function lockStoredValueAccount(
  db: StoredValueDb,
  organizationId: string,
  accountId: string
) {
  const rows = await db.$queryRaw<StoredValueAccountRow[]>(Prisma.sql`
    SELECT id, "customerId", kind::text, currency, "balanceMinor" FROM stored_value_accounts
    WHERE "organizationId"=${organizationId} AND id=${accountId} FOR UPDATE
  `);
  if (!rows[0]) throw new StoredValueError('ACCOUNT_NOT_FOUND');
  return rows[0];
}

export async function readStoredValueJournal(
  db: StoredValueDb,
  organizationId: string,
  journalId: string
) {
  const rows = await db.$queryRaw<StoredValueJournalRow[]>(Prisma.sql`
    SELECT id, "organizationId", "branchId", kind::text, "idempotencyKey", "saleId", "actorId",
      tender::text, reason, currency::text, "originalJournalId", "occurredAt"
    FROM stored_value_journals WHERE "organizationId"=${organizationId} AND id=${journalId}
  `);
  return rows[0] ?? null;
}

export async function readStoredValueEntries(
  db: StoredValueDb,
  organizationId: string,
  journalId: string
) {
  return db.$queryRaw<StoredValueEntryRow[]>(Prisma.sql`
    SELECT id, "accountId", "amountMinor" FROM stored_value_entries
    WHERE "organizationId"=${organizationId} AND "journalId"=${journalId} ORDER BY id
  `);
}

/**
 * Subledger primitive, not a user-facing pharmacy command. Must use the owning
 * transaction and propagate failures. Pharmacy composes this through its
 * canonical finance bridge; a caller must not catch and commit half an event.
 */
export async function postStoredValueJournal(db: StoredValueDb, input: StoredValueJournalInput) {
  assertMinor(input.amountMinor);
  if (
    !input.journalId.trim() ||
    !input.idempotencyKey.trim() ||
    input.accountId === input.counterpartyAccountId
  )
    throw new StoredValueError('INVALID_INPUT');
  if (input.kind === 'ADJUSTMENT' && !input.reason?.trim())
    throw new RangeError('ADJUSTMENT_REASON_REQUIRED');
  const delta = input.direction === 'CREDIT' ? input.amountMinor : -input.amountMinor;
  await lockStoredValueOperation(db, input.organizationId, input.idempotencyKey);

  // Stable account order; both the liability cache and its counterparty must be
  // proven local and same-currency before any balance or evidence is changed.
  const accounts = await db.$queryRaw<StoredValueAccountRow[]>(Prisma.sql`
    SELECT id, "customerId", kind::text, currency, "balanceMinor" FROM stored_value_accounts
    WHERE "organizationId"=${input.organizationId} AND id IN (${input.accountId}, ${input.counterpartyAccountId})
    ORDER BY id FOR UPDATE
  `);
  const wallet = accounts.find((row) => row.id === input.accountId);
  const counterparty = accounts.find((row) => row.id === input.counterpartyAccountId);
  if (!wallet || !counterparty) throw new StoredValueError('ACCOUNT_NOT_FOUND');
  if (
    wallet.kind !== 'CUSTOMER_LIABILITY' ||
    !wallet.customerId ||
    counterparty.customerId !== null ||
    counterparty.kind === 'CUSTOMER_LIABILITY'
  )
    throw new StoredValueError('INVALID_ACCOUNT');
  if (wallet.currency !== input.currency || counterparty.currency !== input.currency)
    throw new StoredValueError('CURRENCY_MISMATCH');

  const prior = await db.$queryRaw<StoredValueJournalRow[]>(Prisma.sql`
    SELECT id, "organizationId", "branchId", kind::text, "idempotencyKey", "saleId", "actorId",
      tender::text, reason, currency::text, "originalJournalId", "occurredAt"
    FROM stored_value_journals WHERE "organizationId"=${input.organizationId}
      AND ("idempotencyKey"=${input.idempotencyKey} OR id=${input.journalId})
  `);
  if (prior.length) {
    const original = prior[0];
    const entries = await readStoredValueEntries(db, input.organizationId, original.id);
    const matches =
      prior.length === 1 &&
      original.id === input.journalId &&
      original.organizationId === input.organizationId &&
      original.idempotencyKey === input.idempotencyKey &&
      original.kind === input.kind &&
      original.branchId === (input.branchId ?? null) &&
      original.saleId === (input.saleId ?? null) &&
      original.actorId === input.actorId &&
      original.tender === (input.tender ?? null) &&
      original.reason === (input.reason ?? null) &&
      original.currency === input.currency &&
      original.originalJournalId === (input.originalJournalId ?? null) &&
      entries.length === 2 &&
      entries.some(
        (row) =>
          row.id === `${original.id}:wallet` &&
          row.accountId === wallet.id &&
          row.amountMinor === delta
      ) &&
      entries.some(
        (row) =>
          row.id === `${original.id}:counterparty` &&
          row.accountId === counterparty.id &&
          row.amountMinor === -delta
      );
    if (!matches) throw new StoredValueError('IDEMPOTENCY_CONFLICT');
    return { journal: original, entries, balanceDeltaMinor: 0, replayed: true };
  }

  const changed = await db.$executeRaw(Prisma.sql`
    UPDATE stored_value_accounts SET "balanceMinor"="balanceMinor" + ${delta}, "updatedAt"=CURRENT_TIMESTAMP
    WHERE "organizationId"=${input.organizationId} AND id=${input.accountId}
      AND kind='CUSTOMER_LIABILITY'::"StoredValueAccountKind" AND "balanceMinor" + ${delta} >= 0
  `);
  if (changed !== 1) throw new StoredValueError('INSUFFICIENT_BALANCE');
  const inserted = await db.$queryRaw<StoredValueJournalRow[]>(Prisma.sql`
    INSERT INTO stored_value_journals (id, "organizationId", "branchId", kind, "idempotencyKey", "saleId", "actorId", tender, reason, currency, "originalJournalId")
    VALUES (${input.journalId}, ${input.organizationId}, ${input.branchId ?? null}, ${input.kind}::"StoredValueEntryKind", ${input.idempotencyKey},
      ${input.saleId ?? null}, ${input.actorId}, ${input.tender ?? null}::"PharmacyTenderType", ${input.reason ?? null},
      ${input.currency}::"Currency", ${input.originalJournalId ?? null})
    RETURNING id, "organizationId", "branchId", kind::text, "idempotencyKey", "saleId", "actorId", tender::text,
      reason, currency::text, "originalJournalId", "occurredAt"
  `);
  if (!inserted[0]) throw new StoredValueError('INVALID_INPUT');
  await db.$executeRaw(Prisma.sql`
    INSERT INTO stored_value_entries (id, "organizationId", "journalId", "accountId", "amountMinor") VALUES
      (${`${input.journalId}:wallet`}, ${input.organizationId}, ${input.journalId}, ${input.accountId}, ${delta}),
      (${`${input.journalId}:counterparty`}, ${input.organizationId}, ${input.journalId}, ${input.counterpartyAccountId}, ${-delta})
  `);
  return {
    journal: inserted[0],
    entries: await readStoredValueEntries(db, input.organizationId, input.journalId),
    balanceDeltaMinor: delta,
    replayed: false,
  };
}

export async function readStoredValueStatement(
  db: StoredValueDb,
  organizationId: string,
  accountId: string
) {
  return db.$queryRaw(Prisma.sql`
    SELECT * FROM stored_value_customer_statements WHERE "organizationId"=${organizationId} AND "accountId"=${accountId}
    ORDER BY "occurredAt", "journalId"
  `);
}
