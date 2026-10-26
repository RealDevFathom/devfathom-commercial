import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate, resolveBusinessDate } from './business-date';
import { assertMoneyDayOpen } from './daily-close';
import { appendMovement, beginMoneyIdempotent, recordMoneyResult } from './drawer-sessions';
import { resolveStaffCapabilities } from './job-roles';
import { money, ZERO } from './money';
import {
  assertActorEligibleForBranch,
  assertAuthorizedBranch,
  type StaffBranchAuthorization,
} from './staff-branch-authorization';

/** Internal server context only: derive from authenticated tenant + verified device/session.
 * Never deserialize this from a request. The route also gates the restaurant module.
 * `authorization` comes from resolveCapabilityBranchAuthorization(catering:manage).
 */
export type CateringMoneyScope = {
  organizationId: string;
  branchId: string;
  staffProfileId: string;
  deviceId: string;
  authorization: StaffBranchAuthorization;
};
export type CateringMoneyInput = {
  cateringOrderId: string;
  quoteRevisionId: string;
  kind: 'DEPOSIT' | 'BALANCE' | 'REFUND';
  amount: string;
  currency: string;
  source: 'CASH' | 'OPERATOR_ATTESTED';
  originalEvidenceId?: string;
  externalEvidenceSource?: string;
  externalEvidenceReference?: string;
  drawerSessionId?: string;
  idempotencyKey: string;
};
export type CateringEvidence = {
  id: string;
  quoteRevisionId: string;
  kind: CateringMoneyInput['kind'];
  amount: string;
  currency: string;
  source: CateringMoneyInput['source'];
  originalEvidenceId: string | null;
  drawerMovementId: string | null;
};
export class CateringMoneyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CateringMoneyError';
  }
}
function deny(reason: string): never {
  throw new CateringMoneyError(reason);
}
function text(value: string | undefined, name: string): string {
  if (!value || value.trim() !== value || value.length > 200) deny(`INVALID_${name}`);
  return value;
}
export function validateCateringMoneyInput(input: CateringMoneyInput): Prisma.Decimal {
  text(input.cateringOrderId, 'ORDER');
  text(input.quoteRevisionId, 'QUOTE');
  text(input.idempotencyKey, 'KEY');
  if (!['DEPOSIT', 'BALANCE', 'REFUND'].includes(input.kind)) deny('INVALID_KIND');
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(input.amount)) deny('INVALID_AMOUNT');
  const amount = money(input.amount);
  if (!amount.greaterThan(0)) deny('INVALID_AMOUNT');
  if (!/^[A-Z]{3}$/.test(input.currency)) deny('INVALID_CURRENCY');
  if (input.kind === 'REFUND') text(input.originalEvidenceId, 'ORIGINAL');
  else if (input.originalEvidenceId !== undefined) deny('UNEXPECTED_ORIGINAL');
  if (input.source === 'CASH') {
    text(input.drawerSessionId, 'DRAWER');
    if (
      input.externalEvidenceSource !== undefined ||
      input.externalEvidenceReference !== undefined
    ) {
      deny('UNEXPECTED_EXTERNAL_EVIDENCE');
    }
  } else if (input.source === 'OPERATOR_ATTESTED') {
    text(input.externalEvidenceSource, 'SOURCE');
    text(input.externalEvidenceReference, 'REFERENCE');
    if (input.drawerSessionId !== undefined) deny('UNEXPECTED_DRAWER');
  } else deny('INVALID_SOURCE');
  return amount;
}

/** No planned deposit is included in receipts. No tax/revenue/provider assertions. */
export function summarizeCateringMoney(
  approvedQuoteTotal: string | null,
  plannedDepositAmount: string | null,
  evidence: readonly CateringEvidence[],
  currency: string
) {
  let receipts = ZERO;
  let refunds = ZERO;
  for (const row of evidence) {
    if (row.currency !== currency) deny('CURRENCY_MISMATCH');
    if (row.kind === 'REFUND') refunds = refunds.plus(row.amount);
    else receipts = receipts.plus(row.amount);
  }
  const net = receipts.minus(refunds);
  return {
    approvedQuoteTotal,
    plannedDepositAmount,
    recordedReceipts: receipts.toFixed(2),
    recordedRefunds: refunds.toFixed(2),
    netPaid: net.toFixed(2),
    refundableBalance: net.toFixed(2),
    amountDue:
      approvedQuoteTotal === null
        ? null
        : Prisma.Decimal.max(0, money(approvedQuoteTotal).minus(net)).toFixed(2),
    currency,
  };
}

