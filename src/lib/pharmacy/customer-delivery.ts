import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { applyPharmacyTender, refundPharmacyTender, saleTotalMinor } from './settlement';
import { changeSaleStatus, returnSaleLine } from './sales';
import { quarantinePart } from './inventory-operations';
import { releaseOrderReservations } from './customer-ordering';
import { lockStockBalances } from './stock-lock-order';

export class PharmacyDeliveryError extends Error {}

export const deliveryCommandInput = z
  .object({
    branchId: z.string().min(1).max(128),
    orderId: z.string().min(1).max(128),
    action: z.enum([
      'COLLECT',
      'REMIT',
      'VARIANCE',
      'REFUSED',
      'FAILED',
      'CASH_RETURN',
      'PHYSICAL_RETURN',
    ]),
    amountMinor: z.number().int().positive().safe().optional(),
    reference: z.string().trim().min(1).max(160),
    requestKey: z.string().min(1).max(128),
    deviceId: z.string().min(1).max(128).optional(),
    businessDate: z.date().optional(),
    quarantineLocationId: z.string().min(1).max(128).optional(),
    // DEV-647 / DEV-786: a physical return that refunds cash or returns a completed sale needs
    // the manager's or owner's own PIN.
    managerPin: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional(),
  })
  .strict();
type Evidence = { action: string; amountMinor: number | null };
type Command = Pick<
  z.infer<typeof deliveryCommandInput>,
  'action' | 'amountMinor' | 'reference' | 'requestKey'
>;
export function deliveryTotals(rows: Evidence[]) {
  const sum = (action: string) =>
    rows
      .filter((row) => row.action === action)
      .reduce((total, row) => total + (row.amountMinor ?? 0), 0);
  const collectedMinor = sum('COLLECT'),
    remittedMinor = sum('REMIT'),
    returnedMinor = sum('CASH_RETURN');
  if (![collectedMinor, remittedMinor, returnedMinor].every(Number.isSafeInteger))
    throw new PharmacyDeliveryError('INVALID_AMOUNT');
  return {
    collectedMinor,
    remittedMinor,
    returnedMinor,
    custodyMinor: collectedMinor - remittedMinor - returnedMinor,
    failed: rows.some((row) => ['REFUSED', 'FAILED'].includes(row.action)),
    physicallyReturned: rows.some((row) => row.action === 'PHYSICAL_RETURN'),
  };
}
export function validateDeliveryCommand(
  order: {
    status: string;
    fulfillment: string;
    intendedPaymentMethod: string;
    runnerUserId: string | null;
    counterSaleId: string | null;
    expectedMinor: number;
  },
  rows: Evidence[],
  input: Command,
  actorId: string
) {
  const totals = deliveryTotals(rows);
  if (
    !['READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY', 'COMPLETED'].includes(order.status) ||
    totals.physicallyReturned
  )
    throw new PharmacyDeliveryError('INVALID_STATE');
  const monetary = ['COLLECT', 'REMIT', 'CASH_RETURN'].includes(input.action);
  if (monetary && (!Number.isSafeInteger(input.amountMinor) || input.amountMinor! <= 0))
    throw new PharmacyDeliveryError('INVALID_AMOUNT');
  if (!monetary && input.amountMinor !== undefined)
    throw new PharmacyDeliveryError('INVALID_AMOUNT');
  if (
    ['COLLECT', 'REMIT', 'CASH_RETURN', 'VARIANCE'].includes(input.action) &&
    (order.fulfillment !== 'DELIVER' ||
      order.intendedPaymentMethod !== 'CASH' ||
      !order.counterSaleId)
  )
    throw new PharmacyDeliveryError('COD_SALE_REQUIRED');
  if (input.action === 'COLLECT') {
    if (actorId !== order.runnerUserId) throw new PharmacyDeliveryError('RUNNER_REQUIRED');
    if (totals.failed || order.status !== 'OUT_FOR_DELIVERY')
      throw new PharmacyDeliveryError('INVALID_STATE');
    if (totals.collectedMinor + input.amountMinor! > order.expectedMinor)
      throw new PharmacyDeliveryError('INVALID_AMOUNT');
  }
  if (input.action === 'REMIT') {
    if (actorId === order.runnerUserId)
      throw new PharmacyDeliveryError('INDEPENDENT_RECEIVER_REQUIRED');
    if (
      input.amountMinor! > totals.custodyMinor ||
      totals.remittedMinor + input.amountMinor! > order.expectedMinor
    )
      throw new PharmacyDeliveryError('INVALID_AMOUNT');
  }
  if (input.action === 'CASH_RETURN') {
    if (actorId !== order.runnerUserId) throw new PharmacyDeliveryError('RUNNER_REQUIRED');
    if (!totals.failed || input.amountMinor! > totals.custodyMinor)
      throw new PharmacyDeliveryError('INVALID_AMOUNT');
  }
  if (
    ['REFUSED', 'FAILED'].includes(input.action) &&
    (totals.failed || order.status === 'COMPLETED')
  )
    throw new PharmacyDeliveryError('INVALID_STATE');
  if (input.action === 'PHYSICAL_RETURN') {
    if (!totals.failed) throw new PharmacyDeliveryError('REFUSAL_REQUIRED');
    if (totals.custodyMinor !== 0) throw new PharmacyDeliveryError('CASH_RECONCILIATION_REQUIRED');
    if (actorId === order.runnerUserId)
      throw new PharmacyDeliveryError('INDEPENDENT_RECEIVER_REQUIRED');
  }
  return totals;
}

