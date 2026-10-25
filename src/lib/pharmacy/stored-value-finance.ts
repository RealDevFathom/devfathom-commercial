import 'server-only';
import { Prisma, type Currency } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import { postJournalEntry, type PostJournalEntryInput } from '@/lib/finance/journal';
import { assertMinor } from '@/lib/stored-value/accounts';
import {
  lockStoredValueOperation,
  postStoredValueJournal,
  readStoredValueEntries,
  readStoredValueJournal,
  type StoredValueAccountRow,
  type StoredValueJournalRow,
} from '@/lib/stored-value/ledger';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import type { PostingScope } from './finance-postings';

export type StoredValuePostingScope = PostingScope & { currency: Currency };
/** Internal funded event, not the provider-WALLET or earned LOYALTY tender.
 * REFUND remains representable for forensic provenance only; both callable
 * boundaries reject it regardless of settings, grants, balances or original.
 */
export type PharmacyStoredValueCommand = {
  journalId: string;
  idempotencyKey: string;
  accountId: string;
  counterpartyAccountId: string;
  amountMinor: number;
  reason?: string;
} & (
  | { kind: 'TOP_UP'; tender: 'CASH' | 'BANK_TRANSFER'; saleId?: never; originalJournalId?: never }
  | { kind: 'SPEND'; saleId: string; tender?: never; originalJournalId?: never }
  | { kind: 'REFUND'; originalJournalId: string; tender?: never; saleId?: never }
);

export class PharmacyStoredValueError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PharmacyStoredValueError';
  }
}
function refuse(reason: string): never {
  throw new PharmacyStoredValueError(reason);
}

function validateScope(scope: StoredValuePostingScope) {
  for (const value of [scope.organizationId, scope.branchId, scope.actorId]) {
    // Undefined Prisma predicates are omitted: never let them widen a check.
    if (typeof value !== 'string' || !value.trim()) refuse('WALLET_SCOPE_DENIED');
  }
  if (scope.currency !== 'PKR' && scope.currency !== 'USD') refuse('WALLET_CURRENCY_MISMATCH');
}

/** Re-read active tenant/branch assignment and canonical grants; no ADMIN bypass. */
async function authorize(
  db: ScopedDb,
  scope: StoredValuePostingScope,
  command: PharmacyStoredValueCommand
) {
  const organization = await db.organization.findFirst({
    where: { id: scope.organizationId },
    select: { currency: true },
  });
  const actor = await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId },
    select: { id: true, role: true, department: true, status: true },
  });
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { id: true },
  });
  const assignment = await db.pharmacyBranchAssignment.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      userId: scope.actorId,
      active: true,
    },
    select: { id: true },
  });
  if (
    !organization ||
    !actor ||
    !actor.status ||
    !ACTIVE_STATUSES.has(actor.status) ||
    !branch ||
    !assignment
  )
    refuse('WALLET_SCOPE_DENIED');
  if (scope.currency !== organization.currency) refuse('WALLET_CURRENCY_MISMATCH');
  const action =
    command.kind === 'SPEND'
      ? 'pharmacy:counter'
      : command.kind === 'REFUND'
        ? 'pharmacy:manage'
        : 'pharmacy:wallet-topup';
  if (!(await can(subjectFromSession(actor), action, undefined, { db })))
    refuse('WALLET_PERMISSION_DENIED');
}

function validateCommand(command: PharmacyStoredValueCommand, scope: StoredValuePostingScope) {
  // Source provenance and allowUnusedRefund are NOT product authorization.
  // Quarantine the candidate implementation below: no new payout or replay of
  // an old refund may pass either exported boundary until policy is approved.
  if (['REFUND'].includes(command.kind)) refuse('WALLET_REFUND_NOT_APPROVED');
  // PharmacySale/Tender have no currency column; canonical sale/settlement
  // adapters post PKR. Never settle their clearing with a USD wallet, even in
  // an otherwise consistently USD tenant. No implicit conversion or FX.
  if (command.kind === 'SPEND' && scope.currency !== 'PKR') refuse('WALLET_CURRENCY_MISMATCH');
  assertMinor(command.amountMinor);
  // The subledger stores PostgreSQL INTEGER minor units.
  if (command.amountMinor > 2_147_483_647) refuse('WALLET_AMOUNT_RANGE');
  for (const value of [
    command.journalId,
    command.idempotencyKey,
    command.accountId,
    command.counterpartyAccountId,
  ]) {
    if (typeof value !== 'string' || !value.trim()) refuse('WALLET_INVALID_INPUT');
  }
  if (command.accountId === command.counterpartyAccountId) refuse('WALLET_INVALID_INPUT');
  if (command.kind === 'TOP_UP') {
    if (
      !['CASH', 'BANK_TRANSFER'].includes(command.tender) ||
      command.saleId ||
      command.originalJournalId
    )
      refuse('WALLET_UNSUPPORTED_TENDER');
  } else if (command.kind === 'SPEND') {
    if (!command.saleId?.trim() || command.tender || command.originalJournalId)
      refuse('WALLET_INVALID_INPUT');
  } else if (command.kind === 'REFUND') {
    if (
      !command.originalJournalId?.trim() ||
      command.originalJournalId === command.journalId ||
      command.saleId ||
      command.tender
    )
      refuse('WALLET_INVALID_INPUT');
  } else {
    refuse('WALLET_UNSUPPORTED_KIND');
  }
}

