import type {
  Currency,
  PharmacyAllocationSourceKind,
  PharmacyBookkeepingKind,
  PharmacyChequeStatus,
  PharmacyTenderType,
} from '@/generated/prisma/client';
import {
  postJournalEntry,
  reverseJournalEntry,
  type JournalLineInput,
} from '@/lib/finance/journal';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { Prisma } from '@/generated/prisma/client';

export type BookkeepingScope = { organizationId: string; branchId: string; actorId: string };

export type BookkeepingAllocationInput = {
  sourceKind: PharmacyAllocationSourceKind;
  sourceId: string;
  sourceReference: string;
  amountMinor: number;
};

export type PostBookkeepingInput = {
  reference: string;
  kind: PharmacyBookkeepingKind;
  amountMinor: number;
  occurredAt: Date;
  idempotencyKey: string;
  currency?: Currency;
  counterpartyName?: string | null;
  memo?: string | null;
  bankReference?: string | null;
  chequeNumber?: string | null;
  chequeDueAt?: Date | null;
  chequeStatus?: PharmacyChequeStatus;
  fundingAccount?: 'CASH' | 'BANK';
  allocations?: BookkeepingAllocationInput[];
};

export class PharmacyBookkeepingError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_AMOUNT'
      | 'INVALID_ALLOCATION'
      | 'PERIOD_CLOSED'
      | 'NOT_FOUND'
      | 'INVALID_STATE'
      | 'MISSING_REASON'
      | 'RECONCILIATION_MISMATCH'
      | 'INVALID_CHEQUE'
  ) {
    super(reason);
    this.name = 'PharmacyBookkeepingError';
  }
}

function positiveMinor(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new PharmacyBookkeepingError('INVALID_AMOUNT');
}

/** Serializes every branch accounting write, including the general-journal adapter. */
export async function lockPharmacyAccountingScope(db: ScopedDb, scope: BookkeepingScope) {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.organizationId}:${scope.branchId}:pharmacy-journal`}, 0))`;
}

async function assertPeriodOpen(db: ScopedDb, scope: BookkeepingScope, at: Date) {
  const closed = await db.pharmacyAccountingPeriod.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'CLOSED',
      startsAt: { lte: at },
      endsAt: { gt: at },
    },
    select: { id: true },
  });
  if (closed) throw new PharmacyBookkeepingError('PERIOD_CLOSED');
}

export function bookkeepingJournalLines(input: PostBookkeepingInput): JournalLineInput[] {
  const funding = input.fundingAccount ?? (input.kind === 'PETTY_CASH' ? 'CASH' : 'BANK');
  const amountMinor = input.amountMinor;
  switch (input.kind) {
    case 'SUPPLIER_PAYMENT':
    case 'VOUCHER':
    case 'CHEQUE':
      return [
        { accountCode: 'ACCOUNTS_PAYABLE', side: 'DEBIT', amountMinor },
        { accountCode: input.kind === 'CHEQUE' ? 'BANK' : funding, side: 'CREDIT', amountMinor },
      ];
    case 'CUSTOMER_RECEIPT':
      return [
        { accountCode: funding, side: 'DEBIT', amountMinor },
        { accountCode: 'ACCOUNTS_RECEIVABLE', side: 'CREDIT', amountMinor },
      ];
    case 'EXPENSE':
    case 'PETTY_CASH':
      return [
        { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor },
        { accountCode: funding, side: 'CREDIT', amountMinor },
      ];
    case 'BANK_DEPOSIT':
      return [
        { accountCode: 'BANK', side: 'DEBIT', amountMinor },
        { accountCode: 'CASH', side: 'CREDIT', amountMinor },
      ];
    case 'SETTLEMENT':
      return [
        { accountCode: 'BANK', side: 'DEBIT', amountMinor },
        { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor },
      ];
  }
}

