import { createHash } from 'node:crypto';
import type { Currency } from '@/generated/prisma/client';
import { postJournalEntry, reverseJournalEntry } from '@/lib/finance/journal';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { lockPharmacyAccountingScope } from '@/lib/pharmacy/bookkeeping';
import { GENERAL_JOURNAL_MAX_DATE, GENERAL_JOURNAL_MIN_DATE } from './general-journal-schema';

export type GeneralJournalScope = { organizationId: string; branchId: string; actorId: string };
export type DraftInput = {
  reference: string;
  purpose: 'NONTRADE_OPERATING_ACCRUAL';
  amountMinor: number;
  currency: Currency;
  occurredAt: Date;
  evidence: string;
  reason: string;
  idempotencyKey: string;
};

export class PharmacyGeneralJournalError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_AMOUNT'
      | 'INVALID_DATE'
      | 'MISSING_EVIDENCE'
      | 'MISSING_REASON'
      | 'NOT_FOUND'
      | 'STALE_VERSION'
      | 'INVALID_STATE'
      | 'PERIOD_CLOSED'
      | 'REPLAY_MISMATCH'
  ) {
    super(reason);
    this.name = 'PharmacyGeneralJournalError';
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const present = (value: string, reason: 'MISSING_EVIDENCE' | 'MISSING_REASON') => {
  if (!value.trim()) throw new PharmacyGeneralJournalError(reason);
};
const amount = (value: number) => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    throw new PharmacyGeneralJournalError('INVALID_AMOUNT');
};
const date = (value: Date) => {
  if (
    !Number.isFinite(value.getTime()) ||
    value < GENERAL_JOURNAL_MIN_DATE ||
    value >= GENERAL_JOURNAL_MAX_DATE
  )
    throw new PharmacyGeneralJournalError('INVALID_DATE');
};

export async function lockGeneralJournalScope(db: ScopedDb, scope: GeneralJournalScope) {
  await lockPharmacyAccountingScope(db, scope);
}

async function assertOpen(db: ScopedDb, scope: GeneralJournalScope, at: Date) {
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
  if (closed) throw new PharmacyGeneralJournalError('PERIOD_CLOSED');
}

export async function createGeneralJournalDraft(
  db: ScopedDb,
  scope: GeneralJournalScope,
  input: DraftInput
) {
  amount(input.amountMinor);
  date(input.occurredAt);
  present(input.evidence, 'MISSING_EVIDENCE');
  present(input.reason, 'MISSING_REASON');
  await lockGeneralJournalScope(db, scope);
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.organizationId}:${input.idempotencyKey}:pharmacy-jv-create`}, 0))`;
  const payloadHash = digest({
    branchId: scope.branchId,
    reference: input.reference,
    purpose: input.purpose,
    amountMinor: input.amountMinor,
    currency: input.currency,
    occurredAt: input.occurredAt.toISOString(),
    evidence: input.evidence.trim(),
    reason: input.reason.trim(),
  });
  const replay = await db.pharmacyGeneralJournalDocument.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      createKey: input.idempotencyKey,
    },
  });
  if (replay) {
    if (replay.createPayloadHash !== payloadHash)
      throw new PharmacyGeneralJournalError('REPLAY_MISMATCH');
    return replay;
  }
  const keyUsedOutsideBranch = await db.pharmacyGeneralJournalDocument.findFirst({
    where: { organizationId: scope.organizationId, createKey: input.idempotencyKey },
    select: { id: true },
  });
  if (keyUsedOutsideBranch) throw new PharmacyGeneralJournalError('REPLAY_MISMATCH');
  const document = await db.pharmacyGeneralJournalDocument.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      reference: input.reference,
      purpose: input.purpose,
      amountMinor: input.amountMinor,
      currency: input.currency,
      occurredAt: input.occurredAt,
      evidence: input.evidence.trim(),
      reason: input.reason.trim(),
      createKey: input.idempotencyKey,
      createPayloadHash: payloadHash,
      createdByUserId: scope.actorId,
    },
  });
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'FINANCE',
      operation: 'CREATE',
      action: 'pharmacyGeneralJournal.createDraft',
      targetType: 'PharmacyGeneralJournalDocument',
      targetId: document.id,
      result: { version: document.version },
      outcome: 'SUCCESS',
    },
  });
  return document;
}

export async function updateGeneralJournalDraft(
  db: ScopedDb,
  scope: GeneralJournalScope,
  input: Omit<DraftInput, 'idempotencyKey' | 'reference'> & {
    documentId: string;
    reference: string;
    version: number;
  }
) {
  amount(input.amountMinor);
  date(input.occurredAt);
  present(input.evidence, 'MISSING_EVIDENCE');
  present(input.reason, 'MISSING_REASON');
  await lockGeneralJournalScope(db, scope);
  const result = await db.pharmacyGeneralJournalDocument.updateMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: input.documentId,
      version: input.version,
      status: 'DRAFT',
    },
    data: {
      reference: input.reference,
      purpose: input.purpose,
      amountMinor: input.amountMinor,
      currency: input.currency,
      occurredAt: input.occurredAt,
      evidence: input.evidence.trim(),
      reason: input.reason.trim(),
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) throw new PharmacyGeneralJournalError('STALE_VERSION');
  const document = await db.pharmacyGeneralJournalDocument.findFirstOrThrow({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: input.documentId },
  });
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'FINANCE',
      operation: 'UPDATE',
      action: 'pharmacyGeneralJournal.updateDraft',
      targetType: 'PharmacyGeneralJournalDocument',
      targetId: document.id,
      input: { version: input.version },
      result: { version: document.version },
      outcome: 'SUCCESS',
    },
  });
  return document;
}

