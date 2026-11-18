/**
 * CEO-JVCORE-20261025: the pharmacy general-journal voucher.
 *
 * One narrow workflow: NONTRADE_OPERATING_ACCRUAL, a balanced two-leg voucher
 * that debits OPERATING_EXPENSE and credits MANUAL_NONTRADE_ACCRUAL, with an
 * explicit reason and evidence reference. Every other account/side/purpose
 * combination is refused (see `coa.ts`).
 *
 * Lifecycle: DRAFT (saved, reloadable, versioned) → POSTED (one canonical
 * finance journal entry, voucher frozen) → REVERSED (one linked canonical
 * reversal in an open period). A DRAFT may instead be CANCELLED.
 *
 * Every command runs inside the caller's transaction. Post and reverse take the
 * shared org+branch ledger lock first, then the voucher row lock, so they
 * serialize with each other and with period close/reopen.
 */
import { createHash } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { FinanceAccountCode } from '@/generated/prisma/client';
import {
  FinancePostingError,
  postJournalEntry,
  reverseJournalEntry,
  type JournalSide,
} from '@/lib/finance/journal';
import {
  assertPeriodOpen,
  lockPharmacyLedgerScope,
  PharmacyBookkeepingError,
} from '@/lib/pharmacy/bookkeeping';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  isAllowedJournalVoucherLeg,
  JOURNAL_VOUCHER_CATALOG,
  isJournalVoucherPurpose,
} from './coa';
import {
  JOURNAL_VOUCHER_MAX_LINE_MINOR,
  type CancelJournalVoucherDraftInput,
  type CreateJournalVoucherDraftInput,
  type JournalVoucherLineInput,
  type PostJournalVoucherInput,
  type ReverseJournalVoucherInput,
  type UpdateJournalVoucherDraftInput,
} from './general-journal-schema';

export type JournalVoucherScope = { organizationId: string; branchId: string; actorId: string };

export type JournalVoucherErrorReason =
  | 'INVALID_PURPOSE'
  | 'INVALID_LINES'
  | 'INVALID_AMOUNT'
  | 'UNBALANCED'
  | 'INVALID_DATE'
  | 'MISSING_REASON'
  | 'MISSING_EVIDENCE'
  | 'NOT_FOUND'
  | 'STALE_VERSION'
  | 'INVALID_STATE'
  | 'ALREADY_POSTED'
  | 'ALREADY_REVERSED'
  | 'PERIOD_CLOSED'
  | 'DUPLICATE_REFERENCE'
  | 'IDEMPOTENCY_CONFLICT';

export class PharmacyJournalVoucherError extends Error {
  constructor(readonly reason: JournalVoucherErrorReason) {
    super(reason);
    this.name = 'PharmacyJournalVoucherError';
  }
}

/** Earliest accepted business instant and the furthest a date may run ahead. */
export const JOURNAL_VOUCHER_EARLIEST = new Date('2000-01-01T00:00:00.000Z');
export const JOURNAL_VOUCHER_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export type NormalizedVoucherLine = {
  lineNumber: number;
  accountCode: FinanceAccountCode;
  side: JournalSide;
  amountMinor: number;
  memo: string | null;
};

export type NormalizedVoucherDraft = {
  reference: string;
  purpose: 'NONTRADE_OPERATING_ACCRUAL';
  occurredAt: Date;
  currency: 'PKR' | 'USD';
  reason: string;
  evidenceReference: string;
  lines: NormalizedVoucherLine[];
  amountMinor: number;
};

function fail(reason: JournalVoucherErrorReason): never {
  throw new PharmacyJournalVoucherError(reason);
}

export function parseVoucherInstant(value: string | Date, now: Date): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) fail('INVALID_DATE');
  if (parsed < JOURNAL_VOUCHER_EARLIEST) fail('INVALID_DATE');
  if (parsed.getTime() > now.getTime() + JOURNAL_VOUCHER_FUTURE_TOLERANCE_MS) fail('INVALID_DATE');
  return parsed;
}

/**
 * The server-side business rules for a voucher's lines: they must match the
 * purpose's catalog one-for-one (same accounts, same sides, nothing extra),
 * every amount must be a positive Int32-safe whole number of minor units, and
 * debits must equal credits.
 */
