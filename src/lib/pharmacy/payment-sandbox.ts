import 'server-only';
import { assertSaleLinesCleared } from './rx-gate';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { paymentSandboxAdmitted } from './payment-sandbox-admission';
import { applyPharmacyTender, refundPharmacyTender } from './settlement';

export class PharmacyPaymentSandboxError extends Error {}

const state = z.enum(['APPROVED', 'FAILED', 'UNKNOWN']);
const mode = z.enum(['EXECUTE', 'RETRY', 'RECONCILE']);
export const sandboxPaymentInput = z
  .object({
    branchId: z.string().min(1).max(128),
    saleId: z.string().min(1).max(128),
    originalTenderId: z.string().min(1).max(128).optional(),
    action: z.enum(['SALE', 'REFUND']),
    type: z.enum(['CARD', 'WALLET']),
    deviceId: z.string().min(1).max(128),
    businessDate: z.date(),
    amountMinor: z.number().int().positive().safe(),
    operationKey: z.string().min(1).max(128),
    outcome: state,
    mode,
    reason: z
      .string()
      .trim()
      .min(3)
      .max(160)
      .regex(/^[A-Za-z][A-Za-z _.-]+$/, 'Use a short reason without card or numeric account data'),
  })
  .strict();
const storedResult = z.object({
  status: state,
  token: z.string(),
  simulated: z.literal(true),
  history: z.array(
    z.object({ status: state, mode, actorId: z.string(), at: z.string(), reason: z.string() })
  ),
});
export function nextSandboxPaymentState(
  prior: z.infer<typeof state> | null,
  outcome: z.infer<typeof state>,
  operation: z.infer<typeof mode>
) {
  if (prior === 'APPROVED') return prior;
  if (prior === 'UNKNOWN' && operation !== 'RECONCILE')
    throw new PharmacyPaymentSandboxError('RECONCILIATION_REQUIRED');
  if (operation === 'RECONCILE' && prior !== 'UNKNOWN')
    throw new PharmacyPaymentSandboxError('INVALID_STATE');
  if (operation === 'RETRY' && prior !== 'FAILED')
    throw new PharmacyPaymentSandboxError('INVALID_STATE');
  if (prior === 'FAILED' && operation === 'EXECUTE') return prior;
  return outcome;
}

