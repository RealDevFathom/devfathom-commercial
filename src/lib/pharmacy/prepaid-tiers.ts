import 'server-only';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { postJournalEntry } from '@/lib/finance/journal';

export const PREPAID_PROVIDER = 'CUSTOMER_PREPAID';
const money = z.number().int().min(1).max(2_000_000_000);
export const prepaidTierSettings = z
  .object({
    refundable: z.boolean(),
    tiers: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(60),
            upfrontMinor: money,
            discountBasisPoints: z.number().int().min(1).max(9999),
          })
          .strict()
      )
      .max(20)
      .refine(
        (tiers) =>
          new Set(tiers.map((t) => t.name.toLowerCase())).size === tiers.length &&
          new Set(tiers.map((t) => t.upfrontMinor)).size === tiers.length,
        'Tier names and amounts must be unique.'
      ),
  })
  .strict();
export type PrepaidTier = z.infer<typeof prepaidTierSettings>['tiers'][number];
export class PrepaidError extends Error {}

export function qualifyingTier(tiers: PrepaidTier[], qualifyingMinor: number) {
  return (
    [...tiers]
      .sort((a, b) => b.upfrontMinor - a.upfrontMinor)
      .find((t) => qualifyingMinor >= t.upfrontMinor) ?? null
  );
}
export async function prepaidSettings(db: ScopedDb, organizationId: string) {
  return db.pharmacyPrepaidTierVersion.findMany({
    where: { organizationId },
    orderBy: { version: 'desc' },
    take: 20,
  });
}
export async function publishPrepaidSettings(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string },
  input: z.infer<typeof prepaidTierSettings>
) {
  const settings = prepaidTierSettings.parse(input);
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`prepaid-settings:${scope.organizationId}`},0))`
  );
  const prior = (await prepaidSettings(db, scope.organizationId))[0];
  return db.pharmacyPrepaidTierVersion.create({
    data: { ...scope, version: (prior?.version ?? 0) + 1, ...settings },
  });
}
export async function readPrepaidAccount(db: ScopedDb, organizationId: string, customerId: string) {
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: customerId, organizationId, active: true },
    select: { prepaidAccount: true },
  });
  return customer?.prepaidAccount ?? null;
}
export async function lockPrepaidCustomer(
  db: ScopedDb,
  organizationId: string,
  customerId: string
) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`prepaid-customer:${organizationId}:${customerId}`},0))`
  );
}

