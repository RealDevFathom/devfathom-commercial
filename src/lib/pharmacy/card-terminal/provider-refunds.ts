import 'server-only';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { FinanceAccountCode, PharmacyTerminalRefundEvent } from '@/generated/prisma/client';
import { postJournalEntry, reverseJournalEntry } from '@/lib/finance/journal';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { isBalanceSheetLiability } from '../accounts/balance-sheet';
import { actorIsPharmacyOwner } from '../procurement-access';
import type { LedgerScope } from '../stock-ledger';
import { assertNoCardholderData } from './cardholder-data';
import { otherCardTerminalReviewers } from './review-approvers';
import type { CardTerminalAttempt } from './store';

type Event = PharmacyTerminalRefundEvent;
type Scope = LedgerScope;
type Change = {
  previousId: string;
  commandKey: string;
  kind: 'DECLINED' | 'OWED' | 'SETTLED';
  verifiedAmountMinor?: number;
  reason: string;
  slipRef: string;
};

function checkEvidence(reason: string, slipRef: string) {
  try {
    assertNoCardholderData([reason, slipRef]);
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Remove card data from the refund evidence.',
    });
  }
  if (reason.trim().length < 3 || reason.length > 200 || !/^[A-Za-z0-9._:/-]{1,64}$/.test(slipRef))
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Supply a reason and an opaque slip reference.',
    });
}

async function book(
  db: ScopedDb,
  scope: Scope,
  event: Event,
  debit: FinanceAccountCode,
  credit: FinanceAccountCode
) {
  const leg = {
    amountMinor: event.amountMinor,
    branchId: scope.branchId,
    sourceLineId: event.refundId ?? event.attemptId,
  };
  const entry = await postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_TERMINAL_REFUND',
    sourceId: event.id,
    description:
      event.kind === 'OWED'
        ? 'Refund owed through card provider'
        : 'Refund settled by card provider',
    occurredAt: event.createdAt,
    idempotencyKey: 'terminal-refund:' + event.id,
    branchId: scope.branchId,
    lines: [
      { ...leg, accountCode: debit, side: 'DEBIT' },
      { ...leg, accountCode: credit, side: 'CREDIT' },
    ],
  });
  return entry.id;
}

async function bookOwed(db: ScopedDb, scope: Scope, event: Event) {
  const settings = await db.organization.findUniqueOrThrow({
    where: { id: scope.organizationId },
    select: { terminalRefundAccount: true, usesCustomFinanceChart: true },
  });
  const liability =
    settings.terminalRefundAccount ??
    (settings.usesCustomFinanceChart ? null : 'CARD_REFUNDS_PAYABLE');
  if (!liability || !isBalanceSheetLiability(liability) || liability === 'MANUAL_NONTRADE_ACCRUAL')
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'Set the provider refund liability account in Pharmacy settings before booking this refund.',
    });
  // A reviewed charge never became a tender. A returned sale already reversed its revenue
  // into sales clearing. Only a confirmed provider settlement credits the bank.
  return book(db, scope, event, event.refundId ? 'SALES_CLEARING' : 'BANK', liability);
}

// Snapshot the installed role. Distinct custom roles are comparable only when the
// candidate has every original grant, at least one extra, and no extra restriction.
async function reviewAuthority(db: ScopedDb, scope: Scope, actorId: string) {
  const user = await db.user.findFirstOrThrow({
    where: { organizationId: scope.organizationId, id: actorId, status: 'ACTIVE' },
    select: {
      role: true,
      organizationRoleId: true,
      organizationRole: { select: { permissions: { select: { capability: true, effect: true } } } },
    },
  });
  return {
    ownerAuthority: await actorIsPharmacyOwner(db, scope.organizationId, actorId),
    roleIdentity: user.organizationRoleId ?? 'base:' + user.role,
    roleRules: (user.organizationRole?.permissions ?? [])
      .map((rule) => rule.effect + ':' + rule.capability)
      .sort(),
  };
}

function mayCorrectRole(actor: Awaited<ReturnType<typeof reviewAuthority>>, original: Event) {
  if (actor.ownerAuthority) return true;
  if (original.ownerAuthority || !original.roleIdentity) return false;
  if (actor.roleIdentity === original.roleIdentity) return true;
  const grants = original.roleRules.filter((r) => r.startsWith('ALLOW:'));
  return (
    grants.length > 0 &&
    grants.every((r) => actor.roleRules.includes(r)) &&
    actor.roleRules.some((r) => r.startsWith('ALLOW:') && !original.roleRules.includes(r)) &&
    actor.roleRules
      .filter((r) => r.startsWith('DENY:'))
      .every((r) => original.roleRules.includes(r))
  );
}

