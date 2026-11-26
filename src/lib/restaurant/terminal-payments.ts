import 'server-only';

import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { runMoneyTransaction } from './drawer-sessions';
import { equals, money, sub, sum, ZERO } from './money';
import { applyTenderInTransaction } from './tenders';

const MONEY = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);

export const terminalEventSchema = z
  .object({
    status: z.enum(['initiated', 'approved', 'declined', 'voided']),
    terminalId: z.string().min(1).max(200),
    reference: z.string().min(1).max(200),
    amount: MONEY,
    tipAmount: MONEY.optional(),
    staffProfileId: z.string().min(1).max(200),
    providerReference: z.string().min(1).max(200),
  })
  .strict();

export type TerminalEvent = z.infer<typeof terminalEventSchema>;

export class TerminalPaymentError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'CONFIG_NOT_FOUND'
      | 'CONFIG_DISABLED'
      | 'MODE_MISMATCH'
      | 'BILL_MISMATCH'
      | 'OPERATOR_MISMATCH'
  ) {
    super(message);
    this.name = 'TerminalPaymentError';
  }
}

type ProcessInput = {
  source: string;
  externalEventId: string;
  event: TerminalEvent;
  requiredMode?: 'WEBHOOK' | 'SIMULATION';
};

export function processTerminalEvent(db: ScopedDb, input: ProcessInput) {
  return runMoneyTransaction(db, (tx) => processTerminalEventInTransaction(tx, input));
}

async function processTerminalEventInTransaction(db: ScopedDb, input: ProcessInput) {
  // Serialize one provider event before checking for its reconciliation. The
  // unique reconciliation/idempotency indexes remain the final integrity
  // boundary; this transaction-scoped lock turns their concurrent loser into
  // the same deterministic replay returned by a later sequential delivery.
  // Include the RLS tenant in the key so identical provider ids in two
  // organizations do not block one another.
  await db.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        jsonb_build_array(
          current_setting('app.current_organization_id'),
          ${input.source}::text,
          ${input.externalEventId}::text
        )::text,
        0
      )
    )::text
  `;

  const replay = await db.restaurantTerminalReconciliation.findFirst({
    where: { source: input.source, externalEventId: input.externalEventId },
  });
  if (replay) return { reconciliation: replay, replayed: true };

  const config = await db.restaurantTerminalProviderConfig.findFirst({
    where: { source: input.source, externalTerminalId: input.event.terminalId },
    select: { id: true, branchId: true, deviceId: true, mode: true },
  });
  if (!config)
    throw new TerminalPaymentError('Terminal configuration not found.', 'CONFIG_NOT_FOUND');
  if (config.mode === 'DISABLED')
    throw new TerminalPaymentError('Terminal integration is disabled.', 'CONFIG_DISABLED');
  if (input.requiredMode && config.mode !== input.requiredMode) {
    throw new TerminalPaymentError(
      'Terminal event mode does not match branch configuration.',
      'MODE_MISMATCH'
    );
  }

  const amount = money(input.event.amount);
  const tipAmount = money(input.event.tipAmount ?? ZERO);
  const eventStatus = input.event.status.toUpperCase() as
    'INITIATED' | 'APPROVED' | 'DECLINED' | 'VOIDED';

  const bill = await db.restaurantBill.findFirst({
    where: { id: input.event.reference, branchId: config.branchId, status: 'OPEN' },
    select: {
      id: true,
      grandTotal: true,
      tenders: { select: { amount: true } },
    },
  });
  const operator = await db.restaurantStaffProfile.findFirst({
    where: {
      id: input.event.staffProfileId,
      primaryBranchId: config.branchId,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  const outstanding = bill
    ? sub(bill.grandTotal, sum(bill.tenders.map((row) => row.amount)))
    : null;
  const failureReason = !bill
    ? 'BILL_NOT_OPEN_OR_BRANCH_MISMATCH'
    : !operator
      ? 'OPERATOR_NOT_ACTIVE_IN_BRANCH'
      : !equals(outstanding!, amount)
        ? 'AMOUNT_MISMATCH'
        : null;

  if (failureReason) {
    const reconciliation = await recordReconciliation(db, {
      configId: config.id,
      branchId: config.branchId,
      externalEventId: input.externalEventId,
      source: input.source,
      eventStatus,
      externalReference: input.event.reference,
      amount,
      tipAmount,
      billId: bill?.id,
      outcome: 'REJECTED',
      failureReason,
    });
    return { reconciliation, replayed: false };
  }

  if (eventStatus !== 'APPROVED') {
    const reconciliation = await recordReconciliation(db, {
      configId: config.id,
      branchId: config.branchId,
      externalEventId: input.externalEventId,
      source: input.source,
      eventStatus,
      externalReference: input.event.reference,
      amount,
      tipAmount,
      billId: bill!.id,
      outcome: 'RECORDED',
    });
    return { reconciliation, replayed: false };
  }

  const applied = await applyTenderInTransaction(db, {
    billId: bill!.id,
    tender: {
      type: 'CARD',
      amount,
      tipAmount,
      terminalConfirmation: {
        configId: config.id,
        branchId: config.branchId,
        externalEventId: input.externalEventId,
        source: input.source,
        externalReference: input.event.reference,
        providerRef: input.event.providerReference,
      },
    },
    actor: {
      staffProfileId: operator!.id,
      deviceId: config.deviceId,
      idempotencyKey: `terminal:${input.externalEventId}`,
    },
  });
  const reconciliation = await db.restaurantTerminalReconciliation.findFirstOrThrow({
    where: { source: input.source, externalEventId: input.externalEventId },
  });
  return { reconciliation, tender: applied, replayed: false };
}

export function simulateTerminalEvent(db: ScopedDb, input: Omit<ProcessInput, 'requiredMode'>) {
  return processTerminalEvent(db, { ...input, requiredMode: 'SIMULATION' });
}

function recordReconciliation(
  db: ScopedDb,
  data: Prisma.RestaurantTerminalReconciliationUncheckedCreateInput
) {
  return db.restaurantTerminalReconciliation.create({ data });
}
