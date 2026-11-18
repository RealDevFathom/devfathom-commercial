import 'server-only';

import { Prisma, type PharmacyCardTerminalAttempt } from '@/generated/prisma/client';
import type { PharmacyCardTerminalAttemptStatus } from '@/generated/prisma/enums';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { applyPharmacyTender, type PharmacyPaymentAdapter } from '../settlement';
import type { LedgerScope } from '../stock-ledger';

/**
 * DEV-743: persistence for the one durable card-terminal payment-attempt record.
 *
 * The service talks only to this port. `prismaCardTerminalAttemptStore` is the real store: each
 * call runs in its own committed transaction, so the CREATED row exists before a terminal can
 * be asked to charge and every later state survives a crash. The in-memory store mirrors the
 * same rules for the mocked end-to-end tests.
 */

export type CardTerminalAttempt = Omit<PharmacyCardTerminalAttempt, 'updatedAt'>;
export type CardTerminalAttemptStatus = PharmacyCardTerminalAttemptStatus;

/**
 * The only currency a terminal attempt may charge in. Pharmacy tenders post to the journal with no
 * currency of their own (the journal defaults to PKR), so a charge in any other currency would
 * clear a PKR sale with no conversion. The migration's currency check holds the same value.
 */
export const PHARMACY_TERMINAL_CURRENCY = 'PKR';

/** States that hold the sale: no second terminal charge or other tender may start. */
export const OPEN_ATTEMPT_STATUSES: readonly CardTerminalAttemptStatus[] = Object.freeze([
  'CREATED',
  'SENT',
  'UNKNOWN',
  'APPROVED',
  'MANUAL_REVIEW',
]);

export type CardTerminalAttemptDraft = {
  saleId: string;
  deviceId: string;
  terminalId: string;
  provider: string;
  attemptKey: string;
  amountMinor: number;
  currency: string;
  businessDate: Date;
};

export type CardTerminalAttemptPatch = {
  status: CardTerminalAttemptStatus;
} & Partial<
  Pick<
    CardTerminalAttempt,
    | 'providerRef'
    | 'approvalCode'
    | 'cardBrand'
    | 'cardLast4'
    | 'declineCode'
    | 'statusChecks'
    | 'reviewReason'
    | 'sentAt'
    | 'resolvedAt'
  >
>;

export class CardTerminalError extends Error {
  constructor(
    readonly reason:
      | 'UNCERTIFIED_PROVIDER'
      | 'INVALID_INPUT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'ATTEMPT_IN_PROGRESS'
      | 'ATTEMPT_NOT_FOUND'
      | 'INVALID_STATE'
  ) {
    super(reason);
    this.name = 'CardTerminalError';
  }
}

export interface CardTerminalAttemptStore {
  /**
   * Runs the real tender guards for the sale, then commits a CREATED attempt. A replay of the
   * same key returns the stored attempt; a different payload under that key is a conflict.
   */
  create(
    scope: LedgerScope,
    draft: CardTerminalAttemptDraft
  ): Promise<{ created: boolean; attempt: CardTerminalAttempt }>;
  get(scope: LedgerScope, attemptKey: string): Promise<CardTerminalAttempt | null>;
  /**
   * Compare-and-set against the attempt as read (status and status-check count). Exactly one
   * writer wins; the loser gets null and must re-read.
   */
  transition(
    scope: LedgerScope,
    current: CardTerminalAttempt,
    patch: CardTerminalAttemptPatch
  ): Promise<CardTerminalAttempt | null>;
  /**
   * Turns an APPROVED attempt into exactly one CARD tender and marks it SETTLED in the same
   * transaction. Never calls the terminal again. A SETTLED attempt returns its tender.
   */
  settle(scope: LedgerScope, attemptId: string): Promise<{ tenderId: string; replayed: boolean }>;
  listOpen(scope: LedgerScope): Promise<CardTerminalAttempt[]>;
}

export function sameDraft(
  attempt: CardTerminalAttempt,
  scope: LedgerScope,
  draft: CardTerminalAttemptDraft
) {
  return (
    attempt.organizationId === scope.organizationId &&
    attempt.branchId === scope.branchId &&
    attempt.saleId === draft.saleId &&
    attempt.deviceId === draft.deviceId &&
    attempt.terminalId === draft.terminalId &&
    attempt.provider === draft.provider &&
    attempt.amountMinor === draft.amountMinor &&
    attempt.currency === draft.currency &&
    // Stored as a calendar date: compare the day, not the instant.
    attempt.businessDate.toISOString().slice(0, 10) ===
      draft.businessDate.toISOString().slice(0, 10)
  );
}

/**
 * The adapter settlement sees when an approval becomes a tender. It replays the stored approval
 * and never reaches a terminal, so settling (or retrying a settlement) can never charge again.
 */
export function approvedChargeReplay(attempt: CardTerminalAttempt): PharmacyPaymentAdapter {
  return {
    name: attempt.provider,
    certified: true,
    execute: async (request) =>
      request.capability === 'SALE' &&
      request.amountMinor === attempt.amountMinor &&
      attempt.status === 'APPROVED' &&
      attempt.providerRef
        ? { approved: true, providerRef: attempt.providerRef }
        : { approved: false, providerRef: '' },
  };
}

class PreflightPassed extends Error {}

/**
 * Run every guard the real tender runs (store may operate, day open and current, Rx and
 * prescription rules, batch safety, over-tender, posting period) without writing anything:
 * the adapter stops settlement at the point it would ask a provider to move money, and the
 * savepoint undoes the idempotency row it bound on the way. Exported for tests.
 */
