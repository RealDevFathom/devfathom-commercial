import { pharmacyCalendarDay } from '../business-day';
import 'server-only';
import { capabilityMatches } from '@/lib/abac/capabilities';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { FinanceAccountCode, PharmacyTerminalRefundEvent } from '@/generated/prisma/client';
import { postJournalEntry, reverseJournalEntry } from '@/lib/finance/journal';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
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
  settlementAmountMinor?: number;
  settledOn?: string;
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
    occurredAt: event.settledOn ?? event.createdAt,
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
  // A reviewed charge never became a tender. A returned sale already reversed its revenue
  // into sales clearing. Only a confirmed provider settlement credits the bank.
  return book(db, scope, event, event.refundId ? 'SALES_CLEARING' : 'BANK', 'CARD_REFUNDS_PAYABLE');
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

type Authority = Pick<Event, 'ownerAuthority' | 'roleIdentity' | 'roleRules'>;
function includesGrant(rules: string[], grant: string) {
  return (
    rules.includes(grant) ||
    rules.some(
      (rule) => rule.startsWith('ALLOW:') && capabilityMatches(rule.slice(6), grant.slice(6))
    )
  );
}
export function mayCorrectRole(actor: Authority, original: Authority) {
  if (actor.ownerAuthority) return true;
  if (original.ownerAuthority || !original.roleIdentity) return false;
  if (actor.roleIdentity === original.roleIdentity) return true;
  const grants = original.roleRules.filter((rule) => rule.startsWith('ALLOW:'));
  return (
    grants.length > 0 &&
    grants.every((grant) => includesGrant(actor.roleRules, grant)) &&
    actor.roleRules.some(
      (grant) => grant.startsWith('ALLOW:') && !includesGrant(original.roleRules, grant)
    ) &&
    actor.roleRules
      .filter((rule) => rule.startsWith('DENY:'))
      .every((rule) => original.roleRules.includes(rule))
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
    remainingMinor: charged ? amountMinor : 0,
    settledOn: null,
    selfApproved: false,
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

export function providerRefundAccounts(db: ScopedDb, scope: Scope) {
  return db.$queryRaw<
    (Pick<
      Event,
      | 'id'
      | 'attemptId'
      | 'refundId'
      | 'amountMinor'
      | 'remainingMinor'
      | 'kind'
      | 'actorId'
      | 'terminalConfirmed'
    > & { createdAt: Date; attemptKey: string; originalActorId: string; chargeActorId: string })[]
  >`
    SELECT e.id,e."attemptId",e."refundId",e."amountMinor",e."remainingMinor",e.kind,e."actorId",e."terminalConfirmed",
      CASE WHEN root."refundId" IS NULL THEN COALESCE(a."resolvedAt", root."createdAt") ELSE root."createdAt" END AS "createdAt", root."actorId" AS "originalActorId",a."attemptKey",a."actorId" AS "chargeActorId"
    FROM pharmacy_terminal_refund_events e
    JOIN pharmacy_card_terminal_attempts a ON a.id=e."attemptId" AND a."organizationId"=e."organizationId" AND a."branchId"=e."branchId"
    JOIN pharmacy_terminal_refund_events root ON root."attemptId"=e."attemptId" AND root."refundId" IS NOT DISTINCT FROM e."refundId" AND root."previousId" IS NULL
    WHERE e."organizationId"=${scope.organizationId} AND e."branchId"=${scope.branchId}
    AND NOT EXISTS (SELECT 1 FROM pharmacy_terminal_refund_events n WHERE n."previousId"=e.id)
    ORDER BY (e."remainingMinor">0) DESC, root."createdAt",e.id`;
}

export async function outstandingProviderRefunds(db: ScopedDb, scope: Scope) {
  return (await providerRefundAccounts(db, scope)).filter((row) => row.remainingMinor > 0);
}

export async function reversedTenderRefundIds(
  db: ScopedDb,
  scope: Scope,
  refunds: { id: string }[]
) {
  if (!refunds.length) return new Set<string>();
  const events = await db.pharmacyTerminalRefundEvent.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      kind: 'DECLINED',
      refundId: { in: refunds.map((r) => r.id) },
    },
    select: { refundId: true },
  });
  return new Set(events.map((e) => e.refundId));
}

export async function changeProviderRefund(
  db: ScopedDb,
  scope: Scope,
  input: Change,
  approval: { pinVerified: boolean; secondApproverId?: string; declareSelfApproval?: boolean }
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
  if (previous.refundId && input.kind === 'DECLINED') {
    const sale = await db.$queryRaw<
      { status: string }[]
    >`SELECT status FROM pharmacy_sales WHERE id=${attempt.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`;
    if (sale[0]?.status === 'VOID')
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A voided bill requires its terminal payment to remain refunded.',
      });
  }
  let selfApproved = false;
  const authority = await reviewAuthority(db, scope, scope.actorId);
  if (input.kind !== 'SETTLED') {
    const original = await db.pharmacyTerminalRefundEvent.findUniqueOrThrow({
      where: { id: previous.refundId ? 'refund:' + previous.refundId : 'review:' + attempt.id },
    });
    if (!mayCorrectRole(authority, original) || !mayCorrectRole(authority, previous))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This correction requires the same or higher review authority.',
      });
    if (scope.actorId === previous.actorId || scope.actorId === original.actorId) {
      const peers = await otherCardTerminalReviewers(db, scope);
      selfApproved =
        authority.ownerAuthority &&
        peers.length === 0 &&
        approval.declareSelfApproval === true &&
        !approval.secondApproverId;
      if (!selfApproved && !peers.some((peer) => peer.id === approval.secondApproverId))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'Independent approval is required. A sole owner must explicitly sign off with their own approval code.',
        });
    }
  }
  const settling = input.kind === 'SETTLED';
  const amountMinor = settling
    ? (input.settlementAmountMinor ?? previous.remainingMinor)
    : (input.verifiedAmountMinor ?? previous.amountMinor);
  const settledOn = settling
    ? new Date((input.settledOn ?? pharmacyCalendarDay('UTC')) + 'T00:00:00Z')
    : null;
  if (
    settledOn &&
    (!Number.isFinite(settledOn.getTime()) ||
      (input.settledOn && pharmacyCalendarDay('UTC', settledOn) !== input.settledOn))
  )
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter a valid settlement date.' });
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    amountMinor > 2147483647 ||
    (settling
      ? amountMinor > previous.remainingMinor
      : amountMinor !== previous.amountMinor &&
        (input.kind !== 'OWED' || previous.journalId || attempt.approvedAmountMinor != null))
  )
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The amount exceeds or conflicts with the recorded obligation.',
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
    (!input.settledOn || replay.settledOn?.getTime() === settledOn?.getTime()) &&
    replay.secondApproverId === (approval.secondApproverId ?? null) &&
    replay.selfApproved === selfApproved &&
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
    settling
      ? previous.remainingMinor <= 0
      : input.kind === 'OWED'
        ? previous.kind !== 'DECLINED' || !!previous.refundId
        : previous.kind !== 'OWED' || (!previous.refundId && previous.terminalConfirmed)
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
    remainingMinor: settling
      ? previous.remainingMinor - amountMinor
      : input.kind === 'OWED'
        ? amountMinor
        : 0,
    settledOn,
    selfApproved,
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
    event.journalId = await book(db, scope, event, 'CARD_REFUNDS_PAYABLE', 'BANK');
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
        soloOwner: selfApproved,
        selfApproved,
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