function canonicalInput(
  scope: StoredValuePostingScope,
  journal: StoredValueJournalRow,
  amountMinor: number,
  direction: 'CREDIT' | 'DEBIT',
  tender: 'CASH' | 'BANK_TRANSFER' | null
): PostJournalEntryInput {
  const walletSide = direction === 'CREDIT' ? 'CREDIT' : 'DEBIT';
  return {
    sourceKind: 'PHARMACY_STORED_VALUE_JOURNAL',
    sourceId: journal.id,
    idempotencyKey: `finance:PHARMACY_STORED_VALUE_JOURNAL:${journal.id}`,
    description: `Funded wallet ${journal.kind.toLowerCase()}`,
    branchId: journal.branchId,
    currency: scope.currency,
    occurredAt: journal.occurredAt,
    lines: [
      {
        accountCode: 'CUSTOMER_WALLET_LIABILITY',
        side: walletSide,
        amountMinor,
        branchId: journal.branchId,
        sourceLineId: `${journal.id}:wallet`,
      },
      {
        accountCode:
          journal.kind === 'SPEND' ? 'SALES_CLEARING' : tender === 'CASH' ? 'CASH' : 'BANK',
        side: walletSide === 'CREDIT' ? 'DEBIT' : 'CREDIT',
        amountMinor,
        branchId: journal.branchId,
        sourceLineId: `${journal.id}:counterparty`,
      },
    ],
  };
}

type CanonicalRow = Prisma.FinanceJournalEntryGetPayload<{ include: { lines: true } }>;

/** Kernel's key-only early return is not a semantic retry proof. */
function assertCanonical(
  actual: CanonicalRow | undefined,
  scope: StoredValuePostingScope,
  expected: PostJournalEntryInput
) {
  if (
    !actual ||
    actual.organizationId !== scope.organizationId ||
    actual.branchId !== expected.branchId ||
    actual.sourceKind !== expected.sourceKind ||
    actual.sourceId !== expected.sourceId ||
    actual.currency !== expected.currency ||
    actual.idempotencyKey !== expected.idempotencyKey ||
    actual.actorId !== scope.actorId ||
    actual.description !== expected.description ||
    actual.reversesEntryId != null ||
    actual.reversalReason != null ||
    actual.occurredAt.getTime() !== expected.occurredAt.getTime() ||
    actual.lines.length !== expected.lines.length ||
    !expected.lines.every((line) =>
      actual.lines.some(
        (row) =>
          row.organizationId === scope.organizationId &&
          row.accountCode === line.accountCode &&
          row.side === line.side &&
          row.amountMinor === line.amountMinor &&
          row.branchId === line.branchId &&
          row.sourceLineId === line.sourceLineId &&
          row.productId == null &&
          row.lotId == null &&
          row.locationId == null &&
          row.memo == null
      )
    )
  )
    refuse('WALLET_CANONICAL_CONFLICT');
}

async function readCanonical(db: ScopedDb, scope: StoredValuePostingScope, sourceId: string) {
  // Source is indexed, NOT unique in the canonical schema. Surface duplicates
  // and colliding keys rather than hiding either with a findFirst shortcut.
  return db.financeJournalEntry.findMany({
    where: {
      organizationId: scope.organizationId,
      OR: [
        { sourceKind: 'PHARMACY_STORED_VALUE_JOURNAL', sourceId },
        { idempotencyKey: `finance:PHARMACY_STORED_VALUE_JOURNAL:${sourceId}` },
      ],
    },
    include: { lines: true },
  });
}

/** QUARANTINED unapproved provenance candidate. validateCommand blocks every
 * REFUND (including retry) before any transaction, lookup or write. Do not
 * expose this helper or treat these historical checks as product approval. */