export async function recordTerminalRefundRoot(
  db: ScopedDb,
  scope: Scope,
  attempt: CardTerminalAttempt,
  options: {
    terminalConfirmed: boolean;
    refund?: { id: string; amountMinor: number; reason: string };
    legacy?: boolean;
    verifiedAmountMinor?: number;
  }
) {
  const refund = options.refund;
  const historical = options.legacy === true;
  const charged = refund || attempt.status === 'REVERSED';
  const reason = refund?.reason ?? attempt.resolutionReason;
  const slipRef = refund ? attempt.providerRef : attempt.resolutionRef;
  if (
    !reason ||
    !slipRef ||
    (!refund && (!attempt.resolvedById || !['DECLINED', 'REVERSED'].includes(attempt.status)))
  )
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'No completed review or settled tender for this refund.',
    });
  checkEvidence(reason, slipRef);
  const unknownAmount =
    attempt.reviewReason === 'Terminal approved a different amount' && !attempt.approvedAmountMinor;
  if (
    options.verifiedAmountMinor !== undefined &&
    attempt.approvedAmountMinor != null &&
    attempt.approvedAmountMinor !== options.verifiedAmountMinor
  )
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The slip amount differs from the terminal approval.',
    });
  const amountMinor =
    refund?.amountMinor ??
    attempt.approvedAmountMinor ??
    options.verifiedAmountMinor ??
    (unknownAmount ? undefined : attempt.amountMinor);
  if (
    !amountMinor ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    amountMinor > 2147483647
  )
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Verify the amount charged from the provider statement.',
    });
  const actorId = refund ? scope.actorId : attempt.resolvedById!;
  const event: Event = {
    id: refund ? 'refund:' + refund.id : 'review:' + attempt.id,
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    attemptId: attempt.id,
    refundId: refund?.id ?? null,
    previousId: null,
    kind: charged ? 'OWED' : 'DECLINED',
    amountMinor,
    actorId,
    reason,
    slipRef,
    // Historical reviews lack an authority snapshot. Require the highest authority to correct one.
    ...(historical
      ? { ownerAuthority: true, roleIdentity: null, roleRules: [] }
      : await reviewAuthority(db, scope, actorId)),
    secondApproverId: null,
    terminalConfirmed: options.terminalConfirmed,
    commandKey: refund ? 'refund:' + refund.id : 'review:' + attempt.id,
    journalId: null,
    createdAt: new Date(),
  };
  if (charged) event.journalId = await bookOwed(db, scope, event);
  return db.pharmacyTerminalRefundEvent.create({ data: event });
}

export function outstandingProviderRefunds(db: ScopedDb, scope: Scope) {
  return db.$queryRaw<Pick<Event, 'id' | 'attemptId' | 'refundId' | 'amountMinor' | 'createdAt'>[]>`
    SELECT e.id,e."attemptId",e."refundId",e."amountMinor",e."createdAt"
    FROM pharmacy_terminal_refund_events e
    WHERE e."organizationId"=${scope.organizationId} AND e."branchId"=${scope.branchId} AND e.kind='OWED'
    AND NOT EXISTS (SELECT 1 FROM pharmacy_terminal_refund_events n WHERE n."previousId"=e.id)
    ORDER BY e."createdAt",e.id`;
}

