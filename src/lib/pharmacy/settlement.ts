import { requestCounterEvidence } from './counter-evidence';
import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { reverseRefundedEarnedPoints } from './customer-loyalty-earned-reversal';
import { accrueSalePoints, restoreRefundedLoyaltyPoints } from './customer-loyalty';
import { returnedLineValue } from './sales';
import { postTenderEntry, postTenderRefundEntry } from './finance-postings';
import { firstCloseIsFinal } from './migration/first-close';
import { assertSaleBatchesSellable } from './sale-batch-safety';
import { completePaidPharmacySale, completionSaleInclude } from './sale-completion';
import { assertRxSaleAllowed } from './rx-sale-gate';
import { assertChronicRefillReviewCurrent } from './chronic-refill-review';
import type { LedgerScope } from './stock-ledger';
import { paymentSandboxAdmitted } from './payment-sandbox-admission';
import { authenticatePharmacyCommand, validateLeasedReceiptReplay } from './sales';
import type { PharmacyCommandAuthentication, PharmacyLeasedReceipt } from './sales';

export type PharmacyTenderType = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET' | 'CREDIT';

export class PharmacySettlementError extends Error {
  constructor(
    readonly reason:
      | 'DAY_CLOSED'
      | 'INVALID_RECEIPT_LEASE'
      | 'LEASE_REQUIRES_SETTLEMENT'
      | 'SALE_NOT_OPEN'
      | 'INVALID_AMOUNT'
      | 'OVER_TENDER'
      | 'DRAWER_NOT_OPEN'
      | 'REFUND_EXCEEDS_TENDER'
      | 'IDEMPOTENCY_CONFLICT'
      | 'UNCERTIFIED_PROVIDER'
      | 'MOCK_PROVIDER_IN_RELEASE'
      | 'OPEN_DRAWER'
      | 'REOPEN_REASON_REQUIRED'
  ) {
    super(reason);
  }
}

export interface PharmacyPaymentAdapter {
  readonly name: string;
  readonly certified: boolean;
  readonly localSandbox?: true;
  execute(input: {
    capability: 'SALE' | 'REFUND';
    amountMinor: number;
    operationRef: string;
    priorRef?: string;
  }): Promise<{ approved: boolean; providerRef: string }>;
}

export function requireReleaseSafeAdapter(
  adapter: PharmacyPaymentAdapter,
  environment = process.env.NODE_ENV
) {
  if (adapter.localSandbox) {
    if (adapter.name !== 'LOCAL_TOKEN_SANDBOX' || !paymentSandboxAdmitted())
      throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    return adapter;
  }
  if (environment === 'production' && adapter.name.toUpperCase() === 'MOCK')
    throw new PharmacySettlementError('MOCK_PROVIDER_IN_RELEASE');
  if (!adapter.certified) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
  return adapter;
}

export function saleTotalMinor(
  lines: readonly { quantity: number; unitPriceMinor: number; discountMinor: number }[]
) {
  return lines.reduce(
    (total, line) => total + line.quantity * line.unitPriceMinor - line.discountMinor,
    0
  );
}