export async function preflightTerminalCharge(
  db: ScopedDb,
  scope: LedgerScope,
  draft: CardTerminalAttemptDraft
) {
  await db.$executeRaw(Prisma.sql`SAVEPOINT card_terminal_preflight`);
  let passed = false;
  try {
    await applyPharmacyTender(
      db,
      scope,
      {
        saleId: draft.saleId,
        deviceId: draft.deviceId,
        businessDate: draft.businessDate,
        type: 'CARD',
        amountMinor: draft.amountMinor,
        idempotencyKey: `card-terminal-preflight:${draft.attemptKey}`,
        adapter: {
          name: draft.provider,
          certified: true,
          execute: async () => {
            throw new PreflightPassed();
          },
        },
      },
      undefined,
      { requireCurrentBusinessDate: true }
    );
  } catch (error) {
    if (!(error instanceof PreflightPassed)) {
      await db.$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT card_terminal_preflight`);
      throw error;
    }
    passed = true;
  }
  await db.$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT card_terminal_preflight`);
  // The adapter is the only way out of a guarded tender without a write; anything else is a bug.
  if (!passed) throw new CardTerminalError('INVALID_STATE');
}

type TenantRunner = <T>(run: (db: ScopedDb) => Promise<T>) => Promise<T>;

const lockSale = (db: ScopedDb, scope: LedgerScope, saleId: string) =>
  db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );

/**
 * The real store. `run` opens one tenant transaction per call (for example
 * `(work) => withTenantDb(organizationId, work, { userId })`), so each step commits on its own.
 */
export function prismaCardTerminalAttemptStore(run: TenantRunner): CardTerminalAttemptStore {
  const scoped = (scope: LedgerScope) => ({
    organizationId: scope.organizationId,
    branchId: scope.branchId,
  });
  return {
    create: (scope, draft) =>
      run(async (db) => {
        // Same sale lock as settlement: begin, settle and every other tender serialize here.
        await lockSale(db, scope, draft.saleId);
        const existing = await db.pharmacyCardTerminalAttempt.findFirst({
          where: { organizationId: scope.organizationId, attemptKey: draft.attemptKey },
        });
        if (existing) {
          if (!sameDraft(existing, scope, draft))
            throw new CardTerminalError('IDEMPOTENCY_CONFLICT');
          return { created: false, attempt: existing };
        }
        const open = await db.pharmacyCardTerminalAttempt.findFirst({
          where: {
            ...scoped(scope),
            saleId: draft.saleId,
            status: { in: [...OPEN_ATTEMPT_STATUSES] },
          },
          select: { id: true },
        });
        if (open) throw new CardTerminalError('ATTEMPT_IN_PROGRESS');
        await preflightTerminalCharge(db, scope, draft);
        try {
          const attempt = await db.pharmacyCardTerminalAttempt.create({
            data: { ...scoped(scope), ...draft, actorId: scope.actorId },
          });
          return { created: true, attempt };
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
            throw new CardTerminalError('IDEMPOTENCY_CONFLICT');
          throw error;
        }
      }),
    get: (scope, attemptKey) =>
      run((db) =>
        db.pharmacyCardTerminalAttempt.findFirst({ where: { ...scoped(scope), attemptKey } })
      ),
    transition: (scope, current, patch) =>
      run(async (db) => {
        const { count } = await db.pharmacyCardTerminalAttempt.updateMany({
          where: {
            ...scoped(scope),
            id: current.id,
            status: current.status,
            statusChecks: current.statusChecks,
          },
          data: patch,
        });
        if (count !== 1) return null;
        return db.pharmacyCardTerminalAttempt.findFirst({
          where: { ...scoped(scope), id: current.id },
        });
      }),
    settle: (scope, attemptId) =>
      run(async (db) => {
        const found = await db.pharmacyCardTerminalAttempt.findFirst({
          where: { ...scoped(scope), id: attemptId },
          select: { saleId: true },
        });
        if (!found) throw new CardTerminalError('ATTEMPT_NOT_FOUND');
        // Sale before attempt, the same order as create, so the two never deadlock.
        await lockSale(db, scope, found.saleId);
        await db.$queryRaw(
          Prisma.sql`SELECT id FROM pharmacy_card_terminal_attempts WHERE id=${attemptId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
        );
        const attempt = await db.pharmacyCardTerminalAttempt.findFirst({
          where: { ...scoped(scope), id: attemptId },
        });
        if (!attempt) throw new CardTerminalError('ATTEMPT_NOT_FOUND');
        if (attempt.status === 'SETTLED' && attempt.tenderId)
          return { tenderId: attempt.tenderId, replayed: true };
        if (
          attempt.status !== 'APPROVED' ||
          !attempt.providerRef ||
          attempt.currency !== PHARMACY_TERMINAL_CURRENCY
        )
          throw new CardTerminalError('INVALID_STATE');
        const result = (await applyPharmacyTender(db, scope, {
          saleId: attempt.saleId,
          deviceId: attempt.deviceId,
          businessDate: attempt.businessDate,
          type: 'CARD',
          amountMinor: attempt.amountMinor,
          idempotencyKey: `card-terminal:${attempt.id}`,
          adapter: approvedChargeReplay(attempt),
        })) as { tenderId: string };
        await db.pharmacyCardTerminalAttempt.update({
          where: { id: attempt.id },
          data: { status: 'SETTLED', tenderId: result.tenderId, resolvedAt: new Date() },
        });
        return { tenderId: result.tenderId, replayed: false };
      }),
    listOpen: (scope) =>
      run((db) =>
        db.pharmacyCardTerminalAttempt.findMany({
          where: { ...scoped(scope), status: { in: [...OPEN_ATTEMPT_STATUSES] } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      ),
  };
}