export async function changeProviderRefund(
  db: ScopedDb,
  scope: Scope,
  input: Change,
  approval: { pinVerified: boolean; secondApproverId?: string }
) {
  if (!approval.pinVerified) throw new TRPCError({ code: 'FORBIDDEN' });
  checkEvidence(input.reason, input.slipRef);
  const where = { organizationId: scope.organizationId, branchId: scope.branchId };
  // Lock the predecessor before inspecting the command or its successor. A competing
  // submission can replay the exact event, but cannot fork the decision chain.
  await db.$queryRaw`SELECT id FROM pharmacy_terminal_refund_events WHERE id=${input.previousId}
    AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`;
  const previous = await db.pharmacyTerminalRefundEvent.findFirst({
    where: { ...where, id: input.previousId },
  });
  if (!previous) throw new TRPCError({ code: 'NOT_FOUND' });
  const attempt = await db.pharmacyCardTerminalAttempt.findFirstOrThrow({
    where: { ...where, id: previous.attemptId },
  });
  if (attempt.actorId === scope.actorId && (await otherCardTerminalReviewers(db, scope)).length)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Another manager or owner must review this payment.',
    });
  if (input.kind === 'DECLINED' && previous.refundId)
    throw new TRPCError({ code: 'CONFLICT', message: 'A tender refund is not a review decision.' });
  const authority = await reviewAuthority(db, scope, scope.actorId);
  if (input.kind !== 'SETTLED') {
    const original = await db.pharmacyTerminalRefundEvent.findUniqueOrThrow({
      where: { id: 'review:' + attempt.id },
    });
    if (!mayCorrectRole(authority, original) || !mayCorrectRole(authority, previous))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This correction requires the same or higher review authority.',
      });
    if (
      (scope.actorId === previous.actorId || scope.actorId === original.actorId) &&
      (!approval.secondApproverId ||
        !(await otherCardTerminalReviewers(db, scope)).some(
          (other) => other.id === approval.secondApproverId
        ))
    )
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'A different reviewer must approve your correction with their own PIN.',
      });
  }
  const amountMinor = input.verifiedAmountMinor ?? previous.amountMinor;
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    amountMinor > 2147483647 ||
    (amountMinor !== previous.amountMinor &&
      (input.kind !== 'OWED' || previous.journalId || attempt.approvedAmountMinor != null))
  )
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The amount must match the recorded obligation.',
    });
  const commandKey = 'action:' + input.commandKey;
  const replay = await db.pharmacyTerminalRefundEvent.findFirst({
    where: { ...where, commandKey },
  });
  if (
    replay &&
    replay.previousId === previous.id &&
    replay.actorId === scope.actorId &&
    replay.kind === input.kind &&
    replay.amountMinor === amountMinor &&
    replay.reason === input.reason &&
    replay.slipRef === input.slipRef
  )
    return replay;
  if (
    replay ||
    (await db.pharmacyTerminalRefundEvent.findUnique({ where: { previousId: previous.id } }))
  )
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This command or decision already has a result.',
    });
  if (
    previous.kind === 'SETTLED' ||
    (input.kind === 'OWED' ? previous.kind !== 'DECLINED' : previous.kind !== 'OWED') ||
    (input.kind === 'DECLINED' && (previous.refundId || previous.terminalConfirmed))
  )
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This correction conflicts with the recorded charge or settlement.',
    });
  if (input.kind === 'OWED') {
    // The original attempt remains immutable. A corrected slip must not claim a charge
    // already identified on another attempt in this organization.
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.organizationId + ':terminal-slip:' + input.slipRef},0))::text`;
    if (
      (await db.pharmacyCardTerminalAttempt.findFirst({
        where: {
          organizationId: scope.organizationId,
          provider: attempt.provider,
          providerRef: input.slipRef,
          id: { not: attempt.id },
        },
      })) ||
      (await db.pharmacyTerminalRefundEvent.findFirst({
        where: {
          organizationId: scope.organizationId,
          attemptId: { not: attempt.id },
          kind: 'OWED',
          slipRef: input.slipRef,
        },
      }))
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Another terminal charge already uses this slip reference.',
      });
  }
  const event: Event = {
    ...previous,
    id: randomUUID(),
    amountMinor,
    previousId: previous.id,
    kind: input.kind,
    journalId: null,
    commandKey,
    actorId: scope.actorId,
    reason: input.reason,
    slipRef: input.slipRef,
    ...authority,
    secondApproverId: approval.secondApproverId ?? null,
    createdAt: new Date(),
  };
  if (input.kind === 'SETTLED') {
    const liability = await db.financeJournalLine.findFirstOrThrow({
      where: { organizationId: scope.organizationId, entryId: previous.journalId!, side: 'CREDIT' },
    });
    event.journalId = await book(db, scope, event, liability.accountCode, 'BANK');
  } else if (previous.journalId) {
    const entry = await reverseJournalEntry(db, scope, {
      entryId: previous.journalId,
      reason: input.reason,
      at: event.createdAt,
      idempotencyKey: 'terminal-refund:' + event.id,
    });
    event.journalId = entry.id;
  } else {
    event.journalId = await bookOwed(db, scope, event);
  }
  const result = await db.pharmacyTerminalRefundEvent.create({ data: event });
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorType: 'USER',
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'CREATE',
      action: 'pharmacyCardTerminal.refund.' + input.kind,
      targetType: 'PharmacyTerminalRefundEvent',
      targetId: event.id,
      metadata: {
        previousId: previous.id,
        attemptId: event.attemptId,
        branchId: scope.branchId,
        reason: input.reason,
        secondApproverId: event.secondApproverId,
        pinVerified: true,
        soloOwner: attempt.actorId === scope.actorId,
      },
    },
  });
  return result;
}

// A decision made before the refund journal was introduced keeps its original identity.
// Only the original decision is materialized here, under its attempt lock.
export async function loadOriginalReview(
  db: ScopedDb,
  scope: Scope,
  attemptId: string,
  verifiedAmountMinor?: number
) {
  await db.$queryRaw`SELECT id FROM pharmacy_card_terminal_attempts WHERE id=${attemptId} AND
    "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`;
  const where = { organizationId: scope.organizationId, branchId: scope.branchId };
  const attempt = await db.pharmacyCardTerminalAttempt.findFirst({
    where: { ...where, id: attemptId },
  });
  if (!attempt || !attempt.resolvedById) throw new TRPCError({ code: 'NOT_FOUND' });
  const existing = await db.pharmacyTerminalRefundEvent.findFirst({
    where: { ...where, id: 'review:' + attemptId },
  });
  if (existing) return existing;
  const audit = await db.auditLog.findFirst({
    where: {
      organizationId: scope.organizationId,
      targetId: attemptId,
      action: 'pharmacyCardTerminal.attempt.manualReview',
    },
    select: { metadata: true },
  });
  const before = audit?.metadata;
  const confirmed =
    attempt.status === 'REVERSED' &&
    !(
      before &&
      typeof before === 'object' &&
      'providerRef' in before &&
      before.providerRef === null
    );
  return recordTerminalRefundRoot(db, scope, attempt, {
    legacy: true,
    terminalConfirmed: confirmed,
    verifiedAmountMinor,
  });
}