export function assertPositiveMinor(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const tenderResultSchema = z
  .object({
    tenderId: z.string().min(1),
    settled: z.boolean(),
    receiptNumber: z.number().int().positive().nullable(),
    remainingMinor: z.number().int().nonnegative(),
  })
  .strict()
  .refine((result) =>
    result.settled
      ? result.receiptNumber !== null && result.remainingMinor === 0
      : result.receiptNumber === null && result.remainingMinor > 0
  );

export type PharmacyTenderOutcome =
  | { status: 'ACCEPTED'; replayUnsafe: true; result: z.infer<typeof tenderResultSchema> }
  | { status: 'NOT_FOUND' | 'UNKNOWN'; replayUnsafe: true };

/** Reads evidence of this exact attempt; absence never authorizes another tender. */
export async function readPharmacyTenderOutcome(
  db: ScopedDb,
  scope: LedgerScope,
  input: Omit<Parameters<typeof applyPharmacyTender>[2], 'adapter'>
): Promise<PharmacyTenderOutcome> {
  const unknown = { status: 'UNKNOWN', replayUnsafe: true } as const;
  try {
    // Check sale access before even looking up a device/key, including completed sales.
    const sale = await db.pharmacySale.findFirst({
      where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
      select: { id: true, organizationId: true, branchId: true },
    });
    if (
      !sale ||
      sale.id !== input.saleId ||
      sale.organizationId !== scope.organizationId ||
      sale.branchId !== scope.branchId
    )
      return unknown;

    const prior = await db.pharmacyMoneyIdempotencyKey.findUnique({
      where: {
        organizationId_deviceId_key: {
          organizationId: scope.organizationId,
          deviceId: input.deviceId,
          key: input.idempotencyKey,
        },
      },
      select: {
        organizationId: true,
        deviceId: true,
        key: true,
        commandType: true,
        payloadHash: true,
        resultPayload: true,
      },
    });
    // Rolled-back and in-flight attempts can both be invisible here.
    if (!prior) return { status: 'NOT_FOUND', replayUnsafe: true };
    if (
      prior.organizationId !== scope.organizationId ||
      prior.deviceId !== input.deviceId ||
      prior.key !== input.idempotencyKey ||
      prior.commandType !== 'tender' ||
      prior.payloadHash !== hash(input)
    )
      return unknown;

    const parsed = tenderResultSchema.safeParse(prior.resultPayload);
    if (!parsed.success) return unknown;
    const result = parsed.data;
    const tender = await db.pharmacyTender.findFirst({
      where: {
        id: result.tenderId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleId: input.saleId,
      },
      select: {
        id: true,
        organizationId: true,
        branchId: true,
        saleId: true,
        deviceId: true,
        type: true,
        amountMinor: true,
        businessDate: true,
        cashReceivedMinor: true,
        changeGivenMinor: true,
      },
    });
    const cashReceivedMinor =
      input.type === 'CASH' ? (input.cashReceivedMinor ?? input.amountMinor) : null;
    if (
      !tender ||
      tender.id !== result.tenderId ||
      tender.organizationId !== scope.organizationId ||
      tender.branchId !== scope.branchId ||
      tender.saleId !== input.saleId ||
      tender.deviceId !== input.deviceId ||
      tender.type !== input.type ||
      tender.amountMinor !== input.amountMinor ||
      // businessDate is @db.Date; the hash above still binds the original timestamp.
      tender.businessDate.toISOString().slice(0, 10) !==
        input.businessDate.toISOString().slice(0, 10) ||
      tender.cashReceivedMinor !== cashReceivedMinor ||
      tender.changeGivenMinor !==
        (cashReceivedMinor === null ? null : cashReceivedMinor - input.amountMinor)
    )
      return unknown;

    return { status: 'ACCEPTED', replayUnsafe: true, result };
  } catch {
    // This path only reads. A failed read is uncertainty, never proof of rejection.
    return unknown;
  }
}

async function bindIdempotency(
  db: ScopedDb,
  organizationId: string,
  deviceId: string,
  key: string,
  commandType: string,
  payloadHash: string
) {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO pharmacy_money_idempotency_keys
      (id, "organizationId", "deviceId", key, "commandType", "payloadHash", "createdAt")
    VALUES (${randomUUID()}, ${organizationId}, ${deviceId}, ${key}, ${commandType}, ${payloadHash}, now())
    ON CONFLICT ("organizationId", "deviceId", key) DO NOTHING`);
  const prior = await db.pharmacyMoneyIdempotencyKey.findUnique({
    where: { organizationId_deviceId_key: { organizationId, deviceId, key } },
  });
  if (!prior || prior.commandType !== commandType || prior.payloadHash !== payloadHash)
    throw new PharmacySettlementError('IDEMPOTENCY_CONFLICT');
  return prior;
}

/** Shared transaction lock: closing cannot race a new tender or drawer write. */
export async function lockPharmacyDay(db: ScopedDb, scope: LedgerScope, date: Date) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`${scope.organizationId}:${scope.branchId}:${date.toISOString().slice(0, 10)}`}))`
  );
}

export async function requirePharmacyDayOpen(db: ScopedDb, scope: LedgerScope, date: Date) {
  await lockPharmacyDay(db, scope, date);
  const close = await db.pharmacyDailyClose.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, businessDate: date },
    select: { id: true },
  });
  if (close) throw new PharmacySettlementError('DAY_CLOSED');
}

async function lockDrawerDay(db: ScopedDb, scope: LedgerScope, drawerSessionId: string) {
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: { id: drawerSessionId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { businessDate: true },
  });
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  await requirePharmacyDayOpen(db, scope, drawer.businessDate);
}

