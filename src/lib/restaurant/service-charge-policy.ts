import 'server-only';

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export class ServiceChargePolicyError extends Error {
  constructor(message: string, readonly reason: 'CONFLICT' | 'INVALID' | 'NOT_FOUND') {
    super(message);
    this.name = 'ServiceChargePolicyError';
  }
}

export type PublishServiceChargePolicyInput = {
  organizationId: string;
  branchId: string;
  rate: string;
  effectiveFrom: Date;
  acknowledgementRef: string;
  acknowledged: true;
  idempotencyKey: string;
  replaceOpenPolicy?: boolean;
};

function canonical(input: PublishServiceChargePolicyInput) {
  return JSON.stringify({
    branchId: input.branchId,
    rate: new Prisma.Decimal(input.rate).toFixed(6),
    effectiveFrom: input.effectiveFrom.toISOString(),
    acknowledgementRef: input.acknowledgementRef.trim(),
    acknowledged: input.acknowledged,
    replaceOpenPolicy: input.replaceOpenPolicy === true,
  });
}

export async function publishServiceChargePolicy(
  db: ScopedDb,
  input: PublishServiceChargePolicyInput
) {
  const payloadHash = createHash('sha256').update(canonical(input)).digest('hex');
  return (db.$transaction as unknown as (work: (tx: ScopedDb) => Promise<unknown>) => Promise<unknown>)(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}:service-charge:${input.branchId}`}, 0))`;
      const replay = await tx.restaurantServiceChargePolicyVersion.findUnique({
        where: {
          organizationId_idempotencyKey: {
            organizationId: input.organizationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (replay) {
        if (replay.payloadHash !== payloadHash) {
          throw new ServiceChargePolicyError(
            'This idempotency key was already used for a different service-charge policy.',
            'CONFLICT'
          );
        }
        return replay;
      }
      const branch = await tx.restaurantBranch.findFirst({
        where: { id: input.branchId, organizationId: input.organizationId, active: true },
        select: { id: true },
      });
      if (!branch) throw new ServiceChargePolicyError('Branch not found.', 'NOT_FOUND');
      const rate = new Prisma.Decimal(input.rate);
      if (!rate.isPositive() || rate.greaterThan(1)) {
        throw new ServiceChargePolicyError('Rate must be greater than zero and at most one.', 'INVALID');
      }
      const open = await tx.restaurantServiceChargePolicyVersion.findFirst({
        where: { branchId: input.branchId, effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (open) {
        if (!input.replaceOpenPolicy || input.effectiveFrom <= open.effectiveFrom) {
          throw new ServiceChargePolicyError('The policy interval overlaps an existing policy.', 'CONFLICT');
        }
        await tx.restaurantServiceChargePolicyVersion.update({
          where: { id: open.id },
          data: { effectiveTo: input.effectiveFrom },
        });
      }
      return tx.restaurantServiceChargePolicyVersion.create({
        data: {
          id: randomUUID(),
          organizationId: input.organizationId,
          branchId: input.branchId,
          rate,
          effectiveFrom: input.effectiveFrom,
          acknowledgedAt: new Date(),
          acknowledgementRef: input.acknowledgementRef.trim(),
          idempotencyKey: input.idempotencyKey,
          payloadHash,
        },
      });
    }
  );
}

export async function endServiceChargePolicy(
  db: ScopedDb,
  input: { organizationId: string; branchId: string; effectiveTo: Date }
) {
  return (db.$transaction as unknown as (work: (tx: ScopedDb) => Promise<unknown>) => Promise<unknown>)(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}:service-charge:${input.branchId}`}, 0))`;
      const current = await tx.restaurantServiceChargePolicyVersion.findFirst({
        where: { branchId: input.branchId, effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (!current) throw new ServiceChargePolicyError('No open policy exists.', 'NOT_FOUND');
      if (input.effectiveTo <= current.effectiveFrom) {
        throw new ServiceChargePolicyError('Policy end must be after its start.', 'INVALID');
      }
      return tx.restaurantServiceChargePolicyVersion.update({
        where: { id: current.id },
        data: { effectiveTo: input.effectiveTo },
      });
    }
  );
}