export function assertCateringEvidenceLimit(
  input: CateringMoneyInput,
  approvedQuoteTotal: string,
  evidence: readonly CateringEvidence[]
): void {
  const amount = validateCateringMoneyInput(input);
  const summary = summarizeCateringMoney(approvedQuoteTotal, null, evidence, input.currency);
  if (input.kind !== 'REFUND') {
    if (money(summary.netPaid).plus(amount).greaterThan(approvedQuoteTotal)) deny('OVERPAYMENT');
    return;
  }
  const original = evidence.find(
    (row) => row.id === input.originalEvidenceId && row.kind !== 'REFUND'
  );
  if (!original || original.currency !== input.currency || original.source !== input.source)
    deny('ORIGINAL_MISMATCH');
  const refunded = evidence
    .filter((row) => row.originalEvidenceId === original.id)
    .reduce((total, row) => total.plus(row.amount), ZERO);
  if (refunded.plus(amount).greaterThan(original.amount)) deny('OVER_REFUND');
}

type Quote = {
  id: string;
  revision: number;
  orderRevision: number;
  approvedQuoteRevisionId: string | null;
  currency: string;
  quotedTotal: string;
  approvalId: string | null;
  contentHash: string;
};

/** Caller must propagate failure out of the tenant transaction. No nested transaction,
 * provider, bill, tender, receipt, inventory, or settlement writes. Requires the centrally
 * composed quote/approval and evidence fragments; intentionally not wired to a route yet.
 */