export async function applyPharmacyTender(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    saleId: string;
    deviceId: string;
    businessDate: Date;
    type: PharmacyTenderType;
    amountMinor: number;
    cashReceivedMinor?: number;
    idempotencyKey: string;
    adapter?: PharmacyPaymentAdapter;
    leasedReceipt?: PharmacyLeasedReceipt;
  },
  authentication?: PharmacyCommandAuthentication
) {
  assertPositiveMinor(input.amountMinor);
  if (input.leasedReceipt) {
    await authenticatePharmacyCommand(
      db,
      scope,
      input.deviceId,
      input.leasedReceipt,
      authentication
    );
    validateLeasedReceiptReplay(scope, input.deviceId, input.leasedReceipt);
  }
  const payloadHash = hash(input);
  const idem = await bindIdempotency(
    db,
    scope.organizationId,
    input.deviceId,
    input.idempotencyKey,
    'tender',
    payloadHash
  );
  if (idem.resultPayload) return { ...(idem.resultPayload as object), replayed: true };
  await requirePharmacyDayOpen(db, scope, input.businessDate);

  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id = ${input.saleId} AND "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} FOR UPDATE`
  );
  const sale = await db.pharmacySale.findFirst({
    where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: completionSaleInclude,
  });
  if (!sale || sale.status !== 'OPEN') throw new PharmacySettlementError('SALE_NOT_OPEN');
  // #518: a line added earlier cannot be paid for by someone who may not sell it.
  await assertRxSaleAllowed(
    db,
    scope,
    sale.lines.map((line) => line.medicine)
  );
  // #633: before any lease, provider charge, tender or posting. A batch recalled,
  // quarantined or expired since add-to-cart refuses the payment.
  await assertSaleBatchesSellable(db, scope, sale.id);
  // Reject a revoked refill before charging a provider or recording any tender.
  if (sale.customerOrder)
    await assertChronicRefillReviewCurrent(db, scope, sale.customerOrder.id);
  const totalMinor = saleTotalMinor(sale.lines);
  const tenderedMinor = sale.tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
  if (input.amountMinor > totalMinor - tenderedMinor)
    throw new PharmacySettlementError('OVER_TENDER');

  const settled = tenderedMinor + input.amountMinor === totalMinor;
  if (input.leasedReceipt && !settled)
    throw new PharmacySettlementError('LEASE_REQUIRES_SETTLEMENT');

  // Same owning transaction as the sale/tender/event. UPDATE locks and rechecks
  // the cursor, so a second command cannot consume the same number. Reserved
  // numbers never return to the online sequence, including on rejection.
  let receiptNumber: number | null = null;
  if (input.leasedReceipt) {
    const { leaseId, receiptNumber: leasedNumber } = input.leasedReceipt;
    const consumed = await db.$queryRaw<Array<{ receipt_number: number }>>(Prisma.sql`
      UPDATE pharmacy_receipt_number_leases AS lease
      SET "nextNumber" = ${leasedNumber} + 1
      WHERE lease.id = ${leaseId}
        AND lease."organizationId" = ${scope.organizationId}
        AND lease."branchId" = ${scope.branchId}
        AND lease."deviceId" = ${input.deviceId}
        AND lease."nextNumber" = ${leasedNumber}
        AND ${leasedNumber} BETWEEN lease."blockStart" AND lease."blockEnd"
        AND lease."issuedAt" <= ${new Date(input.leasedReceipt.originalSaleAt)}
        AND EXISTS (
          SELECT 1 FROM pharmacy_registered_devices AS device
          WHERE device.id = lease."deviceId"
            AND device."organizationId" = lease."organizationId"
            AND device."branchId" = lease."branchId"
            AND device.status = 'ACTIVE' AND device."revokedAt" IS NULL
        )
      RETURNING lease."nextNumber" - 1 AS receipt_number`);
    if (!consumed[0]) throw new PharmacySettlementError('INVALID_RECEIPT_LEASE');
    receiptNumber = consumed[0].receipt_number;
  }

  let drawerSessionId: string | undefined;
  let cashReceivedMinor: number | undefined;
  let changeGivenMinor: number | undefined;
  let provider: string | undefined;
  let providerRef: string | undefined;
  if (input.type === 'CASH') {
    cashReceivedMinor = input.cashReceivedMinor ?? input.amountMinor;
    if (!Number.isSafeInteger(cashReceivedMinor) || cashReceivedMinor < input.amountMinor)
      throw new PharmacySettlementError('INVALID_AMOUNT');
    changeGivenMinor = cashReceivedMinor - input.amountMinor;
    const drawer = await db.pharmacyDrawerSession.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId,
        businessDate: input.businessDate,
        status: 'OPEN',
      },
    });
    if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
    drawerSessionId = drawer.id;
  } else if (input.type === 'CARD' || input.type === 'WALLET') {
    if (!input.adapter) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    const adapter = requireReleaseSafeAdapter(input.adapter);
    const result = await adapter.execute({
      capability: 'SALE',
      amountMinor: input.amountMinor,
      operationRef: input.idempotencyKey,
    });
    if (!result.approved) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    provider = adapter.name;
    providerRef = result.providerRef;
  }

  const tender = await db.pharmacyTender.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: sale.id,
      type: input.type,
      amountMinor: input.amountMinor,
      cashReceivedMinor,
      changeGivenMinor,
      drawerSessionId,
      provider,
      providerRef,
      businessDate: input.businessDate,
      actorId: scope.actorId,
      deviceId: input.deviceId,
    },
  });
  await postTenderEntry(db, scope, { tenderId: tender.id, at: tender.createdAt });
  if (drawerSessionId)
    await db.pharmacyDrawerMovement.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId,
        kind: 'CASH_SALE',
        amountMinor: input.amountMinor,
        actorId: scope.actorId,
      },
    });

  if (settled) {
    // F2: a leased offline receipt number was consumed above in this transaction; online
    // sales (receiptNumber still null) draw the next number from the device sequence.
    receiptNumber = await completePaidPharmacySale(db, scope, sale, input, receiptNumber);
    if (sale.customerId) await accrueSalePoints(db, scope, sale.id);
  }
  await requestCounterEvidence(db, scope, { kind: 'TENDER', subjectId: tender.id });
  const result = {
    tenderId: tender.id,
    settled,
    receiptNumber,
    remainingMinor: totalMinor - tenderedMinor - input.amountMinor,
  };
  await db.pharmacyMoneyIdempotencyKey.update({
    where: { id: idem.id },
    data: { resultPayload: result },
  });
  return { ...result, replayed: false };
}

