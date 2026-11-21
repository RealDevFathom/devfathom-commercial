import 'server-only';

import { Prisma, type PharmacyCardTerminalAttempt } from '@/generated/prisma/client';
import type { PharmacyCardTerminalAttemptStatus } from '@/generated/prisma/enums';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  applyPharmacyTender,
  cashShiftRefusal,
  requirePharmacyDayOpen,
  type PharmacyPaymentAdapter,
} from '../settlement';
import type { LedgerScope } from '../stock-ledger';
import { redactForLog } from './cardholder-data';
import { OPEN_ATTEMPT_STATUSES } from './open-attempts';

export { OPEN_ATTEMPT_STATUSES } from './open-attempts';

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
    | 'resolvedById'
    | 'resolutionReason'
    | 'resolutionRef'
  >
>;

/** Extra facts for an attempt's audit entry, such as a manager's PIN approval. Never card data. */
export type CardTerminalAuditDetail = Record<string, string | number | boolean | null>;

/**
 * Who an attempt's audit entries name: the signed-in person at the counter (`USER`), or the
 * scheduled recovery sweep (`SYSTEM`), which acts for the attempt's cashier.
 */
export type CardTerminalAuditActor = 'USER' | 'SYSTEM';

const AUDIT_EVENTS: Record<CardTerminalAttemptStatus, string> = {
  CREATED: 'created',
  SENT: 'dispatched',
  UNKNOWN: 'unknown',
  APPROVED: 'approved',
  SETTLED: 'settled',
  DECLINED: 'declined',
  ABANDONED: 'abandoned',
  MANUAL_REVIEW: 'manualReview',
  REVERSED: 'reversed',
};

/**
 * DEV-743: the audit entry for one committed attempt change. Every store write adds it in the
 * SAME transaction as the attempt change, so the entry commits exactly when the change does: a
 * request (or a batch sibling) that rolls back afterwards never loses it, and a change that
 * rolled back never leaves one. It carries the attempt's state and references only: no card
 * brand, last four digits, approval code, terminal id or secret. Exported for tests.
 */
export function cardTerminalAuditEntry(
  attempt: CardTerminalAttempt,
  from: CardTerminalAttemptStatus | null,
  actor: CardTerminalAuditActor,
  scope: LedgerScope,
  detail: CardTerminalAuditDetail = {}
): Prisma.AuditLogUncheckedCreateInput {
  const event =
    from === 'MANUAL_REVIEW' && attempt.status !== 'MANUAL_REVIEW'
      ? 'reviewResolved'
      : AUDIT_EVENTS[attempt.status];
  const metadata = redactForLog({
    ...detail,
    branchId: attempt.branchId,
    attemptId: attempt.id,
    attemptKey: attempt.attemptKey,
    saleId: attempt.saleId,
    provider: attempt.provider,
    from,
    to: attempt.status,
    amountMinor: attempt.amountMinor,
    currency: attempt.currency,
    statusChecks: attempt.statusChecks,
    providerRef: attempt.providerRef,
    tenderId: attempt.tenderId,
    declineCode: attempt.declineCode,
    reviewReason: attempt.reviewReason,
    resolvedById: attempt.resolvedById,
    resolutionReason: attempt.resolutionReason,
    resolutionRef: attempt.resolutionRef,
    ...(actor === 'SYSTEM' ? { onBehalfOfUserId: scope.actorId } : {}),
  }) as Prisma.InputJsonObject;
  return {
    organizationId: attempt.organizationId,
    ...(actor === 'SYSTEM'
      ? { actorType: 'SYSTEM' as const, source: 'SYSTEM' as const }
      : { actorType: 'USER' as const, source: 'TRPC' as const, actorId: scope.actorId }),
    category: 'PHARMACY',
    operation: from === null ? 'CREATE' : 'UPDATE',
    action: `pharmacyCardTerminal.attempt.${event}`,
    targetType: 'PharmacyCardTerminalAttempt',
    targetId: attempt.id,
    metadata,
  };
}