// Caller supplies an authenticated tenant transaction. Every command serializes on the order.
export async function recordDeliveryCommand(
  db: ScopedDb,
  scope: LedgerScope,
  input: z.infer<typeof deliveryCommandInput>,
  /**
   * DEV-647 / DEV-786: refunds and returns of a completed sale need a manager or owner.
   * Without an authorizer, neither runs.
   */
  options: { authorizeRefund?: () => Promise<void> } = {}
) {
  deliveryCommandInput.parse(input);
  if (input.branchId !== scope.branchId) throw new PharmacyDeliveryError('ORDER_NOT_FOUND');
  const [restriction] = await db.$queryRaw<{ branchId: string | null }[]>(
    Prisma.sql`SELECT nullif(current_setting('app.current_branch_id', true), '') AS "branchId"`
  );
  if (restriction?.branchId && restriction.branchId !== scope.branchId)
    throw new PharmacyDeliveryError('ORDER_NOT_FOUND');
  await db.$queryRaw(
    Prisma.sql`SELECT set_config('app.current_branch_id', ${scope.branchId}, true)`
  );
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_customer_orders WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${input.orderId} FOR UPDATE`
  );
  const order = await db.pharmacyCustomerOrder.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: input.orderId },
    include: {
      deliveryEvidence: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
      counterSale: {
        include: {
          lines: { include: { allocations: true, returnLines: true } },
          tenders: { include: { refunds: true } },
        },
      },
    },
  });
  if (!order) throw new PharmacyDeliveryError('ORDER_NOT_FOUND');
  const fingerprint = createHash('sha256')
    // The PIN is a credential, not part of the command: replays need not repeat it.
    .update(JSON.stringify({ ...input, managerPin: undefined, actorId: scope.actorId }))
    .digest('hex');
  const prior = order.deliveryEvidence.find((row) => row.requestKey === input.requestKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new PharmacyDeliveryError('IDEMPOTENCY_CONFLICT');
    return { evidence: prior, totals: deliveryTotals(order.deliveryEvidence), replayed: true };
  }
  const totals = validateDeliveryCommand(
    { ...order, expectedMinor: order.counterSale ? saleTotalMinor(order.counterSale.lines) : 0 },
    order.deliveryEvidence,
    input,
    scope.actorId
  );
  if (input.action === 'REMIT') {
    if (!input.deviceId || !input.businessDate) throw new PharmacyDeliveryError('DRAWER_REQUIRED');
    await applyPharmacyTender(db, scope, {
      saleId: order.counterSaleId!,
      deviceId: input.deviceId,
      businessDate: input.businessDate,
      type: 'CASH',
      amountMinor: input.amountMinor!,
      cashReceivedMinor: input.amountMinor!,
      idempotencyKey: `cod:${order.id}:${input.requestKey}`,
    });
  }
  if (input.action === 'PHYSICAL_RETURN') {
    if (order.counterSaleId) {
      await db.$queryRaw(
        Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${order.counterSaleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
      );
      const sale = await db.pharmacySale.findFirst({
        where: {
          id: order.counterSaleId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
        include: {
          lines: { include: { allocations: true, returnLines: true } },
          tenders: { include: { refunds: true } },
        },
      });
      if (!sale) throw new PharmacyDeliveryError('ORDER_NOT_FOUND');
      // Returning custody is not permission to erase tender history. Refund actual cash first.
      if (sale.status === 'OPEN' && sale.tenders.length) {
        if (sale.tenders.some((tender) => tender.type !== 'CASH'))
          throw new PharmacyDeliveryError('PAYMENT_RECONCILIATION_REQUIRED');
        if (!input.deviceId || !input.businessDate)
          throw new PharmacyDeliveryError('DRAWER_REQUIRED');
        const refundDue = sale.tenders.some(
          (tender) =>
            tender.amountMinor > tender.refunds.reduce((n, refund) => n + refund.amountMinor, 0)
        );
        if (refundDue) {
          if (!options.authorizeRefund)
            throw new PharmacyDeliveryError('REFUND_AUTHORIZATION_REQUIRED');
          await options.authorizeRefund();
        }
        for (const tender of sale.tenders) {
          const remaining =
            tender.amountMinor - tender.refunds.reduce((n, refund) => n + refund.amountMinor, 0);
          if (remaining > 0)
            await refundPharmacyTender(db, scope, {
              originalTenderId: tender.id,
              deviceId: input.deviceId,
              businessDate: input.businessDate,
              amountMinor: remaining,
              reason: `Physical failed-delivery return: ${input.reference}`,
              idempotencyKey: `delivery-cancel:${order.id}:${tender.id}`,
            });
        }
      }
      if (sale.status === 'COMPLETED') {
        if (!input.quarantineLocationId) throw new PharmacyDeliveryError('QUARANTINE_REQUIRED');
        const unreturned = sale.lines.map((line) => ({
          line,
          units:
            line.canonicalUnits - line.returnLines.reduce((n, row) => n + row.canonicalUnits, 0),
        }));
        // DEV-786: returning a completed sale reverses it like a refund, so it needs the same
        // manager-or-owner PIN before any stock or refund liability moves.
        if (unreturned.some(({ units }) => units)) {
          if (!options.authorizeRefund)
            throw new PharmacyDeliveryError('REFUND_AUTHORIZATION_REQUIRED');
          await options.authorizeRefund();
        }
        for (const { line, units } of unreturned) {
          if (units)
            await returnSaleLine(db, scope, {
              saleLineId: line.id,
              canonicalUnits: units,
              quarantineLocationId: input.quarantineLocationId,
              disposition: 'QUARANTINE',
              reason: 'Failed delivery physically returned',
              integrityDecision: input.reference,
              idempotencyKey: `delivery-return:${order.id}:${line.id}`,
            });
        }
      } else if (sale.status === 'OPEN') {
        const movements = new Map<string, { stockLocationId: string }>();
        for (const line of sale.lines)
          for (const allocation of line.allocations) {
            const movement = await db.pharmacyStockMovement.findFirst({
              where: {
                id: allocation.stockMovementId,
                organizationId: scope.organizationId,
                branchId: scope.branchId,
              },
            });
            if (!movement) throw new PharmacyDeliveryError('RESERVATION_UNAVAILABLE');
            movements.set(allocation.id, movement);
          }
        // DEV-825: the void puts the units back AVAILABLE and the quarantine moves
        // them on, so lock every balance both touch first, in the global key order.
        await lockStockBalances(
          db,
          scope,
          sale.lines.flatMap((line) =>
            line.allocations.flatMap((allocation) =>
              (['AVAILABLE', 'QUARANTINE'] as const).map((disposition) => ({
                inventoryLotId: allocation.inventoryLotId,
                stockLocationId: movements.get(allocation.id)!.stockLocationId,
                disposition,
              }))
            )
          )
        );
        await changeSaleStatus(
          db,
          scope,
          sale.id,
          'void',
          { kind: 'FAILED_DELIVERY_RETURN' },
          'Failed delivery physically returned'
        );
        for (const line of sale.lines)
          for (const allocation of line.allocations) {
            const movement = movements.get(allocation.id)!;
            await quarantinePart(db, scope, {
              inventoryLotId: allocation.inventoryLotId,
              stockLocationId: movement.stockLocationId,
              units: allocation.canonicalUnits,
              reason: 'Physical delivery return pending inspection',
              idempotencyKeyPrefix: `delivery-quarantine:${order.id}:${allocation.id}`,
            });
          }
      } else throw new PharmacyDeliveryError('INVALID_STATE');
    } else {
      const reservations = await db.pharmacyRestockReservation.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          status: 'RESERVED',
          interest: { orderLine: { orderId: order.id } },
        },
        orderBy: [{ inventoryLotId: 'asc' }, { stockLocationId: 'asc' }, { id: 'asc' }],
      });
      if (!reservations.length) throw new PharmacyDeliveryError('RESERVATION_UNAVAILABLE');
      // DEV-825: every balance the quarantine moves touch, locked once in key order.
      await lockStockBalances(
        db,
        scope,
        reservations.flatMap((reservation) =>
          (['AVAILABLE', 'QUARANTINE'] as const).map((disposition) => ({
            inventoryLotId: reservation.inventoryLotId,
            stockLocationId: reservation.stockLocationId,
            disposition,
          }))
        )
      );
      await releaseOrderReservations(db, scope, order.id);
      for (const reservation of reservations)
        await quarantinePart(db, scope, {
          inventoryLotId: reservation.inventoryLotId,
          stockLocationId: reservation.stockLocationId,
          units: reservation.reservedUnits,
          reason: 'Physical delivery return pending inspection',
          idempotencyKeyPrefix: `delivery-quarantine:${order.id}:${reservation.id}`,
        });
    }
  }
  const evidence = await db.pharmacyOrderDeliveryEvidence.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      orderId: order.id,
      actorUserId: scope.actorId,
      action: input.action,
      amountMinor: input.action === 'VARIANCE' ? totals.custodyMinor : input.amountMinor,
      reference: input.reference,
      requestKey: input.requestKey,
      fingerprint,
    },
  });
  if (input.action === 'PHYSICAL_RETURN')
    await db.pharmacyCustomerOrder.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: order.id } },
      data: { status: 'RETURNED' },
    });
  return {
    evidence,
    totals: deliveryTotals([...order.deliveryEvidence, evidence]),
    replayed: false,
  };
}