export function assertRefundWithinTender(
  tenderedMinor: number,
  refundedMinor: number,
  requestedMinor: number
) {
  assertPositiveMinor(requestedMinor);
  if (refundedMinor + requestedMinor > tenderedMinor)
    throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
}

export async function refundPharmacyTender(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    originalTenderId: string;
    deviceId: string;
    businessDate: Date;
    amountMinor: number;
    reason: string;
    idempotencyKey: string;
    adapter?: PharmacyPaymentAdapter;
    manualCashFallback?: boolean;
    /** Settled sales are always capped; true also caps refunds on a sale that is not settled. */
    requireReturnedValue?: boolean;
  }
) {
  if (!input.reason.trim()) throw new PharmacySettlementError('INVALID_AMOUNT');
  const payloadHash = hash(input);
  const idem = await bindIdempotency(
    db,
    scope.organizationId,
    input.deviceId,
    input.idempotencyKey,
    'refund',
    payloadHash
  );
  if (idem.resultPayload) return { ...(idem.resultPayload as object), replayed: true };
  await requirePharmacyDayOpen(db, scope, input.businessDate);
  // Same sale-before-customer protocol as redemption; serialize refunds across tenders.
  await db.$queryRaw(Prisma.sql`SELECT s.id FROM pharmacy_sales s
    JOIN pharmacy_tenders t ON t."saleId"=s.id AND t."organizationId"=s."organizationId"
    WHERE t.id=${input.originalTenderId} AND s."organizationId"=${scope.organizationId}
      AND s."branchId"=${scope.branchId} FOR UPDATE OF s`);
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_tenders WHERE id=${input.originalTenderId} AND "organizationId"=${scope.organizationId} FOR UPDATE`
  );
  const tender = await db.pharmacyTender.findFirst({
    where: {
      id: input.originalTenderId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    include: { refunds: true, sale: { select: { customerId: true } } },
  });
  if (!tender) throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
  assertRefundWithinTender(
    tender.amountMinor,
    tender.refunds.reduce((sum, row) => sum + row.amountMinor, 0),
    input.amountMinor
  );
  // Returned-value cap (F13 c62a34f3 + bbb71a5d, reconciled with the tip's failed-delivery flow):
  // serialize refunds across all tenders of this sale, then cap every refund on a settled
  // (COMPLETED) sale at the value of goods actually returned, including unidentified return holds,
  // whatever the caller sends. A refund on a sale that is not settled (the tip cancels an OPEN
  // failed-delivery sale and returns its cash) has no returned goods to value; it stays limited by
  // the tender alone unless the caller explicitly asks for the cap with requireReturnedValue.
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${tender.saleId}
    AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`);
  const sale = await db.pharmacySale.findFirst({
    where: {
      id: tender.saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'COMPLETED',
    },
    include: {
      lines: { include: { returnLines: true, unidentifiedReturnHolds: true } },
      refunds: true,
    },
  });
  const unsettledExempt =
    !sale &&
    !input.requireReturnedValue &&
    (await db.pharmacySale.count({
      where: {
        id: tender.saleId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: { not: 'COMPLETED' },
      },
    })) > 0;
  if (!unsettledExempt) {
    const returnValue =
      sale?.lines.reduce(
        (sum, line) =>
          sum +
          returnedLineValue(
            line,
            line.returnLines.reduce((n, row) => n + row.canonicalUnits, 0) +
              line.unidentifiedReturnHolds.reduce((n, row) => n + row.canonicalUnits, 0)
          ),
        0
      ) ?? 0;
    if (
      !sale ||
      sale.refunds.reduce((sum, row) => sum + row.amountMinor, 0) + input.amountMinor > returnValue
    )
      throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
  }
  const manualReversalRequired =
    (tender.type === 'CARD' || tender.type === 'WALLET') &&
    !input.adapter &&
    input.manualCashFallback === true;
  const refundReason = manualReversalRequired
    ? `[CASH; MANUAL REVERSAL REQUIRED] ${input.reason.trim()}`
    : input.reason.trim();
  let providerRef: string | undefined;
  let drawerSessionId: string | undefined;
  if ((tender.type === 'CARD' || tender.type === 'WALLET') && !manualReversalRequired) {
    if (!input.adapter || !tender.providerRef)
      throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    const adapter = requireReleaseSafeAdapter(input.adapter);
    const result = await adapter.execute({
      capability: 'REFUND',
      amountMinor: input.amountMinor,
      operationRef: input.idempotencyKey,
      priorRef: tender.providerRef,
    });
    if (!result.approved) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    providerRef = result.providerRef;
  } else if (tender.type === 'CASH' || manualReversalRequired) {
    const drawer = await db.pharmacyDrawerSession.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId,
        businessDate: input.businessDate,
        status: 'OPEN',
      },
    });
    if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
    drawerSessionId = drawer.id;
  }
  const refund = await db.pharmacyRefund.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: tender.saleId,
      originalTenderId: tender.id,
      amountMinor: input.amountMinor,
      providerRef,
      drawerSessionId,
      businessDate: input.businessDate,
      reason: refundReason,
      actorId: scope.actorId,
    },
  });
  await postTenderRefundEntry(db, scope, { refundId: refund.id, at: refund.createdAt });
  if (tender.type === 'LOYALTY' && tender.sale.customerId) {
    await restoreRefundedLoyaltyPoints(db, scope, {
      refundId: refund.id,
      tenderId: tender.id,
      saleId: tender.saleId,
      customerId: tender.sale.customerId,
    });
  }
  if (tender.type !== 'LOYALTY' && tender.sale.customerId)
    await reverseRefundedEarnedPoints(db, scope, refund.id);
  if (drawerSessionId)
    await db.pharmacyDrawerMovement.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId,
        kind: 'CASH_REFUND',
        amountMinor: input.amountMinor,
        reason: refundReason,
        actorId: scope.actorId,
      },
    });
  await requestCounterEvidence(db, scope, { kind: 'REFUND', subjectId: refund.id });
  const result = {
    refundId: refund.id,
    manualReversalRequired,
    originalTenderId: tender.id,
    amountMinor: refund.amountMinor,
  };
  await db.pharmacyMoneyIdempotencyKey.update({
    where: { id: idem.id },
    data: { resultPayload: result },
  });
  return { ...result, replayed: false };
}

