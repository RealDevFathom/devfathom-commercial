/**
 * FIN-01 / §8A invariant 15 — the shared double-entry journal primitive.
 *
 * This is the ONE write path into `finance_journal_entries` /
 * `finance_journal_lines`, and it is deliberately vertical-agnostic: it knows
 * about debits, credits, source references and reversals, and nothing about
 * pharmacies, restaurants or agencies. A vertical composes it through an
 * adapter (see `src/lib/pharmacy/finance-postings.ts`) rather than growing its
 * own ledger, so "balanced" means the same thing everywhere.
 *
 * WHAT THIS MODULE DOES NOT DECIDE. Balance, append-only, at-most-one-reversal
 * and the shape of a reversal are all enforced by the migration — a deferred
 * constraint trigger, an append-only trigger and a unique index. The checks
 * here fail earlier with a better message; they are not the guarantee. Code
 * that bypassed this module still could not commit an unbalanced entry.
 *
 * TRANSACTIONS. `postJournalEntry` writes an entry and its legs, and the entry
 * is unbalanced in between. It must therefore run inside the caller's
 * transaction — the same transaction that writes the operational row it
 * accounts for, so an event and its posting are never half-recorded.
 */
import type { Currency, FinanceAccountCode, FinanceSourceKind } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type JournalSide = 'DEBIT' | 'CREDIT';

export type FinancePostingErrorReason =
  | 'EMPTY_ENTRY'
  | 'UNBALANCED'
  | 'INVALID_AMOUNT'
  | 'MISSING_SOURCE'
  | 'NOT_FOUND'
  | 'MISSING_REASON';

export class FinancePostingError extends Error {
  constructor(readonly reason: FinancePostingErrorReason) {
    super(reason);
    this.name = 'FinancePostingError';
  }
}

/**
 * Which side increases an account. Reads sign a raw (debit − credit) sum with
 * this so a revenue balance reads positive when revenue was earned, instead of
 * every report re-deciding what the sign of a credit account means.
 */
export const ACCOUNT_NORMAL_SIDE: Readonly<Record<FinanceAccountCode, JournalSide>> = {
  INVENTORY: 'DEBIT',
  INVENTORY_IN_TRANSIT: 'DEBIT',
  GOODS_RECEIVED_ACCRUAL: 'CREDIT',
  SALES_CLEARING: 'DEBIT',
  SALES_REVENUE: 'CREDIT',
  SALES_DISCOUNT: 'DEBIT',
  COST_OF_GOODS_SOLD: 'DEBIT',
  INVENTORY_WRITE_OFF: 'DEBIT',
  INVENTORY_SHRINKAGE: 'DEBIT',
  OPERATING_EXPENSE: 'DEBIT',
  SUPPLIER_CLAIM_RECEIVABLE: 'DEBIT',
  CASH: 'DEBIT',
  BANK: 'DEBIT',
  ACCOUNTS_RECEIVABLE: 'DEBIT',
  LOYALTY_REDEMPTION: 'DEBIT',
  ACCOUNTS_PAYABLE: 'CREDIT',
  CASH_OVER_SHORT: 'DEBIT',
  OPENING_BALANCE_EQUITY: 'CREDIT',
};

export type JournalScope = {
  organizationId: string;
  actorId: string;
};

/**
 * One leg. `amountMinor` is a positive magnitude in minor units; `side` carries
 * the direction. The dimensions are what FIN-03 groups by, and are all optional
 * because not every event has all of them (a supplier accrual has no lot).
 */
export type JournalLineInput = {
  accountCode: FinanceAccountCode;
  side: JournalSide;
  amountMinor: number;
  branchId?: string | null;
  productId?: string | null;
  lotId?: string | null;
  locationId?: string | null;
  sourceLineId?: string | null;
  memo?: string | null;
};

export type PostJournalEntryInput = {
  /** The operational table and row this entry accounts for (traceability). */
  sourceKind: FinanceSourceKind;
  sourceId: string;
  description: string;
  occurredAt: Date;
  /** Org-scoped; a retried adapter call posts nothing the second time. */
  idempotencyKey: string;
  branchId?: string | null;
  currency?: Currency;
  lines: readonly JournalLineInput[];
};

/**
 * The pure balance kernel: debits must equal credits, every leg must be a
 * positive whole number of minor units, and both sides must be present.
 *
 * Exported because it is the rule the whole module exists to protect, and a
 * caller building lines conditionally (a discount that may be zero) can check
 * its own work before opening a transaction.
 */
export function assertBalanced(lines: readonly JournalLineInput[]): void {
  if (lines.length === 0) throw new FinancePostingError('EMPTY_ENTRY');

  let debits = BigInt(0);
  let credits = BigInt(0);
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0) {
      throw new FinancePostingError('INVALID_AMOUNT');
    }
    if (line.side === 'DEBIT') debits += BigInt(line.amountMinor);
    else credits += BigInt(line.amountMinor);
  }
  if (debits === BigInt(0) || credits === BigInt(0)) throw new FinancePostingError('EMPTY_ENTRY');
  if (debits !== credits) throw new FinancePostingError('UNBALANCED');
}

