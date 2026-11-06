import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

export const prepareExternalPaymentSchema = z
  .object({
    saleId: z.string().min(1).max(128),
    deviceId: z.string().min(1).max(128),
    requestKey: z.string().trim().min(1).max(160),
    method: z.enum(['CARD', 'WALLET', 'BANK_TRANSFER', 'RAAST', 'JAZZCASH', 'EASYPAISA']),
    amountMinor: z.number().int().positive().max(2_147_483_647),
    expectedRevision: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();

export class PharmacyPaymentAttemptError extends Error {
  constructor(readonly reason: 'SALE_NOT_FOUND' | 'REQUEST_CONFLICT' | 'ATTEMPT_UNRESOLVED') {
    super(reason);
  }
}

/**
 * The authorization boundary must validate the current actor and branch before
 * calling this function. This owns a separate transaction: await its COMMIT
 * before exposing collection details or calling any provider. Passing an outer
 * settlement transaction here would recreate the rollback gap.
 *
 * This low-level helper does not dispatch or resolve funds. Authenticated
 * collection and audited recovery live in payment-attempt-operations.ts and
 * must retain this separate commit before exposing collection instructions.
 */
export async function prepareExternalPaymentAttempt(
  scope: LedgerScope,
  raw: z.input<typeof prepareExternalPaymentSchema>
) {
  const input = prepareExternalPaymentSchema.parse(raw);
  return withTenantDb(
    scope.organizationId,
    async (db) => {
      const sale = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM pharmacy_sales
      WHERE id=${input.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}
      FOR UPDATE`);
      if (sale.length !== 1) throw new PharmacyPaymentAttemptError('SALE_NOT_FOUND');
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            actorId: scope.actorId,
            ...input,
          })
        )
        .digest('hex');
      const previous = await db.pharmacyPaymentAttempt.findUnique({
        where: {
          organizationId_deviceId_requestKey: {
            organizationId: scope.organizationId,
            deviceId: input.deviceId,
            requestKey: input.requestKey,
          },
        },
      });
      if (previous) {
        if (
          previous.requestHash !== requestHash ||
          previous.branchId !== scope.branchId ||
          previous.saleId !== input.saleId
        )
          throw new PharmacyPaymentAttemptError('REQUEST_CONFLICT');
        return { attempt: previous, replayed: true };
      }
      const blocking = await db.pharmacyPaymentAttempt.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          saleId: input.saleId,
          state: { notIn: ['SETTLED', 'RELEASED'] },
        },
      });
      if (blocking) throw new PharmacyPaymentAttemptError('ATTEMPT_UNRESOLVED');
      const organization = await db.organization.findUniqueOrThrow({
        where: { id: scope.organizationId },
        select: { currency: true },
      });
      const attempt = await db.pharmacyPaymentAttempt.create({
        data: {
          id: randomUUID(),
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          saleId: input.saleId,
          deviceId: input.deviceId,
          requestKey: input.requestKey,
          requestHash,
          method: input.method,
          currency: organization.currency,
          amountMinor: input.amountMinor,
          billRevision: input.expectedRevision,
          createdByUserId: scope.actorId,
        },
      });
      return { attempt, replayed: false };
    },
    { userId: scope.actorId }
  );
}

/** Read-only recovery. Neither absence nor PREPARED authorizes a retry/collection. */
export function readExternalPaymentAttempt(scope: LedgerScope, attemptId: string) {
  if (!attemptId || attemptId.length > 128) throw new Error('Invalid attempt identifier.');
  return withTenantDb(
    scope.organizationId,
    (db) =>
      db.pharmacyPaymentAttempt.findFirst({
        where: { id: attemptId, organizationId: scope.organizationId, branchId: scope.branchId },
      }),
    { userId: scope.actorId }
  );
}
