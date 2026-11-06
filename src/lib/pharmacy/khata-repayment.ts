import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { z } from 'zod';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { settleFamilyKhata, type FamilyKhataScope } from './family-khata';
import { PharmacySettlementError, recordPharmacyCashMovement } from './settlement';

export type KhataRepaymentTender = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET';

/** Records the khata ledger and, for cash, its drawer paid-in in one transaction. */
export async function recordKhataRepayment(
  db: ScopedDb,
  scope: FamilyKhataScope,
  input: {
    familyAccountId: string;
    amountMinor: number;
    tender: KhataRepaymentTender;
    drawerSessionId?: string;
    occurredAt: Date;
    idempotencyKey: string;
  }
) {
  const deviceId = `khata:${scope.actorId}:${scope.branchId}`;
  const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  // The no-op update takes a row lock until the enclosing transaction commits.
  // A lost response can replay this exact request without paying the ledger twice.
  await db.$executeRaw(Prisma.sql`INSERT INTO pharmacy_money_idempotency_keys
    (id, "organizationId", "deviceId", key, "commandType", "payloadHash", "createdAt")
    VALUES (${randomUUID()}, ${scope.organizationId}, ${deviceId}, ${input.idempotencyKey}, 'khata-repayment', ${payloadHash}, now())
    ON CONFLICT ("organizationId", "deviceId", key) DO UPDATE SET key = EXCLUDED.key`);
  const prior = await db.pharmacyMoneyIdempotencyKey.findUnique({
    where: {
      organizationId_deviceId_key: {
        organizationId: scope.organizationId,
        deviceId,
        key: input.idempotencyKey,
      },
    },
  });
  if (!prior || prior.commandType !== 'khata-repayment' || prior.payloadHash !== payloadHash)
    throw new PharmacySettlementError('IDEMPOTENCY_CONFLICT');
  const receiptSchema = z.object({
    receiptId: z.string().min(1),
    paidMinor: z.number().int().positive(),
    remainingBalanceMinor: z.number().int().nonnegative(),
    tender: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET']),
    occurredAt: z.string().datetime(),
  });
  if (prior.resultPayload) {
    const stored = receiptSchema.safeParse(prior.resultPayload);
    if (!stored.success) throw new PharmacySettlementError('IDEMPOTENCY_CONFLICT');
    return stored.data;
  }
  // For CASH, refuse a foreign open drawer before any khata ledger write so a
  // rejected ownership check never leaves a settlement that only the outer
  // transaction would roll back.
  if (input.tender === 'CASH') {
    const drawerSessionId = input.drawerSessionId ?? '';
    const drawer = await db.pharmacyDrawerSession.findFirst({
      where: {
        id: drawerSessionId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'OPEN',
      },
      select: { id: true, openedByActorId: true },
    });
    if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
    if (drawer.openedByActorId !== scope.actorId)
      throw new PharmacySettlementError('DRAWER_NOT_OWNED');
  }

  const occurredAt = new Date();
  const settlement = await settleFamilyKhata(db, scope, {
    familyAccountId: input.familyAccountId,
    amountMinor: input.amountMinor,
    occurredAt,
    note: `Tender: ${input.tender}`,
  });
  const receiptId = settlement.allocations[0]?.id;
  if (!receiptId) throw new Error('Khata repayment produced no allocation.');

  if (input.tender === 'CASH') {
    await recordPharmacyCashMovement(db, scope, {
      drawerSessionId: input.drawerSessionId ?? '',
      kind: 'PAID_IN',
      amountMinor: input.amountMinor,
      reason: `Khata payment ${receiptId}`,
    });
  }

  const result = {
    paidMinor: settlement.paidMinor,
    remainingBalanceMinor: settlement.remainingBalanceMinor,
    receiptId,
    tender: input.tender,
    occurredAt: occurredAt.toISOString(),
  };
  await db.pharmacyMoneyIdempotencyKey.update({
    where: { id: prior.id },
    data: { resultPayload: result },
  });
  return result;
}