/** Signed value of a leg in its account's own direction. */
export function signedMinor(line: {
  accountCode: FinanceAccountCode;
  side: JournalSide;
  amountMinor: number;
}): number {
  return line.side === ACCOUNT_NORMAL_SIDE[line.accountCode] ? line.amountMinor : -line.amountMinor;
}

/**
 * Post one balanced entry. Must run inside the caller's transaction.
 *
 * Returns the existing entry unchanged when `idempotencyKey` has already been
 * posted: a receipt or a sale that is retried after a network failure accounts
 * for itself once, not twice.
 */
export async function postJournalEntry(
  db: ScopedDb,
  scope: JournalScope,
  input: PostJournalEntryInput
) {
  if (input.sourceId.trim().length === 0) throw new FinancePostingError('MISSING_SOURCE');
  assertBalanced(input.lines);

  const existing = await db.financeJournalEntry.findFirst({
    where: { organizationId: scope.organizationId, idempotencyKey: input.idempotencyKey },
    include: { lines: true },
  });
  if (existing) return existing;

  const entry = await db.financeJournalEntry.create({
    data: {
      organizationId: scope.organizationId,
      branchId: input.branchId ?? null,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      description: input.description,
      currency: input.currency ?? 'PKR',
      actorId: scope.actorId,
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
    },
  });

  // Sequential, not Promise.all: the scoped transaction client serializes
  // statements anyway, and a stable insertion order keeps a failure's error
  // pointing at the leg that caused it.
  for (const line of input.lines) {
    await db.financeJournalLine.create({
      data: {
        organizationId: scope.organizationId,
        entryId: entry.id,
        accountCode: line.accountCode,
        side: line.side,
        amountMinor: line.amountMinor,
        branchId: line.branchId ?? input.branchId ?? null,
        productId: line.productId ?? null,
        lotId: line.lotId ?? null,
        locationId: line.locationId ?? null,
        sourceLineId: line.sourceLineId ?? null,
        memo: line.memo ?? null,
      },
    });
  }

  return db.financeJournalEntry.findFirstOrThrow({
    where: { organizationId: scope.organizationId, id: entry.id },
    include: { lines: true },
  });
}

export type ReverseJournalEntryInput = {
  entryId: string;
  reason: string;
  at: Date;
  idempotencyKey: string;
};

/**
 * §8A invariant 15: undo a posting by adding its negation, never by editing it.
 *
 * The reversal is a NEW entry that names the original, carries the same source
 * reference, and whose legs are the original's with the sides swapped — same
 * accounts, same amounts, same dimensions. The original is not touched: nothing
 * about it changes, and a report run over the pair sees the two postings sum to
 * zero rather than seeing one posting that quietly became something else.
 *
 * Must run inside the caller's transaction.
 */
export async function reverseJournalEntry(
  db: ScopedDb,
  scope: JournalScope,
  input: ReverseJournalEntryInput
) {
  if (input.reason.trim().length === 0) throw new FinancePostingError('MISSING_REASON');

  const original = await db.financeJournalEntry.findFirst({
    where: { organizationId: scope.organizationId, id: input.entryId },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
  if (!original) throw new FinancePostingError('NOT_FOUND');

  const existing = await db.financeJournalEntry.findFirst({
    where: { organizationId: scope.organizationId, reversesEntryId: original.id },
    include: { lines: true },
  });
  if (existing) return existing;

  const reversal = await db.financeJournalEntry.create({
    data: {
      organizationId: scope.organizationId,
      branchId: original.branchId,
      sourceKind: original.sourceKind,
      sourceId: original.sourceId,
      description: `Reversal of ${original.description}`,
      currency: original.currency,
      actorId: scope.actorId,
      occurredAt: input.at,
      idempotencyKey: input.idempotencyKey,
      reversesEntryId: original.id,
      reversalReason: input.reason,
    },
  });

  for (const line of original.lines) {
    await db.financeJournalLine.create({
      data: {
        organizationId: scope.organizationId,
        entryId: reversal.id,
        accountCode: line.accountCode,
        side: line.side === 'DEBIT' ? 'CREDIT' : 'DEBIT',
        amountMinor: line.amountMinor,
        branchId: line.branchId,
        productId: line.productId,
        lotId: line.lotId,
        locationId: line.locationId,
        sourceLineId: line.sourceLineId,
        memo: line.memo,
      },
    });
  }

  return db.financeJournalEntry.findFirstOrThrow({
    where: { organizationId: scope.organizationId, id: reversal.id },
    include: { lines: true },
  });
}

/**
 * Every entry posted for one operational row, reversals included, oldest first.
 * This is the "operational source → posting → reversal" evidence trail FIN-01
 * is accepted on.
 */
export function entriesForSource(
  db: ScopedDb,
  organizationId: string,
  sourceKind: FinanceSourceKind,
  sourceId: string
) {
  return db.financeJournalEntry.findMany({
    where: { organizationId, sourceKind, sourceId },
    include: { lines: { orderBy: { id: 'asc' } } },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
}