/** One transaction owns the customer lock, conditional account update, ledger and journal. */
export async function movePrepaid(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    customerId: string;
    kind: 'PAYMENT' | 'SPEND' | 'REFUND' | 'RESTORE';
    amountMinor: number;
    idempotencyKey: string;
    tenderId?: string;
    refundId?: string;
  }
) {
  money.parse(input.amountMinor);
  await lockPrepaidCustomer(db, scope.organizationId, input.customerId);
  const prior = await db.pharmacyPrepaidEntry.findUnique({
    where: {
      organizationId_idempotencyKey: {
        organizationId: scope.organizationId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    include: { account: true },
  });
  const sign = input.kind === 'SPEND' || input.kind === 'REFUND' ? -1 : 1;
  if (prior) {
    if (
      prior.account.customerId !== input.customerId ||
      prior.kind !== input.kind ||
      prior.amountMinor !== sign * input.amountMinor ||
      prior.branchId !== scope.branchId ||
      prior.tenderId !== (input.tenderId ?? null) ||
      prior.refundId !== (input.refundId ?? null)
    )
      throw new PrepaidError('Payment reference already used for different details.');
    return { ...prior, replayed: true };
  }
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: input.customerId, organizationId: scope.organizationId, active: true },
    select: { id: true },
  });
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { id: true },
  });
  if (!customer || !branch) throw new PrepaidError('Customer or branch unavailable.');
  const account = await db.pharmacyPrepaidAccount.upsert({
    where: {
      organizationId_customerId: { organizationId: scope.organizationId, customerId: customer.id },
    },
    create: { organizationId: scope.organizationId, customerId: customer.id },
    update: {},
  });
  let refundableDeltaMinor = 0;
  let qualifyingMinor = account.qualifyingMinor;
  let tierName = account.tierName;
  let discountBasisPoints = account.discountBasisPoints;
  let tierVersionId = account.tierVersionId;
  let refundable: boolean | null = null;
  if (input.kind === 'PAYMENT') {
    const version = (await prepaidSettings(db, scope.organizationId))[0];
    if (!version) throw new PrepaidError('The owner must save prepaid settings first.');
    const settings = prepaidTierSettings.parse({
      tiers: version.tiers,
      refundable: version.refundable,
    });
    qualifyingMinor += input.amountMinor;
    const tier = qualifyingTier(settings.tiers, qualifyingMinor);
    tierName = tier?.name ?? null;
    discountBasisPoints = tier?.discountBasisPoints ?? 0;
    tierVersionId = version.id;
    refundable = version.refundable;
    refundableDeltaMinor = refundable ? input.amountMinor : 0;
  } else if (input.kind === 'SPEND') {
    // Spend non-refundable funds first; never turn them into refundable money.
    refundableDeltaMinor = -Math.max(
      0,
      input.amountMinor - (account.balanceMinor - account.refundableMinor)
    );
  } else if (input.kind === 'REFUND') {
    if (input.amountMinor > account.refundableMinor)
      throw new PrepaidError('This amount is not refundable under the payment receipt terms.');
    refundableDeltaMinor = -input.amountMinor;
  } else {
    const spent = await db.pharmacyPrepaidEntry.findFirst({
      where: {
        organizationId: scope.organizationId,
        accountId: account.id,
        kind: 'SPEND',
        tenderId: input.tenderId,
      },
    });
    if (!spent) throw new PrepaidError('Original prepaid payment unavailable.');
    const restored = await db.pharmacyPrepaidEntry.aggregate({
      where: {
        organizationId: scope.organizationId,
        accountId: account.id,
        kind: 'RESTORE',
        tenderId: input.tenderId,
      },
      _sum: { amountMinor: true, refundableDeltaMinor: true },
    });
    if ((restored._sum.amountMinor ?? 0) + input.amountMinor > -spent.amountMinor)
      throw new PrepaidError('Refund exceeds prepaid payment.');
    // Restore the original refundable share cumulatively, including rounding pennies.
    refundableDeltaMinor =
      Number(
        (BigInt((restored._sum.amountMinor ?? 0) + input.amountMinor) *
          BigInt(-spent.refundableDeltaMinor)) /
          BigInt(-spent.amountMinor)
      ) - (restored._sum.refundableDeltaMinor ?? 0);
  }
  const balanceAfterMinor = account.balanceMinor + sign * input.amountMinor;
  if (balanceAfterMinor < 0 || balanceAfterMinor > 2_000_000_000 || qualifyingMinor > 2_000_000_000)
    throw new PrepaidError('Insufficient prepaid balance or balance limit exceeded.');
  if (balanceAfterMinor === 0) {
    qualifyingMinor = 0;
    tierName = null;
    discountBasisPoints = 0;
    tierVersionId = null;
  }
  const updated = await db.pharmacyPrepaidAccount.updateMany({
    where: {
      id: account.id,
      organizationId: scope.organizationId,
      balanceMinor: account.balanceMinor,
      refundableMinor: account.refundableMinor,
    },
    data: {
      balanceMinor: balanceAfterMinor,
      refundableMinor: account.refundableMinor + refundableDeltaMinor,
      qualifyingMinor,
      tierName,
      discountBasisPoints,
      tierVersionId,
    },
  });
  if (updated.count !== 1) throw new PrepaidError('Prepaid balance changed. Reload and retry.');
  const entry = await db.pharmacyPrepaidEntry.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      accountId: account.id,
      kind: input.kind,
      amountMinor: sign * input.amountMinor,
      refundableDeltaMinor,
      balanceAfterMinor,
      tierBefore: account.tierName,
      tierAfter: tierName,
      tierVersionId: input.kind === 'PAYMENT' ? tierVersionId : account.tierVersionId,
      refundable,
      tenderId: input.tenderId,
      refundId: input.refundId,
      actorId: scope.actorId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (account.tierName !== tierName || account.tierVersionId !== tierVersionId)
    await db.auditLog.create({
      data: {
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        source: 'TRPC',
        category: 'PHARMACY',
        operation: 'UPDATE',
        action: 'pharmacy.prepaid.tierChanged',
        targetType: 'PharmacyCustomer',
        targetId: customer.id,
        metadata: {
          entryId: entry.id,
          before: account.tierName,
          after: tierName,
          versionId: tierVersionId,
        },
      },
    });
  return { ...entry, replayed: false };
}

export async function postPrepaidCash(
  db: ScopedDb,
  scope: LedgerScope,
  entry: { id: string; kind: string; amountMinor: number; createdAt: Date }
) {
  const amountMinor = Math.abs(entry.amountMinor);
  return postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_PREPAID',
    sourceId: entry.id,
    description: entry.kind === 'PAYMENT' ? 'Customer prepaid payment' : 'Customer prepaid refund',
    occurredAt: entry.createdAt,
    idempotencyKey: `prepaid:${entry.id}`,
    branchId: scope.branchId,
    lines: [
      {
        accountCode: 'CASH',
        side: entry.amountMinor > 0 ? 'DEBIT' : 'CREDIT',
        amountMinor,
        branchId: scope.branchId,
      },
      {
        accountCode: 'CUSTOMER_PREPAID',
        side: entry.amountMinor > 0 ? 'CREDIT' : 'DEBIT',
        amountMinor,
        branchId: scope.branchId,
      },
    ],
  });
}