export async function postBookkeepingTransaction(
  db: ScopedDb,
  scope: BookkeepingScope,
  input: PostBookkeepingInput
) {
  await lockPharmacyAccountingScope(db, scope);
  positiveMinor(input.amountMinor);
  await assertPeriodOpen(db, scope, input.occurredAt);
  if (input.kind === 'CHEQUE' && !input.chequeNumber?.trim())
    throw new PharmacyBookkeepingError('INVALID_CHEQUE');
  const allocations = input.allocations ?? [];
  let allocated = 0;
  for (const allocation of allocations) {
    positiveMinor(allocation.amountMinor);
    if (!allocation.sourceId.trim() || !allocation.sourceReference.trim())
      throw new PharmacyBookkeepingError('INVALID_ALLOCATION');
    allocated += allocation.amountMinor;
  }
  if (allocated > input.amountMinor) throw new PharmacyBookkeepingError('INVALID_ALLOCATION');

  const replay = await db.pharmacyBookkeepingTransaction.findFirst({
    where: { organizationId: scope.organizationId, idempotencyKey: input.idempotencyKey },
    include: { allocations: true },
  });
  if (replay) return replay;

  const transaction = await db.pharmacyBookkeepingTransaction.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      reference: input.reference,
      kind: input.kind,
      amountMinor: input.amountMinor,
      currency: input.currency ?? 'PKR',
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
      counterpartyName: input.counterpartyName,
      memo: input.memo,
      bankReference: input.bankReference,
      chequeNumber: input.chequeNumber,
      chequeDueAt: input.chequeDueAt,
      chequeStatus: input.kind === 'CHEQUE' ? (input.chequeStatus ?? 'PDC') : 'NONE',
      createdByUserId: scope.actorId,
      allocations: {
        create: allocations,
      },
    },
    include: { allocations: true },
  });
  const entry = await postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
    sourceId: transaction.id,
    description: `${input.kind.replaceAll('_', ' ').toLowerCase()} ${input.reference}`,
    occurredAt: input.occurredAt,
    idempotencyKey: `bookkeeping:${input.idempotencyKey}`,
    branchId: scope.branchId,
    currency: input.currency ?? 'PKR',
    lines: bookkeepingJournalLines(input).map((line) => ({ ...line, branchId: scope.branchId })),
  });
  return db.pharmacyBookkeepingTransaction.update({
    where: { id: transaction.id },
    data: { status: 'POSTED', postedAt: new Date(), journalEntryId: entry.id },
    include: { allocations: true },
  });
}

export async function reverseBookkeepingTransaction(
  db: ScopedDb,
  scope: BookkeepingScope,
  input: { transactionId: string; at: Date; reason: string; idempotencyKey: string }
) {
  await lockPharmacyAccountingScope(db, scope);
  if (!input.reason.trim()) throw new PharmacyBookkeepingError('MISSING_REASON');
  await assertPeriodOpen(db, scope, input.at);
  const transaction = await db.pharmacyBookkeepingTransaction.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: input.transactionId,
    },
    include: { bankMatches: { where: { reversedAt: null } } },
  });
  if (!transaction?.journalEntryId) throw new PharmacyBookkeepingError('NOT_FOUND');
  if (transaction.status === 'REVERSED') return transaction;
  if (transaction.status !== 'POSTED') throw new PharmacyBookkeepingError('INVALID_STATE');
  const reversal = await reverseJournalEntry(db, scope, {
    entryId: transaction.journalEntryId,
    reason: input.reason,
    at: input.at,
    idempotencyKey: `bookkeeping-reversal:${input.idempotencyKey}`,
  });
  if (transaction.bankMatches.length) {
    await db.pharmacyBankReconciliation.updateMany({
      where: {
        organizationId: scope.organizationId,
        transactionId: transaction.id,
        reversedAt: null,
      },
      data: { reversedAt: input.at, reversalReason: input.reason },
    });
    await db.pharmacyBankStatementLine.updateMany({
      where: {
        organizationId: scope.organizationId,
        id: { in: transaction.bankMatches.map((match) => match.statementLineId) },
      },
      data: { status: 'REVERSED' },
    });
  }
  return db.pharmacyBookkeepingTransaction.update({
    where: { id: transaction.id },
    data: {
      status: 'REVERSED',
      reversedAt: input.at,
      reversalReason: input.reason,
      reversalEntryId: reversal.id,
    },
    include: { allocations: true },
  });
}

export async function closeAccountingPeriod(
  db: ScopedDb,
  scope: BookkeepingScope,
  input: { startsAt: Date; endsAt: Date }
) {
  await lockPharmacyAccountingScope(db, scope);
  if (input.startsAt >= input.endsAt) throw new PharmacyBookkeepingError('INVALID_STATE');
  return db.pharmacyAccountingPeriod.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: 'CLOSED',
      closedAt: new Date(),
      closedByUserId: scope.actorId,
    },
  });
}

export async function reopenAccountingPeriod(
  db: ScopedDb,
  scope: BookkeepingScope,
  input: { periodId: string; reason: string }
) {
  await lockPharmacyAccountingScope(db, scope);
  if (!input.reason.trim()) throw new PharmacyBookkeepingError('MISSING_REASON');
  const period = await db.pharmacyAccountingPeriod.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: input.periodId },
  });
  if (!period) throw new PharmacyBookkeepingError('NOT_FOUND');
  if (period.status !== 'CLOSED') throw new PharmacyBookkeepingError('INVALID_STATE');
  return db.pharmacyAccountingPeriod.update({
    where: { id: period.id },
    data: {
      status: 'REOPENED',
      reopenedAt: new Date(),
      reopenedByUserId: scope.actorId,
      reopenReason: input.reason,
    },
  });
}