export type CloseSource = {
  sales: readonly { id: string; totalMinor: number }[];
  refunds: readonly { id: string; amountMinor: number }[];
  drawers: readonly { id: string; expectedMinor: number; countedMinor: number }[];
};

export function computePharmacyClose(source: CloseSource) {
  const ordered = {
    sales: [...source.sales].sort((a, b) => a.id.localeCompare(b.id)),
    refunds: [...source.refunds].sort((a, b) => a.id.localeCompare(b.id)),
    drawers: [...source.drawers].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const grossSalesMinor = ordered.sales.reduce((sum, row) => sum + row.totalMinor, 0);
  const refundTotalMinor = ordered.refunds.reduce((sum, row) => sum + row.amountMinor, 0);
  const cashExpectedMinor = ordered.drawers.reduce((sum, row) => sum + row.expectedMinor, 0);
  const cashCountedMinor = ordered.drawers.reduce((sum, row) => sum + row.countedMinor, 0);
  return {
    grossSalesMinor,
    refundTotalMinor,
    netSalesMinor: grossSalesMinor - refundTotalMinor,
    cashExpectedMinor,
    cashCountedMinor,
    cashVarianceMinor: cashCountedMinor - cashExpectedMinor,
    sourceHash: hash(ordered),
  };
}

export type DrawerMovement = {
  kind: 'OPENING_FLOAT' | 'CASH_SALE' | 'CASH_REFUND' | 'PAID_IN' | 'PAID_OUT';
  amountMinor: number;
};

export function foldExpectedCash(movements: readonly DrawerMovement[]) {
  return movements.reduce((total, movement) => {
    assertPositiveMinor(movement.amountMinor);
    return movement.kind === 'CASH_REFUND' || movement.kind === 'PAID_OUT'
      ? total - movement.amountMinor
      : total + movement.amountMinor;
  }, 0);
}

export async function openPharmacyDrawer(
  db: ScopedDb,
  scope: LedgerScope,
  input: { deviceId: string; businessDate: Date; openingFloatMinor: number }
) {
  if (!Number.isSafeInteger(input.openingFloatMinor) || input.openingFloatMinor < 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
  await requirePharmacyDayOpen(db, scope, input.businessDate);
  // One OPEN drawer per counter device (the partial unique index
  // `pharmacy_one_open_drawer_per_device`). The pre-check answers the ordinary
  // second click with the typed reason; the P2002 translation below is the
  // backstop for two opens racing past it, so neither surfaces as a 500.
  const alreadyOpen = await db.pharmacyDrawerSession.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId: input.deviceId,
      status: 'OPEN',
    },
    select: { id: true },
  });
  if (alreadyOpen) throw new PharmacySettlementError('OPEN_DRAWER');
  let drawer;
  try {
    drawer = await db.pharmacyDrawerSession.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId,
        businessDate: input.businessDate,
        openingFloatMinor: input.openingFloatMinor,
        openedByActorId: scope.actorId,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new PharmacySettlementError('OPEN_DRAWER');
    throw error;
  }
  if (input.openingFloatMinor > 0)
    await db.pharmacyDrawerMovement.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId: drawer.id,
        kind: 'OPENING_FLOAT',
        amountMinor: input.openingFloatMinor,
        actorId: scope.actorId,
      },
    });
  return drawer;
}