export function normalizeVoucherLines(
  purpose: string,
  lines: readonly (Pick<JournalVoucherLineInput, 'accountCode' | 'side' | 'amountMinor'> & {
    memo?: string | null;
  })[]
): NormalizedVoucherLine[] {
  if (!isJournalVoucherPurpose(purpose)) fail('INVALID_PURPOSE');
  const catalog = JOURNAL_VOUCHER_CATALOG[purpose];
  if (lines.length !== catalog.length) fail('INVALID_LINES');
  for (const line of lines) {
    if (!isAllowedJournalVoucherLeg(purpose, line.accountCode, line.side)) fail('INVALID_LINES');
    if (
      !Number.isSafeInteger(line.amountMinor) ||
      line.amountMinor <= 0 ||
      line.amountMinor > JOURNAL_VOUCHER_MAX_LINE_MINOR
    ) {
      fail('INVALID_AMOUNT');
    }
  }
  // One-for-one: each catalog rule is used exactly once.
  const ordered = catalog.map((rule) => {
    const matches = lines.filter(
      (line) => line.accountCode === rule.accountCode && line.side === rule.side
    );
    if (matches.length !== 1) fail('INVALID_LINES');
    return matches[0]!;
  });
  let debit = 0;
  let credit = 0;
  for (const line of ordered) {
    if (line.side === 'DEBIT') debit += line.amountMinor;
    else credit += line.amountMinor;
  }
  if (debit !== credit) fail('UNBALANCED');
  return ordered.map((line, index) => ({
    lineNumber: index + 1,
    accountCode: line.accountCode as FinanceAccountCode,
    side: line.side,
    amountMinor: line.amountMinor,
    memo: line.memo?.trim() ? line.memo.trim() : null,
  }));
}

export function normalizeVoucherDraft(
  input: Pick<
    CreateJournalVoucherDraftInput,
    'reference' | 'purpose' | 'occurredAt' | 'currency' | 'reason' | 'evidenceReference' | 'lines'
  >,
  now: Date
): NormalizedVoucherDraft {
  if (!isJournalVoucherPurpose(input.purpose)) fail('INVALID_PURPOSE');
  const reference = input.reference.trim();
  const reason = input.reason.trim();
  const evidenceReference = input.evidenceReference.trim();
  if (!reference) fail('INVALID_STATE');
  if (!reason) fail('MISSING_REASON');
  if (!evidenceReference) fail('MISSING_EVIDENCE');
  if (input.currency !== 'PKR' && input.currency !== 'USD') fail('INVALID_STATE');
  const lines = normalizeVoucherLines(input.purpose, input.lines);
  return {
    reference,
    purpose: input.purpose,
    occurredAt: parseVoucherInstant(input.occurredAt, now),
    currency: input.currency,
    reason,
    evidenceReference,
    lines,
    amountMinor: lines
      .filter((line) => line.side === 'DEBIT')
      .reduce((s, l) => s + l.amountMinor, 0),
  };
}

/** Stable digest of a command payload: same key + same payload replays. */
export function commandPayloadHash(payload: Record<string, string | number>): string {
  const keys = Object.keys(payload).sort();
  return createHash('sha256')
    .update(JSON.stringify(keys.map((key) => [key, payload[key]])))
    .digest('hex');
}

const voucherInclude = { lines: { orderBy: { lineNumber: 'asc' as const } } };