export async function postGeneralJournal(
  db: ScopedDb,
  scope: GeneralJournalScope,
  input: { documentId: string; version: number; idempotencyKey: string }
) {
  await lockGeneralJournalScope(db, scope);
  const document = await db.pharmacyGeneralJournalDocument.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: input.documentId },
  });
  if (!document) throw new PharmacyGeneralJournalError('NOT_FOUND');
  const payloadHash = digest({ documentId: input.documentId, version: input.version });
  if (document.postKey) {
    if (document.postKey !== input.idempotencyKey || document.postPayloadHash !== payloadHash)
      throw new PharmacyGeneralJournalError('REPLAY_MISMATCH');
    return document;
  }
  if (document.version !== input.version) throw new PharmacyGeneralJournalError('STALE_VERSION');
  if (document.status !== 'DRAFT') throw new PharmacyGeneralJournalError('INVALID_STATE');
  date(document.occurredAt);
  await assertOpen(db, scope, document.occurredAt);
  const entry = await postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_JOURNAL_VOUCHER',
    sourceId: document.id,
    description: `${document.reference}: ${document.reason}`,
    occurredAt: document.occurredAt,
    idempotencyKey: `pharmacy-jv:${document.id}`,
    branchId: scope.branchId,
    currency: document.currency,
    lines: [
      {
        accountCode: 'OPERATING_EXPENSE',
        side: 'DEBIT',
        amountMinor: document.amountMinor,
        branchId: scope.branchId,
        memo: document.evidence,
      },
      {
        accountCode: 'MANUAL_NONTRADE_ACCRUAL',
        side: 'CREDIT',
        amountMinor: document.amountMinor,
        branchId: scope.branchId,
        memo: document.reason,
      },
    ],
  });
  const posted = await db.pharmacyGeneralJournalDocument.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: document.id } },
    data: {
      status: 'POSTED',
      postedAt: new Date(),
      journalEntryId: entry.id,
      postKey: input.idempotencyKey,
      postPayloadHash: payloadHash,
      version: { increment: 1 },
    },
  });
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'FINANCE',
      operation: 'EXECUTE',
      action: 'pharmacyGeneralJournal.post',
      targetType: 'PharmacyGeneralJournalDocument',
      targetId: document.id,
      input: { version: input.version },
      result: { journalEntryId: entry.id },
      outcome: 'SUCCESS',
    },
  });
  return posted;
}

export async function cancelGeneralJournal(
  db: ScopedDb,
  scope: GeneralJournalScope,
  input: { documentId: string; version: number }
) {
  await lockGeneralJournalScope(db, scope);
  const result = await db.pharmacyGeneralJournalDocument.updateMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: input.documentId,
      version: input.version,
      status: 'DRAFT',
    },
    data: { status: 'CANCELLED', cancelledAt: new Date(), version: { increment: 1 } },
  });
  if (result.count !== 1) throw new PharmacyGeneralJournalError('INVALID_STATE');
  const document = await db.pharmacyGeneralJournalDocument.findFirstOrThrow({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: input.documentId },
  });
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'FINANCE',
      operation: 'UPDATE',
      action: 'pharmacyGeneralJournal.cancel',
      targetType: 'PharmacyGeneralJournalDocument',
      targetId: document.id,
      input: { version: input.version },
      result: { status: document.status },
      outcome: 'SUCCESS',
    },
  });
  return document;
}

export async function reverseGeneralJournal(
  db: ScopedDb,
  scope: GeneralJournalScope,
  input: { documentId: string; version: number; idempotencyKey: string; at: Date; reason: string }
) {
  date(input.at);
  present(input.reason, 'MISSING_REASON');
  await lockGeneralJournalScope(db, scope);
  const document = await db.pharmacyGeneralJournalDocument.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: input.documentId },
  });
  if (!document?.journalEntryId) throw new PharmacyGeneralJournalError('NOT_FOUND');
  const payloadHash = digest({
    documentId: input.documentId,
    version: input.version,
    at: input.at.toISOString(),
    reason: input.reason.trim(),
  });
  if (document.reverseKey) {
    if (document.reverseKey !== input.idempotencyKey || document.reversePayloadHash !== payloadHash)
      throw new PharmacyGeneralJournalError('REPLAY_MISMATCH');
    return document;
  }
  if (document.version !== input.version) throw new PharmacyGeneralJournalError('STALE_VERSION');
  if (document.status !== 'POSTED') throw new PharmacyGeneralJournalError('INVALID_STATE');
  if (input.at < document.occurredAt) throw new PharmacyGeneralJournalError('INVALID_DATE');
  await assertOpen(db, scope, input.at);
  const reversal = await reverseJournalEntry(db, scope, {
    entryId: document.journalEntryId,
    reason: input.reason.trim(),
    at: input.at,
    idempotencyKey: `pharmacy-jv-reversal:${document.id}`,
  });
  const reversed = await db.pharmacyGeneralJournalDocument.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: document.id } },
    data: {
      status: 'REVERSED',
      reversedAt: input.at,
      reversalEntryId: reversal.id,
      reverseKey: input.idempotencyKey,
      reversePayloadHash: payloadHash,
      version: { increment: 1 },
    },
  });
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'FINANCE',
      operation: 'EXECUTE',
      action: 'pharmacyGeneralJournal.reverse',
      targetType: 'PharmacyGeneralJournalDocument',
      targetId: document.id,
      input: { reason: input.reason },
      result: { reversalEntryId: reversal.id },
      outcome: 'SUCCESS',
    },
  });
  return reversed;
}