/** The OPEN drawer for a counter device, if any: what the counter offers instead of "Open drawer". */
export async function readOpenPharmacyDrawer(db: ScopedDb, scope: LedgerScope, deviceId: string) {
  return db.pharmacyDrawerSession.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId,
      status: 'OPEN',
    },
    select: { id: true, businessDate: true, openedAt: true, openingFloatMinor: true },
    orderBy: { openedAt: 'desc' },
  });
}

export async function recordPharmacyCashMovement(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    drawerSessionId: string;
    kind: 'PAID_IN' | 'PAID_OUT';
    amountMinor: number;
    reason: string;
  }
) {
  assertPositiveMinor(input.amountMinor);
  if (!input.reason.trim()) throw new PharmacySettlementError('INVALID_AMOUNT');
  await lockDrawerDay(db, scope, input.drawerSessionId);
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: {
      id: input.drawerSessionId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
  });
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  return db.pharmacyDrawerMovement.create({
    data: {
      organizationId: scope.organizationId,
      drawerSessionId: drawer.id,
      kind: input.kind,
      amountMinor: input.amountMinor,
      reason: input.reason.trim(),
      actorId: scope.actorId,
    },
  });
}

export async function closePharmacyDrawer(
  db: ScopedDb,
  scope: LedgerScope,
  input: { drawerSessionId: string; countedCashMinor: number; controlledCountHook?: unknown }
) {
  if (!Number.isSafeInteger(input.countedCashMinor) || input.countedCashMinor < 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
  await lockDrawerDay(db, scope, input.drawerSessionId);
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: {
      id: input.drawerSessionId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
    include: { movements: true },
  });
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  const expectedCashMinor = foldExpectedCash(drawer.movements as DrawerMovement[]);
  await db.pharmacyDrawerMovement.create({
    data: {
      organizationId: scope.organizationId,
      drawerSessionId: drawer.id,
      kind: 'CLOSING_COUNT',
      amountMinor: input.countedCashMinor,
      actorId: scope.actorId,
    },
  });
  const closed = await db.pharmacyDrawerSession.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: drawer.id } },
    data: {
      status: 'CLOSED',
      countedCashMinor: input.countedCashMinor,
      controlledCountHook: input.controlledCountHook as Prisma.InputJsonValue | undefined,
      closedByActorId: scope.actorId,
      closedAt: new Date(),
    },
  });
  return {
    drawer: closed,
    expectedCashMinor,
    varianceMinor: input.countedCashMinor - expectedCashMinor,
  };
}

