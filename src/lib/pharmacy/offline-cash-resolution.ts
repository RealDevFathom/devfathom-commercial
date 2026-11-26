import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { postJournalEntry } from '@/lib/finance/journal';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacyBusinessDate } from './business-day';
import { readPharmacyDayClock } from './business-day-clock';
import {
  applyPharmacyTender,
  recordPharmacyCashMovement,
  resolveOperatingPharmacyDrawer,
} from './settlement';
import type { LedgerScope } from './stock-ledger';

export const offlineCashResolutionSchema = z.object({
  eventId: z.string().min(1).max(128),
  outcome: z.enum(['REBOOK', 'REFUND', 'WRITE_OFF']),
  reason: z.string().trim().min(1).max(500),
  saleId: z.string().trim().min(1).max(128).optional(),
});

export function resolutionAuditId(org: string, device: string, key: string) {
  return createHash('sha256')
    .update(JSON.stringify(['offline-cash-resolution', org, device, key]))
    .digest('hex');
}

/** Caller verifies the branch, the actor's fresh approval, and owner authority for write-offs. */
export async function resolveOfflineCash(
  db: ScopedDb,
  scope: LedgerScope,
  input: z.infer<typeof offlineCashResolutionSchema>
) {
  const { organizationId, branchId, actorId } = scope;
  if ((input.outcome === 'REBOOK') !== Boolean(input.saleId))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A re-booking needs the unpaid sale ID.' });
  const receipt = await db.pharmacyOfflineReceiptEvent.findFirst({
    where: {
      id: input.eventId,
      organizationId,
      branchId,
      kind: { in: ['REJECTED', 'QUARANTINED'] },
    },
  });
  if (!receipt) throw new TRPCError({ code: 'NOT_FOUND' });
  const [command] = await db.$queryRaw<
    { id: string }[]
  >`SELECT id FROM pharmacy_offline_commands WHERE "organizationId"=${organizationId} AND "branchId"=${branchId} AND "deviceId"=${receipt.deviceId} AND "idempotencyKey"=${receipt.commandKey} AND action='CASH_OTC_SALE' AND status IN ('REJECTED','DEAD') FOR UPDATE`;
  if (!command)
    throw new TRPCError({ code: 'CONFLICT', message: 'No held cash for this receipt.' });
  const auditId = resolutionAuditId(organizationId, receipt.deviceId, receipt.commandKey);
  const previous = await db.auditLog.findFirst({
    where: { id: auditId, organizationId },
    select: { metadata: true },
  });
  if (previous) {
    const data = previous.metadata;
    if (
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      data.outcome === input.outcome &&
      data.reason === input.reason &&
      data.saleId === (input.saleId ?? null)
    )
      return { replayed: true };
    throw new TRPCError({ code: 'CONFLICT', message: 'This cash has already been resolved.' });
  }
  const held = await db.financeJournalEntry.findFirst({
    where: {
      organizationId,
      branchId,
      sourceKind: 'PHARMACY_REJECTED_OFFLINE_CASH',
      sourceId: command.id,
    },
    include: { lines: { where: { accountCode: 'OFFLINE_CASH_SUSPENSE', side: 'CREDIT' } } },
  });
  const amountMinor = Number(held?.lines[0]?.amountMinor);
  if (!held || held.lines.length !== 1 || !Number.isSafeInteger(amountMinor) || amountMinor <= 0)
    throw new TRPCError({ code: 'CONFLICT', message: 'This receipt has no cash in suspense.' });
  const at = new Date();
  const businessDate = pharmacyBusinessDate(await readPharmacyDayClock(db, scope), at);
  const key = 'offline-cash-resolution:' + command.id;
  let tenderId: string | null = null;
  let movementId: string | null = null;
  if (input.outcome === 'REBOOK' && input.saleId) {
    const result = await applyPharmacyTender(
      db,
      scope,
      {
        saleId: input.saleId,
        deviceId: receipt.deviceId,
        businessDate,
        type: 'CASH',
        amountMinor,
        idempotencyKey: key,
      },
      undefined,
      {
        drawerOperator: { kind: 'COUNTER', actorIsManager: true },
        requireCurrentBusinessDate: true,
        fundedFromOfflineSuspense: true,
      }
    );
    if (
      !('settled' in result) ||
      !result.settled ||
      !('tenderId' in result) ||
      typeof result.tenderId !== 'string'
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The unpaid balance must match the held cash.',
      });
    tenderId = result.tenderId;
  } else if (input.outcome === 'REFUND') {
    const operator = { kind: 'COUNTER', actorIsManager: true } as const;
    const drawer = await resolveOperatingPharmacyDrawer(
      db,
      scope,
      { deviceId: receipt.deviceId, businessDate },
      operator
    );
    const out = await recordPharmacyCashMovement(
      db,
      scope,
      {
        drawerSessionId: drawer.id,
        kind: 'PAID_OUT',
        amountMinor,
        reason: 'Refund of offline receipt ' + receipt.receiptNumber + ': ' + input.reason,
        requireCurrentBusinessDate: true,
      },
      operator
    );
    movementId = out.id;
  }
  // A normal sale tender debits cash. Offset it with the held cash so the sale has
  // one payment and the drawer never receives the customer's cash a second time.
  const leg = { amountMinor, branchId, sourceLineId: movementId ?? tenderId ?? command.id };
  const entry = await postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_OFFLINE_CASH_RESOLUTION',
    sourceId: command.id,
    branchId,
    occurredAt: at,
    idempotencyKey: key,
    description: 'Resolved offline receipt ' + receipt.receiptNumber,
    lines: [
      { ...leg, accountCode: 'OFFLINE_CASH_SUSPENSE', side: 'DEBIT' },
      {
        ...leg,
        accountCode: input.outcome === 'WRITE_OFF' ? 'CASH_OVER_SHORT' : 'CASH',
        side: 'CREDIT',
      },
    ],
  });
  await db.auditLog.create({
    data: {
      id: auditId,
      organizationId,
      actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'UPDATE',
      action: 'pharmacyOffline.resolveCash',
      targetType: 'PharmacyOfflineCommand',
      targetId: command.id,
      metadata: {
        branchId,
        deviceId: receipt.deviceId,
        receiptNumber: receipt.receiptNumber,
        outcome: input.outcome,
        reason: input.reason,
        saleId: input.saleId ?? null,
        tenderId,
        movementId,
        amountMinor,
        journalId: entry.id,
        approvedAt: at.toISOString(),
      },
    },
  });
  return { replayed: false };
}