/** Deterministic local simulator only. No network, PAN, CVV or real provider credentials. */
export async function executeSandboxPayment(
  db: ScopedDb,
  scope: LedgerScope,
  input: z.infer<typeof sandboxPaymentInput>
) {
  if (!paymentSandboxAdmitted())
    throw new PharmacyPaymentSandboxError('PAYMENT_SANDBOX_UNAVAILABLE');
  sandboxPaymentInput.parse(input);
  if (input.branchId !== scope.branchId) throw new PharmacyPaymentSandboxError('SALE_NOT_FOUND');
  const sale = await db.pharmacySale.findFirst({
    where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { id: true },
  });
  if (!sale) throw new PharmacyPaymentSandboxError('SALE_NOT_FOUND');
  if (input.action === 'REFUND') {
    if (
      !input.originalTenderId ||
      !(await db.pharmacyTender.findFirst({
        where: {
          id: input.originalTenderId,
          saleId: input.saleId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          type: input.type,
          provider: 'LOCAL_TOKEN_SANDBOX',
        },
        select: { id: true },
      }))
    )
      throw new PharmacyPaymentSandboxError('TENDER_NOT_FOUND');
  } else if (input.originalTenderId) throw new PharmacyPaymentSandboxError('INVALID_STATE');
  // Use the same sale lock as settlement, before operation-key locks. Different
  // keys, amounts and payment types cannot race an unresolved target outcome.
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${input.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  // SEC: a sandbox charge is still a payment; refunds return money and stay allowed.
  if (input.action !== 'REFUND') await assertSaleLinesCleared(db, scope, input.saleId);
  const target = JSON.stringify([
    scope.branchId,
    input.saleId,
    input.action,
    input.originalTenderId ?? null,
  ]);
  const identity = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    action: input.action,
    operationKey: input.operationKey,
  };
  const token = `sandbox:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
  const key = token;
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify({
        ...identity,
        saleId: input.saleId,
        originalTenderId: input.originalTenderId,
        type: input.type,
        deviceId: input.deviceId,
        businessDate: input.businessDate,
        amountMinor: input.amountMinor,
      })
    )
    .digest('hex');
  await db.$queryRaw(
    Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${token},0))`
  );
  const bound = await db.pharmacyMoneyIdempotencyKey.findFirst({
    where: { organizationId: scope.organizationId, key },
  });
  if (bound && (bound.deviceId !== input.deviceId || bound.payloadHash !== payloadHash))
    throw new PharmacyPaymentSandboxError('IDEMPOTENCY_CONFLICT');
  // A resolved replay is read-only, even when another operation is uncertain.
  if (bound?.resultPayload) {
    const recorded = storedResult.parse(bound.resultPayload);
    if (
      recorded.status === 'APPROVED' ||
      (recorded.status === 'FAILED' && input.mode === 'EXECUTE')
    )
      return { ...recorded, replayed: true };
  }
  const unresolved = await db.pharmacyMoneyIdempotencyKey.findMany({
    where: {
      organizationId: scope.organizationId,
      commandType: 'sandbox_payment',
      resultPayload: { path: ['status'], equals: 'UNKNOWN' },
    },
    select: { key: true, resultPayload: true },
  });
  // Legacy unresolved rows without target metadata fail closed until reconciled.
  if (
    unresolved.some((row) => {
      const payload = row.resultPayload as { target?: string } | null;
      return row.key !== key && (!payload?.target || payload.target === target);
    })
  )
    throw new PharmacyPaymentSandboxError('RECONCILIATION_REQUIRED');
  await db.$executeRaw(
    Prisma.sql`INSERT INTO pharmacy_money_idempotency_keys (id,"organizationId","deviceId",key,"commandType","payloadHash","createdAt") VALUES (${randomUUID()},${scope.organizationId},${input.deviceId},${key},'sandbox_payment',${payloadHash},now()) ON CONFLICT ("organizationId","deviceId",key) DO NOTHING`
  );
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_money_idempotency_keys WHERE "organizationId"=${scope.organizationId} AND "deviceId"=${input.deviceId} AND key=${key} FOR UPDATE`
  );
  const operation = await db.pharmacyMoneyIdempotencyKey.findUnique({
    where: {
      organizationId_deviceId_key: {
        organizationId: scope.organizationId,
        deviceId: input.deviceId,
        key,
      },
    },
  });
  if (
    !operation ||
    operation.commandType !== 'sandbox_payment' ||
    operation.payloadHash !== payloadHash
  )
    throw new PharmacyPaymentSandboxError('IDEMPOTENCY_CONFLICT');
  const prior = operation.resultPayload ? storedResult.parse(operation.resultPayload) : null;
  if (prior?.status === 'APPROVED' || (prior?.status === 'FAILED' && input.mode === 'EXECUTE'))
    return { ...prior, replayed: true };
  const status = nextSandboxPaymentState(prior?.status ?? null, input.outcome, input.mode);
  if (status === 'APPROVED') {
    const adapter = {
      name: 'LOCAL_TOKEN_SANDBOX',
      certified: false,
      localSandbox: true as const,
      execute: async () => ({ approved: true, providerRef: token }),
    };
    if (input.action === 'SALE')
      await applyPharmacyTender(db, scope, {
        saleId: input.saleId,
        deviceId: input.deviceId,
        businessDate: input.businessDate,
        type: input.type,
        amountMinor: input.amountMinor,
        idempotencyKey: `${token}:settle`,
        adapter,
      });
    else
      await refundPharmacyTender(db, scope, {
        originalTenderId: input.originalTenderId!,
        deviceId: input.deviceId,
        businessDate: input.businessDate,
        amountMinor: input.amountMinor,
        reason: `Local sandbox refund: ${input.reason}`,
        requireReturnedValue: true,
        idempotencyKey: `${token}:refund`,
        adapter,
      });
  }
  const result = {
    target,
    status,
    token,
    simulated: true as const,
    history: [
      ...(prior?.history ?? []),
      {
        status,
        mode: input.mode,
        actorId: scope.actorId,
        at: new Date().toISOString(),
        reason: input.reason,
      },
    ],
  };
  await db.pharmacyMoneyIdempotencyKey.update({
    where: { id: operation.id },
    data: { resultPayload: result },
  });
  return { ...result, replayed: false };
}