export async function recordCateringMoneyEvidence(
  tx: ScopedDb,
  scope: CateringMoneyScope,
  input: CateringMoneyInput
): Promise<{ evidenceId: string; ledgerReference: string | null; replayed: boolean }> {
  const amount = validateCateringMoneyInput(input);
  assertAuthorizedBranch(scope.authorization, scope.branchId);
  assertActorEligibleForBranch(scope.authorization, scope.branchId);
  if (scope.authorization.actorStaffProfileId !== scope.staffProfileId) deny('ACTOR_MISMATCH');
  const staff = await tx.restaurantStaffProfile.findFirst({
    where: { id: scope.staffProfileId, organizationId: scope.organizationId, status: 'ACTIVE' },
    select: { id: true },
  });
  const device = await tx.restaurantRegisteredDevice.findFirst({
    where: {
      id: scope.deviceId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'ACTIVE',
      revokedAt: null,
    },
    select: { branch: { select: { timezone: true, businessDayCutoff: true } } },
  });
  if (!staff || !device) deny('ACTOR_OR_DEVICE_DENIED');
  const capabilities = await resolveStaffCapabilities(tx, scope.staffProfileId, scope.branchId);
  if (
    !capabilities.has('catering:manage') ||
    (input.kind === 'REFUND' && !capabilities.has('payments:refund')) ||
    (input.source === 'CASH' && !capabilities.has('cash:adjust'))
  )
    deny('CAPABILITY_DENIED');

  // Same lock as catering edits/approval/disposition. All cap reads occur after it.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.cateringOrderId}, 0))`;
  const order = await tx.restaurantCateringOrder.findFirst({
    where: {
      id: input.cateringOrderId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: { id: true, status: true },
  });
  if (!order) deny('ORDER_NOT_FOUND');
  const actor = {
    staffProfileId: scope.staffProfileId,
    deviceId: scope.deviceId,
    idempotencyKey: input.idempotencyKey,
  };
  const bytes = JSON.stringify({
    version: 1,
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    staffProfileId: scope.staffProfileId,
    deviceId: scope.deviceId,
    orderId: order.id,
    quoteRevisionId: input.quoteRevisionId,
    kind: input.kind,
    amount: amount.toFixed(2),
    currency: input.currency,
    source: input.source,
    originalEvidenceId: input.originalEvidenceId ?? null,
    externalEvidenceSource: input.externalEvidenceSource ?? null,
    externalEvidenceReference: input.externalEvidenceReference ?? null,
    drawerSessionId: input.drawerSessionId ?? null,
  });
  const replay = await beginMoneyIdempotent(tx, actor, 'catering.evidence', {
    bytes,
    hash: createHash('sha256').update(bytes, 'utf8').digest('hex'),
  });
  if (replay.replay) {
    const result = replay.resultPayload;
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      typeof result.evidenceId !== 'string' ||
      !(result.ledgerReference === null || typeof result.ledgerReference === 'string')
    )
      deny('INVALID_REPLAY');
    return {
      evidenceId: result.evidenceId,
      ledgerReference: result.ledgerReference,
      replayed: true,
    };
  }
  if (
    input.kind !== 'REFUND' &&
    !['DRAFT', 'QUOTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'DELIVERED'].includes(order.status)
  ) {
    deny('ORDER_NOT_RECEIVABLE');
  }
  const quotes = await tx.$queryRaw<Quote[]>`
    SELECT q.id, q.revision, o.revision AS "orderRevision", o."approvedQuoteRevisionId",
           q.snapshot->>'currency' AS currency, q.snapshot->>'quotedTotal' AS "quotedTotal",
           q."contentHash", a.id AS "approvalId"
    FROM restaurant_catering_orders o
    JOIN restaurant_catering_quote_revisions q ON q."organizationId" = o."organizationId" AND q."orderId" = o.id
    LEFT JOIN restaurant_catering_quote_approvals a ON a."organizationId" = q."organizationId"
      AND a."orderId" = o.id AND a."quoteRevisionId" = q.id AND a."orderRevision" = q.revision
    WHERE o.id = ${order.id} AND o."organizationId" = ${scope.organizationId}
      AND o."branchId" = ${scope.branchId} AND q.id = ${input.quoteRevisionId}`;
  const quote = quotes[0];
  if (!quote || !quote.approvalId || !quote.contentHash) deny('STALE_OR_UNAPPROVED_QUOTE');
  if (
    input.kind !== 'REFUND' &&
    (quote.approvedQuoteRevisionId !== quote.id || quote.orderRevision !== quote.revision)
  )
    deny('STALE_OR_UNAPPROVED_QUOTE');
  if (quote.currency !== input.currency) deny('CURRENCY_MISMATCH');
  if (!quote.quotedTotal || !/^\d{1,10}(?:\.\d{1,2})?$/.test(quote.quotedTotal))
    deny('INVALID_QUOTE_TOTAL');
  const evidence = await tx.$queryRaw<CateringEvidence[]>`
    SELECT id, "quoteRevisionId", kind, amount::text, currency, source, "originalEvidenceId", "drawerMovementId"
    FROM restaurant_catering_money_evidence
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND "cateringOrderId" = ${order.id}`;
  if (input.kind === 'REFUND') {
    // Evidence is tenant/branch/order scoped. A refund names the receipt's exact
    // historically approved quote, never arbitrary history or new commercial terms.
    const original = evidence.find(
      (row) => row.id === input.originalEvidenceId && row.kind !== 'REFUND'
    );
    if (!original || original.quoteRevisionId !== quote.id) deny('ORIGINAL_MISMATCH');
  }
  assertCateringEvidenceLimit(input, quote.quotedTotal, evidence);
  const businessDate = businessDateToUtcDate(
    resolveBusinessDate(new Date(), device.branch.timezone, device.branch.businessDayCutoff)
  );
  await assertMoneyDayOpen(tx, scope.branchId, businessDate);
  const evidenceId = randomUUID();
  let ledgerReference: string | null = null;
  if (input.source === 'CASH') {
    const drawer = await tx.restaurantDrawerSession.findFirst({
      where: {
        id: input.drawerSessionId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: scope.deviceId,
        staffProfileId: scope.staffProfileId,
        businessDate,
        status: 'OPEN',
      },
      select: { id: true },
    });
    if (!drawer) deny('DRAWER_DENIED');
    const movement = await appendMovement(tx, {
      drawerSessionId: drawer.id,
      kind: input.kind === 'REFUND' ? 'PAID_OUT' : 'PAID_IN',
      amount,
      staffProfileId: scope.staffProfileId,
      deviceId: scope.deviceId,
      reason: `Catering evidence ${evidenceId}`,
    });
    ledgerReference = movement.movementId;
  }
  await tx.$executeRaw`
    INSERT INTO restaurant_catering_money_evidence
      (id, "organizationId", "branchId", "cateringOrderId", "quoteRevisionId", kind, amount, currency,
       source, "originalEvidenceId", "externalEvidenceSource", "externalEvidenceReference", "drawerMovementId",
       "actorStaffProfileId", "deviceId", "businessDate")
    VALUES (${evidenceId}, ${scope.organizationId}, ${scope.branchId}, ${order.id}, ${quote.id},
      ${input.kind}, ${amount.toFixed(2)}::numeric, ${input.currency}, ${input.source},
      ${input.originalEvidenceId ?? null}, ${input.externalEvidenceSource ?? null},
      ${input.externalEvidenceReference ?? null}, ${ledgerReference}, ${scope.staffProfileId}, ${scope.deviceId}, ${businessDate})`;
  await tx.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorType: 'RESTAURANT_OPERATOR',
      actorStaffProfileId: scope.staffProfileId,
      source: 'SYSTEM',
      category: 'RESTAURANT',
      operation: 'CREATE',
      action: 'catering.recordMoneyEvidence',
      targetType: 'CateringMoneyEvidence',
      targetId: evidenceId,
      result: {
        kind: input.kind,
        source: input.source,
        amount: amount.toFixed(2),
        currency: input.currency,
        ledgerReference,
      },
    },
  });
  await recordMoneyResult(tx, actor, evidenceId, { evidenceId, ledgerReference });
  return { evidenceId, ledgerReference, replayed: false };
}