async function unusedTopUpRefund(
  db: ScopedDb,
  scope: StoredValuePostingScope,
  command: PharmacyStoredValueCommand & { kind: 'REFUND' },
  wallet: StoredValueAccountRow,
  counterparty: StoredValueAccountRow
) {
  const original = await readStoredValueJournal(
    db,
    scope.organizationId,
    command.originalJournalId
  );
  // No immutable sale-return reference exists in the legacy wallet header.
  // Such sale-refund credits remain unsupported, not fabricated economic value.
  if (
    !original ||
    original.kind !== 'TOP_UP' ||
    original.branchId !== scope.branchId ||
    original.currency !== scope.currency ||
    original.saleId ||
    original.originalJournalId ||
    !['CASH', 'BANK_TRANSFER'].includes(original.tender ?? '')
  )
    refuse('WALLET_UNPROVEN_REFUND');
  const entries = await readStoredValueEntries(db, scope.organizationId, original.id);
  const funded = entries.find(
    (row) =>
      row.id === `${original.id}:wallet` && row.accountId === wallet.id && row.amountMinor > 0
  );
  if (
    !funded ||
    entries.length !== 2 ||
    !entries.some(
      (row) =>
        row.id === `${original.id}:counterparty` &&
        row.accountId === counterparty.id &&
        row.amountMinor === -funded.amountMinor
    )
  )
    refuse('WALLET_UNPROVEN_REFUND');
  const originals = await readCanonical(db, scope, original.id);
  if (originals.length !== 1) refuse('WALLET_CANONICAL_CONFLICT');
  // Refund manager may differ from the original cashier.
  assertCanonical(
    originals[0],
    { ...scope, actorId: original.actorId },
    canonicalInput(
      scope,
      original,
      funded.amountMinor,
      'CREDIT',
      original.tender as 'CASH' | 'BANK_TRANSFER'
    )
  );
  const settings = await db.$queryRaw<{ allowUnusedRefund: boolean }[]>(Prisma.sql`
    SELECT "allowUnusedRefund" FROM pharmacy_wallet_settings WHERE "organizationId"=${scope.organizationId}
  `);
  if (!settings[0]?.allowUnusedRefund) refuse('TOP_UP_REFUND_DISABLED');
  // Conservative fail-closed bound, NOT a fungible-funds allocation policy:
  // EVERY lifetime debit counts, including previous original-source refunds.
  // CURRENT_TIMESTAMP is transaction-start time; a waiting writer can therefore
  // have an earlier timestamp than a committed funding event. Time-filtering
  // debits would incorrectly make consumed funds refundable after replenishment.
  // This may under-refund older wallets; do not infer FIFO or replenish provenance.
  const debits = await db.$queryRaw<{ spentMinor: bigint }[]>(Prisma.sql`
    SELECT COALESCE(SUM(-e."amountMinor"), 0)::bigint AS "spentMinor"
    FROM stored_value_entries e JOIN stored_value_journals j ON j.id=e."journalId" AND j."organizationId"=e."organizationId"
    WHERE e."organizationId"=${scope.organizationId} AND e."accountId"=${wallet.id}
      AND e."amountMinor" < 0
  `);
  if (BigInt(command.amountMinor) + BigInt(debits[0]?.spentMinor ?? 0) > BigInt(funded.amountMinor))
    refuse('WALLET_REFUND_EXCEEDS_UNUSED');
  return original.tender as 'CASH' | 'BANK_TRANSFER';
}

/**
 * Same-tx adapter for an eventual owning event caller. Caller MUST propagate
 * errors and not commit a caught failure. Does not update checkout/tenders.
 * This is NOT an identity, OTP, consent, licence or physical-card verifier:
 * the eventual operation boundary must retain those existing policy gates.
 * Do not expose this financial primitive directly as a counter endpoint.
 */