async function lockVoucher(db: ScopedDb, scope: JournalVoucherScope, voucherId: string) {
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_journal_vouchers
    WHERE id=${voucherId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} FOR UPDATE`);
  const voucher = await db.pharmacyJournalVoucher.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: voucherId },
    include: voucherInclude,
  });
  if (!voucher) fail('NOT_FOUND');
  return voucher;
}

async function assertReferenceFree(
  db: ScopedDb,
  scope: JournalVoucherScope,
  reference: string,
  exceptId?: string
) {
  const clash = await db.pharmacyJournalVoucher.findFirst({
    where: {
      organizationId: scope.organizationId,
      reference,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) fail('DUPLICATE_REFERENCE');
}

async function assertOpenPeriod(db: ScopedDb, scope: JournalVoucherScope, at: Date) {
  try {
    await assertPeriodOpen(db, scope, at);
  } catch (error) {
    if (error instanceof PharmacyBookkeepingError && error.reason === 'PERIOD_CLOSED') {
      fail('PERIOD_CLOSED');
    }
    throw error;
  }
}

export async function createJournalVoucherDraft(
  db: ScopedDb,
  scope: JournalVoucherScope,
  input: CreateJournalVoucherDraftInput,
  now: Date = new Date()
) {
  const draft = normalizeVoucherDraft(input, now);
  const replay = await db.pharmacyJournalVoucher.findFirst({
    where: { organizationId: scope.organizationId, createKey: input.createKey },
    include: voucherInclude,
  });
  if (replay) {
    if (replay.branchId !== scope.branchId || replay.createdByUserId !== scope.actorId) {
      fail('IDEMPOTENCY_CONFLICT');
    }
    return replay;
  }
  await assertReferenceFree(db, scope, draft.reference);
  return db.pharmacyJournalVoucher.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      reference: draft.reference,
      purpose: draft.purpose,
      currency: draft.currency,
      occurredAt: draft.occurredAt,
      reason: draft.reason,
      evidenceReference: draft.evidenceReference,
      createKey: input.createKey,
      createdByUserId: scope.actorId,
      updatedByUserId: scope.actorId,
      lines: {
        create: draft.lines.map((line) => ({
          ...line,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        })),
      },
    },
    include: voucherInclude,
  });
}

export async function updateJournalVoucherDraft(
  db: ScopedDb,
  scope: JournalVoucherScope,
  input: UpdateJournalVoucherDraftInput,
  now: Date = new Date()
) {
  const draft = normalizeVoucherDraft(input, now);
  const voucher = await lockVoucher(db, scope, input.voucherId);
  if (voucher.status !== 'DRAFT') fail('INVALID_STATE');
  if (voucher.version !== input.expectedVersion) fail('STALE_VERSION');
  if (draft.reference !== voucher.reference) {
    await assertReferenceFree(db, scope, draft.reference, voucher.id);
  }
  await db.pharmacyJournalVoucherLine.deleteMany({
    where: { organizationId: scope.organizationId, voucherId: voucher.id },
  });
  return db.pharmacyJournalVoucher.update({
    where: { id: voucher.id },
    data: {
      reference: draft.reference,
      currency: draft.currency,
      occurredAt: draft.occurredAt,
      reason: draft.reason,
      evidenceReference: draft.evidenceReference,
      version: voucher.version + 1,
      updatedByUserId: scope.actorId,
      lines: {
        create: draft.lines.map((line) => ({
          ...line,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        })),
      },
    },
    include: voucherInclude,
  });
}

export async function cancelJournalVoucherDraft(
  db: ScopedDb,
  scope: JournalVoucherScope,
  input: CancelJournalVoucherDraftInput,
  now: Date = new Date()
) {
  const reason = input.reason.trim();
  if (!reason) fail('MISSING_REASON');
  const voucher = await lockVoucher(db, scope, input.voucherId);
  if (voucher.status === 'CANCELLED') return voucher;
  if (voucher.status !== 'DRAFT') fail('INVALID_STATE');
  if (voucher.version !== input.expectedVersion) fail('STALE_VERSION');
  return db.pharmacyJournalVoucher.update({
    where: { id: voucher.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: now,
      cancelledByUserId: scope.actorId,
      cancelReason: reason,
      updatedByUserId: scope.actorId,
    },
    include: voucherInclude,
  });
}

/** The ledger idempotency key is per document, not per command key. */
export function voucherPostingKey(voucherId: string) {
  return `journal-voucher:${voucherId}`;
}

export function voucherReversalKey(voucherId: string) {
  return `journal-voucher-reversal:${voucherId}`;
}

export async function postJournalVoucher(
  db: ScopedDb,
  scope: JournalVoucherScope,
  input: PostJournalVoucherInput,
  now: Date = new Date()
) {
  await lockPharmacyLedgerScope(db, scope);
  const payloadHash = commandPayloadHash({
    branchId: scope.branchId,
    voucherId: input.voucherId,
    expectedVersion: input.expectedVersion,
  });
  const replay = await db.pharmacyJournalVoucher.findFirst({
    where: { organizationId: scope.organizationId, postCommandKey: input.commandKey },
    include: voucherInclude,
  });
  if (replay) {
    if (replay.postPayloadHash !== payloadHash) fail('IDEMPOTENCY_CONFLICT');
    return { voucher: replay, replayed: true as const };
  }

  const voucher = await lockVoucher(db, scope, input.voucherId);
  if (voucher.status === 'POSTED' || voucher.status === 'REVERSED') fail('ALREADY_POSTED');
  if (voucher.status !== 'DRAFT') fail('INVALID_STATE');
  if (voucher.version !== input.expectedVersion) fail('STALE_VERSION');
  // Re-check the persisted document, never only what the client last saw.
  const lines = normalizeVoucherLines(voucher.purpose, voucher.lines);
  parseVoucherInstant(voucher.occurredAt, now);
  if (!voucher.reason.trim()) fail('MISSING_REASON');
  if (!voucher.evidenceReference.trim()) fail('MISSING_EVIDENCE');
  await assertOpenPeriod(db, scope, voucher.occurredAt);

  let entry;
  try {
    entry = await postJournalEntry(db, scope, {
      sourceKind: 'PHARMACY_JOURNAL_VOUCHER',
      sourceId: voucher.id,
      description: `Journal voucher ${voucher.reference}`,
      occurredAt: voucher.occurredAt,
      idempotencyKey: voucherPostingKey(voucher.id),
      branchId: scope.branchId,
      currency: voucher.currency,
      lines: lines.map((line) => ({
        accountCode: line.accountCode,
        side: line.side,
        amountMinor: line.amountMinor,
        branchId: scope.branchId,
        memo: line.memo,
      })),
    });
  } catch (error) {
    if (error instanceof FinancePostingError) {
      fail(
        error.reason === 'PERIOD_CLOSED' || error.reason === 'IDEMPOTENCY_CONFLICT'
          ? error.reason
          : 'UNBALANCED'
      );
    }
    throw error;
  }
  if (
    entry.sourceKind !== 'PHARMACY_JOURNAL_VOUCHER' ||
    entry.sourceId !== voucher.id ||
    entry.organizationId !== scope.organizationId ||
    entry.branchId !== scope.branchId ||
    entry.reversesEntryId !== null
  ) {
    fail('IDEMPOTENCY_CONFLICT');
  }

  const posted = await db.pharmacyJournalVoucher.update({
    where: { id: voucher.id },
    data: {
      status: 'POSTED',
      postedAt: now,
      postedByUserId: scope.actorId,
      postCommandKey: input.commandKey,
      postPayloadHash: payloadHash,
      journalEntryId: entry.id,
    },
    include: voucherInclude,
  });
  return { voucher: posted, entry, replayed: false as const };
}

export async function reverseJournalVoucher(
  db: ScopedDb,
  scope: JournalVoucherScope,
  input: ReverseJournalVoucherInput,
  now: Date = new Date()
) {
  const reason = input.reason.trim();
  if (!reason) fail('MISSING_REASON');
  const at = parseVoucherInstant(input.at, now);
  await lockPharmacyLedgerScope(db, scope);
  const payloadHash = commandPayloadHash({
    branchId: scope.branchId,
    voucherId: input.voucherId,
    reason,
    at: at.toISOString(),
  });
  const replay = await db.pharmacyJournalVoucher.findFirst({
    where: { organizationId: scope.organizationId, reverseCommandKey: input.commandKey },
    include: voucherInclude,
  });
  if (replay) {
    if (replay.reversePayloadHash !== payloadHash) fail('IDEMPOTENCY_CONFLICT');
    return { voucher: replay, replayed: true as const };
  }

  const voucher = await lockVoucher(db, scope, input.voucherId);
  if (voucher.status === 'REVERSED') fail('ALREADY_REVERSED');
  if (voucher.status !== 'POSTED' || !voucher.journalEntryId) fail('INVALID_STATE');
  if (at < voucher.occurredAt) fail('INVALID_DATE');
  await assertOpenPeriod(db, scope, at);

  const reversal = await reverseJournalEntry(db, scope, {
    entryId: voucher.journalEntryId,
    reason,
    at,
    idempotencyKey: voucherReversalKey(voucher.id),
  });
  if (
    reversal.reversesEntryId !== voucher.journalEntryId ||
    reversal.sourceKind !== 'PHARMACY_JOURNAL_VOUCHER' ||
    reversal.sourceId !== voucher.id
  ) {
    fail('IDEMPOTENCY_CONFLICT');
  }

  const reversed = await db.pharmacyJournalVoucher.update({
    where: { id: voucher.id },
    data: {
      status: 'REVERSED',
      reversedAt: at,
      reversedByUserId: scope.actorId,
      reversalReason: reason,
      reverseCommandKey: input.commandKey,
      reversePayloadHash: payloadHash,
      reversalEntryId: reversal.id,
    },
    include: voucherInclude,
  });
  return { voucher: reversed, entry: reversal, replayed: false as const };
}

export function listJournalVouchers(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  input: { status?: 'DRAFT' | 'CANCELLED' | 'POSTED' | 'REVERSED'; take: number }
) {
  return db.pharmacyJournalVoucher.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      ...(input.status ? { status: input.status } : {}),
    },
    include: voucherInclude,
    orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
    take: input.take,
  });
}

export async function getJournalVoucher(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  voucherId: string
) {
  const voucher = await db.pharmacyJournalVoucher.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: voucherId },
    include: voucherInclude,
  });
  if (!voucher) fail('NOT_FOUND');
  return voucher;
}