export class CardTerminalError extends Error {
  constructor(
    readonly reason:
      | 'UNCERTIFIED_PROVIDER'
      | 'INVALID_INPUT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'ATTEMPT_IN_PROGRESS'
      | 'ATTEMPT_NOT_FOUND'
      | 'INVALID_STATE'
      /** A review resolution found the attempt no longer waiting for review. */
      | 'REVIEW_NOT_OPEN'
      /** "Nothing was charged" for an attempt that carries the terminal's charge reference. */
      | 'CHARGE_EVIDENCE_RECORDED'
      /** The slip reference is not the reference the terminal reported for this charge. */
      | 'SLIP_REFERENCE_MISMATCH'
      /** The slip reference is already recorded on another terminal payment. */
      | 'SLIP_REFERENCE_IN_USE'
      /**
       * The resolver took this charge, and another manager or owner could resolve it: a second
       * person must. Only a sole manager or owner may resolve their own charge.
       */
      | 'OWN_CHARGE_NEEDS_ANOTHER_APPROVER'
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
   * writer wins; the loser gets null and must re-read. The winner's audit entry commits with it.
   */
  transition(
    scope: LedgerScope,
    current: CardTerminalAttempt,
    patch: CardTerminalAttemptPatch,
    audit?: CardTerminalAuditDetail,
    /**
     * Runs inside the change's own transaction, with the attempt row locked, just before the
     * write. Throwing refuses the change. A rule that must hold at the moment of the write (the
     * solo-approver rule) is checked here rather than earlier in the request.
     */
    guard?: (db: ScopedDb) => Promise<void>
  ): Promise<CardTerminalAttempt | null>;
  /**
   * Turns an APPROVED attempt into exactly one CARD tender and marks it SETTLED in the same
   * transaction. Never calls the terminal again. A SETTLED attempt returns its tender.
   */
  settle(scope: LedgerScope, attemptId: string): Promise<{ tenderId: string; replayed: boolean }>;
  listOpen(scope: LedgerScope): Promise<CardTerminalAttempt[]>;
  /** The sale's newest attempt, open or finished, for the counter to show. */
  latestForSale(scope: LedgerScope, saleId: string): Promise<CardTerminalAttempt | null>;
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
 * `(work) => withTenantDb(organizationId, work, { userId })`), so each step commits on its own,
 * together with its audit entry. `actor` is `SYSTEM` for the recovery sweep.
 */
export function prismaCardTerminalAttemptStore(
  run: TenantRunner,
  actor: CardTerminalAuditActor = 'USER'
): CardTerminalAttemptStore {
  const audit = (
    db: ScopedDb,
    scope: LedgerScope,
    attempt: CardTerminalAttempt,
    from: CardTerminalAttemptStatus | null,
    detail?: CardTerminalAuditDetail
  ) => db.auditLog.create({ data: cardTerminalAuditEntry(attempt, from, actor, scope, detail) });
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
        // The preflight's day lock was taken inside its savepoint, and rolling the savepoint back
        // released it. Hold the day lock to commit, so a day close either sees this attempt or
        // has already closed the day (DEV-743 day-close gate).
        await requirePharmacyDayOpen(db, scope, draft.businessDate);
        try {
          const attempt = await db.pharmacyCardTerminalAttempt.create({
            data: { ...scoped(scope), ...draft, actorId: scope.actorId },
          });
          await audit(db, scope, attempt, null);
          return { created: true, attempt };
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
            throw new CardTerminalError('IDEMPOTENCY_CONFLICT');
          // DEV-958B: the preflight's shift check was undone with its savepoint, so the database
          // checks again as the attempt is written, under the day lock a shift close also takes.
          throw cashShiftRefusal(error) ?? error;
        }
      }),
    get: (scope, attemptKey) =>
      run((db) =>
        db.pharmacyCardTerminalAttempt.findFirst({ where: { ...scoped(scope), attemptKey } })
      ),
    transition: (scope, current, patch, detail, guard) =>
      run(async (db) => {
        if (guard) {
          await db.$queryRaw(
            Prisma.sql`SELECT id FROM pharmacy_card_terminal_attempts WHERE id=${current.id} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
          );
          await guard(db);
        }
        let count: number;
        try {
          ({ count } = await db.pharmacyCardTerminalAttempt.updateMany({
            where: {
              ...scoped(scope),
              id: current.id,
              status: current.status,
              statusChecks: current.statusChecks,
            },
            data: patch,
          }));
        } catch (error) {
          // A reversal writes the slip's reference; one approval is one attempt.
          if (
            patch.resolutionRef &&
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          )
            throw new CardTerminalError('SLIP_REFERENCE_IN_USE');
          throw error;
        }
        if (count !== 1) return null;
        const next = await db.pharmacyCardTerminalAttempt.findFirst({
          where: { ...scoped(scope), id: current.id },
        });
        if (next) await audit(db, scope, next, current.status, detail);
        return next;
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
        const settled = await db.pharmacyCardTerminalAttempt.update({
          where: { id: attempt.id },
          data: { status: 'SETTLED', tenderId: result.tenderId, resolvedAt: new Date() },
        });
        await audit(db, scope, settled, attempt.status);
        return { tenderId: result.tenderId, replayed: false };
      }),
    listOpen: (scope) =>
      run((db) =>
        db.pharmacyCardTerminalAttempt.findMany({
          where: { ...scoped(scope), status: { in: [...OPEN_ATTEMPT_STATUSES] } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      ),
    latestForSale: (scope, saleId) =>
      run((db) =>
        db.pharmacyCardTerminalAttempt.findFirst({
          where: { ...scoped(scope), saleId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      ),
  };
}