export async function cutPharmacyDailyClose(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    businessDate: Date;
    reopenReason?: string;
    /** The operator's explanation of a counted variance; never stands in for a reopen reason. */
    varianceNote?: string;
    controlledCountHook?: unknown;
  }
) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`${scope.organizationId}:${scope.branchId}:${input.businessDate.toISOString().slice(0, 10)}`}))`
  );
  const openDrawers = await db.pharmacyDrawerSession.count({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
      status: 'OPEN',
    },
  });
  if (openDrawers > 0) throw new PharmacySettlementError('OPEN_DRAWER');
  const prior = await db.pharmacyDailyClose.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
    },
    orderBy: { sequence: 'desc' },
  });
  if (prior && !input.reopenReason?.trim())
    throw new PharmacySettlementError('REOPEN_REASON_REQUIRED');
  const [sales, refunds, drawers] = await Promise.all([
    db.pharmacySale.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: input.businessDate,
        status: 'COMPLETED',
      },
      include: { lines: true },
    }),
    db.pharmacyRefund.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: input.businessDate,
      },
    }),
    db.pharmacyDrawerSession.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: input.businessDate,
      },
      include: { movements: true },
    }),
  ]);
  const aggregate = computePharmacyClose({
    sales: sales.map((sale) => ({ id: sale.id, totalMinor: saleTotalMinor(sale.lines) })),
    refunds: refunds.map((refund) => ({ id: refund.id, amountMinor: refund.amountMinor })),
    drawers: drawers.map((drawer) => ({
      id: drawer.id,
      expectedMinor: foldExpectedCash(
        drawer.movements.filter((row) => row.kind !== 'CLOSING_COUNT') as DrawerMovement[]
      ),
      countedMinor: drawer.countedCashMinor ?? 0,
    })),
  });
  // MIG-05: a switching branch's first close is not final until the parallel run
  // reconciles. One helper, consulted here and nowhere else in the close.
  const isFinal = await firstCloseIsFinal(db, scope.organizationId, scope.branchId);

  const close = await db.pharmacyDailyClose.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
      sequence: (prior?.sequence ?? 0) + 1,
      supersedesCloseId: prior?.id,
      // The row is append-only, so its one reason is written here: the reopen reason when given,
      // as before, otherwise the variance note.
      reason: input.reopenReason?.trim() ?? (input.varianceNote?.trim() || undefined),
      ...aggregate,
      isFinal,
      controlledCountHook: input.controlledCountHook as Prisma.InputJsonValue | undefined,
      actorId: scope.actorId,
    },
  });
  await requestCounterEvidence(db, scope, { kind: 'DAILY_CLOSE', subjectId: close.id });
  return close;
}
