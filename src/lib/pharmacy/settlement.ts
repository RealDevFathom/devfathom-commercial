import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { LedgerScope } from './stock-ledger';

export type PharmacyTenderType = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET' | 'CREDIT';

export class PharmacySettlementError extends Error {
  constructor(
    readonly reason:
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

async function bindIdempotency(
  db: ScopedDb,
  organizationId: string,
  deviceId: string,
  key: string,
  commandType: string,
  payloadHash: string
) {
  const prior = await db.pharmacyMoneyIdempotencyKey.findUnique({
    where: { organizationId_deviceId_key: { organizationId, deviceId, key } },
  });
  if (prior) {
    if (prior.commandType !== commandType || prior.payloadHash !== payloadHash)
      throw new PharmacySettlementError('IDEMPOTENCY_CONFLICT');
    return prior;
  }
  return db.pharmacyMoneyIdempotencyKey.create({
    data: { organizationId, deviceId, key, commandType, payloadHash },
  });
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
  }
) {
  assertPositiveMinor(input.amountMinor);
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

  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id = ${input.saleId} AND "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} FOR UPDATE`
  );
  const sale = await db.pharmacySale.findFirst({
    where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { lines: true, tenders: true },
  });
  if (!sale || sale.status !== 'OPEN') throw new PharmacySettlementError('SALE_NOT_OPEN');
  const totalMinor = saleTotalMinor(sale.lines);
  const tenderedMinor = sale.tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
  if (input.amountMinor > totalMinor - tenderedMinor)
    throw new PharmacySettlementError('OVER_TENDER');

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

  const settled = tenderedMinor + input.amountMinor === totalMinor;
  let receiptNumber: number | null = null;
  if (settled) {
    const rows = await db.$queryRaw<Array<{ receipt_number: number }>>(Prisma.sql`
      INSERT INTO pharmacy_receipt_number_sequences (id, "organizationId", "branchId", "deviceId", "nextNumber", "updatedAt")
      VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.deviceId}, 2, now())
      ON CONFLICT ("organizationId", "branchId", "deviceId")
      DO UPDATE SET "nextNumber" = pharmacy_receipt_number_sequences."nextNumber" + 1, "updatedAt" = now()
      RETURNING "nextNumber" - 1 AS receipt_number`);
    receiptNumber = rows[0]!.receipt_number;
    await db.pharmacySale.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: sale.id } },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        receiptNumber,
        receiptDeviceId: input.deviceId,
        businessDate: input.businessDate,
      },
    });
  }
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
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_tenders WHERE id=${input.originalTenderId} AND "organizationId"=${scope.organizationId} FOR UPDATE`
  );
  const tender = await db.pharmacyTender.findFirst({
    where: {
      id: input.originalTenderId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    include: { refunds: true },
  });
  if (!tender) throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
  assertRefundWithinTender(
    tender.amountMinor,
    tender.refunds.reduce((sum, row) => sum + row.amountMinor, 0),
    input.amountMinor
  );
  let providerRef: string | undefined;
  let drawerSessionId: string | undefined;
  if (tender.type === 'CARD' || tender.type === 'WALLET') {
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
  } else if (tender.type === 'CASH') {
    const drawer = await db.pharmacyDrawerSession.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId,
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
      reason: input.reason.trim(),
      actorId: scope.actorId,
    },
  });
  if (drawerSessionId)
    await db.pharmacyDrawerMovement.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId,
        kind: 'CASH_REFUND',
        amountMinor: input.amountMinor,
        reason: input.reason.trim(),
        actorId: scope.actorId,
      },
    });
  const result = {
    refundId: refund.id,
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