export async function postPharmacyStoredValueInTransaction(
  db: ScopedDb,
  scope: StoredValuePostingScope,
  command: PharmacyStoredValueCommand
) {
  validateScope(scope);
  validateCommand(command, scope);
  await authorize(db, scope, command);
  await lockStoredValueOperation(db, scope.organizationId, command.idempotencyKey);
  const accounts = await db.$queryRaw<StoredValueAccountRow[]>(Prisma.sql`
    SELECT id, "customerId", kind::text, currency, "balanceMinor" FROM stored_value_accounts
    WHERE "organizationId"=${scope.organizationId} AND id IN (${command.accountId}, ${command.counterpartyAccountId}) ORDER BY id FOR UPDATE
  `);
  const wallet = accounts.find((row) => row.id === command.accountId);
  const counterparty = accounts.find((row) => row.id === command.counterpartyAccountId);
  if (
    !wallet ||
    !counterparty ||
    wallet.kind !== 'CUSTOMER_LIABILITY' ||
    !wallet.customerId ||
    counterparty.customerId !== null ||
    counterparty.kind !== (command.kind === 'SPEND' ? 'SALES_CLEARING' : 'CASH_CLEARING')
  )
    refuse('WALLET_ACCOUNT_SCOPE');
  if (wallet.currency !== scope.currency || counterparty.currency !== scope.currency)
    refuse('WALLET_CURRENCY_MISMATCH');
  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId: scope.organizationId, id: wallet.customerId, active: true },
    select: { id: true },
  });
  if (!customer) refuse('WALLET_ACCOUNT_SCOPE');
  const prior = await readStoredValueJournal(db, scope.organizationId, command.journalId);
  let tender: 'CASH' | 'BANK_TRANSFER' | null = command.kind === 'TOP_UP' ? command.tender : null;
  if (command.kind === 'SPEND') {
    const sales = await db.$queryRaw<
      { id: string; customerId: string | null; status: string }[]
    >(Prisma.sql`
      SELECT id, "customerId", status::text FROM pharmacy_sales
      WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${command.saleId} FOR UPDATE
    `);
    const sale = sales[0];
    if (
      !sale ||
      sale.customerId !== wallet.customerId ||
      sale.status === 'VOID' ||
      sale.status === 'QUOTATION'
    )
      refuse('WALLET_SALE_SCOPE');
    if (!prior) {
      const spent = await db.$queryRaw<{ spentMinor: bigint }[]>(Prisma.sql`
        SELECT COALESCE(SUM(-e."amountMinor"), 0)::bigint AS "spentMinor"
        FROM stored_value_entries e JOIN stored_value_journals j ON j.id=e."journalId" AND j."organizationId"=e."organizationId"
        WHERE e."organizationId"=${scope.organizationId} AND e."accountId"=${wallet.id}
          AND j."branchId"=${scope.branchId} AND j."saleId"=${command.saleId} AND j.kind='SPEND'::"StoredValueEntryKind"
      `);
      const lines = await db.pharmacySaleLine.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          saleId: command.saleId,
        },
        select: { quantity: true, unitPriceMinor: true, discountMinor: true },
      });
      const total = lines.reduce(
        (sum, line) =>
          sum + BigInt(line.quantity) * BigInt(line.unitPriceMinor) - BigInt(line.discountMinor),
        BigInt(0)
      );
      const tendered = await db.pharmacyTender.aggregate({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          saleId: command.saleId,
        },
        _sum: { amountMinor: true },
      });
      // Existing non-wallet tenders and previous funded spends are counted once.
      // A future caller must use this boundary BEFORE its own tender is added.
      if (
        BigInt(tendered._sum.amountMinor ?? 0) +
          BigInt(spent[0]?.spentMinor ?? 0) +
          BigInt(command.amountMinor) >
        total
      )
        refuse('WALLET_SALE_ALREADY_FUNDED');
    }
  }
  if (command.kind === 'REFUND') {
    if (prior) {
      const original = await readStoredValueJournal(
        db,
        scope.organizationId,
        command.originalJournalId
      );
      if (
        !original ||
        original.kind !== 'TOP_UP' ||
        original.branchId !== scope.branchId ||
        !['CASH', 'BANK_TRANSFER'].includes(original.tender ?? '')
      )
        refuse('WALLET_UNPROVEN_REFUND');
      tender = original.tender as 'CASH' | 'BANK_TRANSFER';
    } else {
      tender = await unusedTopUpRefund(db, scope, command, wallet, counterparty);
    }
  }
  const direction = command.kind === 'TOP_UP' ? 'CREDIT' : 'DEBIT';
  const result = await postStoredValueJournal(db, {
    organizationId: scope.organizationId,
    actorId: scope.actorId,
    currency: scope.currency,
    journalId: command.journalId,
    idempotencyKey: command.idempotencyKey,
    branchId: scope.branchId,
    kind: command.kind,
    accountId: command.accountId,
    counterpartyAccountId: command.counterpartyAccountId,
    amountMinor: command.amountMinor,
    direction,
    tender: tender ?? undefined,
    saleId: command.kind === 'SPEND' ? command.saleId : undefined,
    originalJournalId: command.kind === 'REFUND' ? command.originalJournalId : undefined,
    reason: command.reason,
  });
  const expected = canonicalInput(scope, result.journal, command.amountMinor, direction, tender);
  const existing = await readCanonical(db, scope, result.journal.id);
  if (result.replayed) {
    if (existing.length !== 1) refuse('WALLET_CANONICAL_CONFLICT');
    assertCanonical(existing[0], scope, expected);
    return { ...result, canonicalJournalId: existing[0].id };
  }
  if (existing.length) refuse('WALLET_CANONICAL_CONFLICT');
  const posted = await postJournalEntry(db, scope, expected);
  assertCanonical(posted, scope, expected);
  return { ...result, canonicalJournalId: posted.id };
}

/** Owns one tenant-scoped transaction; a failure rolls back every new effect. */
export async function postPharmacyStoredValue(
  scope: StoredValuePostingScope,
  command: PharmacyStoredValueCommand
) {
  validateScope(scope);
  validateCommand(command, scope);
  return withTenantDb(
    scope.organizationId,
    (db) => postPharmacyStoredValueInTransaction(db, scope, command),
    { userId: scope.actorId }
  );
}