export async function reconcileBankLine(
  db: ScopedDb,
  scope: BookkeepingScope,
  input: { statementLineId: string; transactionId: string; amountMinor: number }
) {
  positiveMinor(input.amountMinor);
  // Share the statement-line lock with POS settlement matching so neither
  // target can consume the same remaining statement amount concurrently.
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_bank_statement_lines
    WHERE id=${input.statementLineId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} FOR UPDATE`);
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_bookkeeping_transactions
    WHERE id=${input.transactionId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} FOR UPDATE`);
  const [line, transaction] = await Promise.all([
    db.pharmacyBankStatementLine.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        id: input.statementLineId,
      },
      include: { matches: { where: { reversedAt: null } } },
    }),
    db.pharmacyBookkeepingTransaction.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        id: input.transactionId,
        status: 'POSTED',
      },
      include: { bankMatches: { where: { reversedAt: null } } },
    }),
  ]);
  if (!line || !transaction) throw new PharmacyBookkeepingError('NOT_FOUND');
  const lineMatched = line.matches.reduce((sum, match) => sum + match.amountMinor, 0);
  const transactionMatched = transaction.bankMatches.reduce(
    (sum, match) => sum + match.amountMinor,
    0
  );
  if (
    lineMatched + input.amountMinor > Math.abs(line.amountMinor) ||
    transactionMatched + input.amountMinor > transaction.amountMinor
  )
    throw new PharmacyBookkeepingError('RECONCILIATION_MISMATCH');
  const match = await db.pharmacyBankReconciliation.create({
    data: {
      organizationId: scope.organizationId,
      statementLineId: line.id,
      transactionId: transaction.id,
      amountMinor: input.amountMinor,
      matchedByUserId: scope.actorId,
    },
  });
  if (lineMatched + input.amountMinor === Math.abs(line.amountMinor)) {
    await db.pharmacyBankStatementLine.update({
      where: { id: line.id },
      data: { status: 'MATCHED' },
    });
  }
  return match;
}

/** Match already-posted POS receipts; matching creates no new journal entry. */
export async function reconcileSettlementBankLine(
  db: ScopedDb, scope: BookkeepingScope,
  input: { statementLineId: string; settlementBatchId: string; amountMinor: number }
) {
  positiveMinor(input.amountMinor);
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_bank_statement_lines
    WHERE id=${input.statementLineId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} FOR UPDATE`);
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_settlement_batches
    WHERE id=${input.settlementBatchId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} FOR UPDATE`);
  const [line, batch] = await Promise.all([
    db.pharmacyBankStatementLine.findFirst({
      where: { organizationId: scope.organizationId, branchId: scope.branchId, id: input.statementLineId },
      include: { matches: { where: { reversedAt: null } } },
    }),
    db.pharmacySettlementBatch.findFirst({
      where: { organizationId: scope.organizationId, branchId: scope.branchId, id: input.settlementBatchId },
      include: { bankMatches: { where: { reversedAt: null } } },
    }),
  ]);
  if (!line || !batch) throw new PharmacyBookkeepingError('NOT_FOUND');
  const lineMatched = line.matches.reduce((sum, match) => sum + match.amountMinor, 0);
  const batchMatched = batch.bankMatches.reduce((sum, match) => sum + match.amountMinor, 0);
  if (line.amountMinor <= 0 || lineMatched + input.amountMinor > line.amountMinor ||
      batchMatched + input.amountMinor > batch.expectedMinor)
    throw new PharmacyBookkeepingError('RECONCILIATION_MISMATCH');
  const match = await db.pharmacyBankReconciliation.create({ data: {
    organizationId: scope.organizationId, statementLineId: line.id,
    settlementBatchId: batch.id, amountMinor: input.amountMinor, matchedByUserId: scope.actorId,
  } });
  if (lineMatched + input.amountMinor === line.amountMinor)
    await db.pharmacyBankStatementLine.update({ where: { id: line.id }, data: { status: 'MATCHED' } });
  const settledMinor = batchMatched + input.amountMinor;
  await db.pharmacySettlementBatch.update({ where: { id: batch.id }, data: {
    settledMinor, settledAt: settledMinor === batch.expectedMinor ? new Date() : null,
    bankReference: line.statementRef,
  } });
  return match;
}

export async function createSettlementBatch(
  db: ScopedDb,
  scope: BookkeepingScope,
  input: {
    reference: string;
    provider: string;
    tenderType: PharmacyTenderType;
    businessDate: Date;
    tenderIds: string[];
  }
) {
  const tenders = await db.pharmacyTender.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: { in: input.tenderIds },
      type: input.tenderType,
    },
  });
  if (tenders.length !== new Set(input.tenderIds).size)
    throw new PharmacyBookkeepingError('NOT_FOUND');
  const expectedMinor = tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
  return db.pharmacySettlementBatch.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      reference: input.reference,
      provider: input.provider,
      tenderType: input.tenderType,
      businessDate: input.businessDate,
      expectedMinor,
      createdByUserId: scope.actorId,
      tenders: {
        create: tenders.map((tender) => ({
          organizationId: scope.organizationId,
          tenderId: tender.id,
          amountMinor: tender.amountMinor,
        })),
      },
    },
    include: { tenders: true },
  });
}
