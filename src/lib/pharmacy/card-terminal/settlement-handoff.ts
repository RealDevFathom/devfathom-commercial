import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { applyPharmacyTender, refundPharmacyTender } from '../settlement';
import { refundIdempotencyKeyFor, tenderIdempotencyKeyFor, TerminalIntentError } from './intent';
import type { CardTerminalService, TerminalScope } from './service';

/**
 * DEV-743 — record an approved terminal outcome in pharmacy settlement.
 *
 * These helpers are the intended callers of `settlementAdapter` and `startReversal`.
 * Callers run each one inside the pharmacy money transaction (`db` is that
 * transaction). Each helper:
 *  1. takes the sale lock (and, for refunds, the tender lock) in settlement's order;
 *  2. checks the LEDGER first. A committed tender or refund for this approval is adopted
 *     from any device. A claim or SETTLED mark without a ledger row is reopened. A lost
 *     claim or a failed commit can therefore never wedge a charge;
 *  3. takes the sale, tender and amount from the STORED intent, never from the request.
 *
 * Nothing is wired to a router or the counter yet. With no admitted provider,
 * settlement refuses every call with UNCERTIFIED_PROVIDER.
 */

type SettleInput = { deviceId: string; businessDate: Date };

async function lockSale(db: ScopedDb, scope: TerminalScope, saleId: string) {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id = ${saleId} AND "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} FOR UPDATE`
  );
}

async function lockTender(db: ScopedDb, scope: TerminalScope, tenderId: string) {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_tenders WHERE id = ${tenderId} AND "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} FOR UPDATE`
  );
}

/** Record an APPROVED SALE intent as one CARD tender. Idempotent. */
export async function settleApprovedTerminalSale(
  db: ScopedDb,
  service: CardTerminalService,
  scope: TerminalScope,
  input: SettleInput & { intentRef: string }
) {
  let intent = await service.getIntent(scope, input.intentRef);
  if (intent.kind !== 'SALE') throw new TerminalIntentError('INVALID_INPUT', 'Not a sale intent.');
  if (!intent.providerRef || !['APPROVED', 'SETTLED'].includes(intent.state))
    throw new TerminalIntentError('INVALID_TRANSITION', `Intent is ${intent.state}.`);
  await lockSale(db, scope, intent.saleId);
  const found = await db.pharmacyTender.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: intent.saleId,
      provider: intent.providerName,
      providerRef: intent.providerRef,
    },
    select: { id: true },
  });
  intent = await service.reconcileWithLedger(scope, intent.intentRef, found);
  if (intent.state === 'SETTLED' && intent.ledgerRef)
    return { tenderId: intent.ledgerRef, replayed: true as const };

  const adapter = service.settlementAdapter(scope, intent.intentRef);
  let result: Awaited<ReturnType<typeof applyPharmacyTender>>;
  try {
    result = await applyPharmacyTender(db, scope, {
      saleId: intent.saleId,
      deviceId: input.deviceId,
      businessDate: input.businessDate,
      type: 'CARD',
      amountMinor: intent.amountMinor,
      idempotencyKey: tenderIdempotencyKeyFor(intent),
      adapter,
    });
  } catch (error) {
    // Give back only this call's own claim, so the approval can be settled later.
    await service.releaseHandoff(scope, intent.intentRef, adapter.claimToken).catch(() => {});
    throw error;
  }
  if (!('tenderId' in result))
    throw new TerminalIntentError('INVALID_INPUT', 'Settlement returned no tender.');
  // If the surrounding transaction later fails to commit, the next call finds no
  // tender under the lock and reopens the intent (reconcileWithLedger).
  await service.recordSettlement(scope, intent.intentRef, result.tenderId, adapter.claimToken);
  return { tenderId: result.tenderId, replayed: result.replayed };
}

/** Refunds settlement already recorded against a tender, by any route. */
async function ledgerRefundedMinor(db: ScopedDb, scope: TerminalScope, originalTenderId: string) {
  const refunds = await db.pharmacyRefund.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, originalTenderId },
    select: { amountMinor: true },
  });
  return refunds.reduce((sum, row) => sum + row.amountMinor, 0);
}

/**
 * Plan and dispatch a VOID/REFUND of a settled terminal sale. The refunds already in
 * the ledger (including manual cash refunds) are read here, under the sale and tender
 * locks that `refundPharmacyTender` also takes, so they cannot change mid-decision.
 * The locks are held while the terminal answers; keep `timeoutMs` short.
 */
export async function startTerminalReversal(
  db: ScopedDb,
  service: CardTerminalService,
  scope: TerminalScope,
  input: { saleIntentRef: string; amountMinor: number; attemptKey: string; batchOpen: boolean }
) {
  const sale = await service.getIntent(scope, input.saleIntentRef);
  if (sale.kind !== 'SALE' || sale.state !== 'SETTLED' || !sale.ledgerRef)
    throw new TerminalIntentError('REVERSAL_BLOCKED', 'The sale has no recorded tender.');
  await lockSale(db, scope, sale.saleId);
  await lockTender(db, scope, sale.ledgerRef);
  return service.startReversal(scope, {
    ...input,
    ledgerRefundedMinor: await ledgerRefundedMinor(db, scope, sale.ledgerRef),
  });
}

/** Record an APPROVED VOID/REFUND intent as one refund of the original tender. */
export async function settleApprovedTerminalReversal(
  db: ScopedDb,
  service: CardTerminalService,
  scope: TerminalScope,
  input: SettleInput & { reversalIntentRef: string; reason: string }
) {
  let reversal = await service.getIntent(scope, input.reversalIntentRef);
  if (reversal.kind === 'SALE' || !reversal.reversesIntentRef)
    throw new TerminalIntentError('INVALID_INPUT', 'Not a reversal intent.');
  if (!reversal.providerRef || !['APPROVED', 'SETTLED'].includes(reversal.state))
    throw new TerminalIntentError('INVALID_TRANSITION', `Intent is ${reversal.state}.`);
  const sale = await service.getIntent(scope, reversal.reversesIntentRef);
  if (sale.state !== 'SETTLED' || !sale.ledgerRef)
    throw new TerminalIntentError('REVERSAL_BLOCKED', 'The original sale has no tender.');
  await lockSale(db, scope, sale.saleId);
  await lockTender(db, scope, sale.ledgerRef);
  const found = await db.pharmacyRefund.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      originalTenderId: sale.ledgerRef,
      providerRef: reversal.providerRef,
    },
    select: { id: true },
  });
  reversal = await service.reconcileWithLedger(scope, reversal.intentRef, found);
  if (reversal.state === 'SETTLED' && reversal.ledgerRef)
    return { refundId: reversal.ledgerRef, replayed: true as const };

  const adapter = service.settlementAdapter(scope, reversal.intentRef);
  let result: Awaited<ReturnType<typeof refundPharmacyTender>>;
  try {
    result = await refundPharmacyTender(db, scope, {
      originalTenderId: sale.ledgerRef,
      deviceId: input.deviceId,
      businessDate: input.businessDate,
      amountMinor: reversal.amountMinor,
      reason: input.reason,
      idempotencyKey: refundIdempotencyKeyFor(reversal),
      adapter,
    });
  } catch (error) {
    await service.releaseHandoff(scope, reversal.intentRef, adapter.claimToken).catch(() => {});
    throw error;
  }
  if (!('refundId' in result))
    throw new TerminalIntentError('INVALID_INPUT', 'Settlement returned no refund.');
  await service.recordSettlement(scope, reversal.intentRef, result.refundId, adapter.claimToken);
  return { refundId: result.refundId, replayed: result.replayed };
}
