import 'server-only';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { currentLoyaltyProgram, lockLoyaltyOrganization } from './loyalty-program';
import { earnedPoints } from './loyalty-rate';
import { hasEarningConsent } from './customer-loyalty';
import { lockKhataCollection, type FamilyKhataScope } from './family-khata';

/** Only invoked for real posted CUSTOMER_RECEIPT allocations, never refund PAYMENT events. */
export async function earnCollectedKhata(
  db: ScopedDb,
  scope: FamilyKhataScope,
  paymentId: string,
  collectionId: string
) {
  const payment = await db.pharmacyKhataEvent.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: paymentId,
      kind: 'PAYMENT',
    },
  });
  if (!payment?.settlesChargeId?.startsWith('khata:')) return null;
  const tenderId = payment.settlesChargeId.slice('khata:'.length);
  const tender = await db.pharmacyTender.findFirst({
    where: {
      id: tenderId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      type: 'CREDIT',
    },
    include: { sale: { select: { customerId: true } } },
  });
  if (!tender?.sale.customerId) return null;
  const key = `loyalty:collection:${payment.id}`;
  const prior = await db.pharmacyLoyaltyPointsEntry.findUnique({
    where: {
      organizationId_idempotencyKey: { organizationId: scope.organizationId, idempotencyKey: key },
    },
  });
  if (prior) return prior;
  // Legacy sales already earned on CREDIT at sale time. Never award those balances twice.
  const legacy = await db.pharmacyLoyaltyPointsEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      saleId: tender.saleId,
      kind: 'EARN',
      programVersionId: null,
    },
  });
  if (legacy) return null;
  await lockLoyaltyOrganization(db, scope.organizationId);
  const program = await currentLoyaltyProgram(db, scope.organizationId);
  if (
    !program?.khataEnabled ||
    !(await hasEarningConsent(db, scope.organizationId, tender.sale.customerId))
  )
    return null;
  const entries = await db.pharmacyKhataEvent.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      familyAccountId: payment.familyAccountId,
    },
  });
  const reversed = new Set(
    entries.filter((row) => row.kind === 'PAYMENT_REVERSAL').map((row) => row.settlesChargeId)
  );
  const collected = entries
    .filter(
      (row) =>
        row.kind === 'PAYMENT' &&
        row.settlesChargeId === payment.settlesChargeId &&
        !row.id.startsWith('khata-refund:') &&
        !reversed.has(row.id)
    )
    .reduce((sum, row) => sum + row.amountMinor, 0);
  const start = collected - payment.amountMinor;
  const points = earnedPoints(payment.amountMinor, program);
  if (!points) return null;
  return db.pharmacyLoyaltyPointsEntry.create({
    data: {
      ...scope,
      customerId: tender.sale.customerId,
      saleId: tender.saleId,
      tenderId,
      kind: 'EARN',
      points,
      netPaidMinor: payment.amountMinor,
      earnStartMinor: start,
      programVersionId: program.id,
      collectionId,
      idempotencyKey: key,
    },
  });
}

/** Receipt reversal restores the debt and removes only points that receipt actually earned. */
export async function reverseCollectedKhata(
  db: ScopedDb,
  scope: FamilyKhataScope,
  collectionId: string
) {
  const payments = await db.pharmacyKhataEvent.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      kind: 'PAYMENT',
      note: `Collection ${collectionId}`,
    },
  });
  for (const familyId of [...new Set(payments.map((payment) => payment.familyAccountId))].sort())
    await lockKhataCollection(db, scope, familyId);
  for (const payment of payments) {
    await db.pharmacyKhataEvent.create({
      data: {
        ...scope,
        id: `khata-payment-reversal:${payment.id}`,
        familyAccountId: payment.familyAccountId,
        kind: 'PAYMENT_REVERSAL',
        amountMinor: payment.amountMinor,
        settlesChargeId: payment.id,
        note: `Collection reversal ${collectionId}`,
      },
    });
  }
  const earns = await db.pharmacyLoyaltyPointsEntry.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      collectionId,
      kind: 'EARN',
    },
  });
  await lockLoyaltyOrganization(db, scope.organizationId);
  for (const earn of earns) {
    await hasEarningConsent(db, scope.organizationId, earn.customerId); // lock; revocation cannot suppress a reversal
    const reversed = await db.pharmacyLoyaltyPointsEntry.aggregate({
      where: {
        organizationId: scope.organizationId,
        kind: 'EARN_REVERSAL',
        OR: [
          { idempotencyKey: { startsWith: `loyalty:versioned-reversal:${earn.id}:` } },
          { idempotencyKey: `loyalty:collection-reversal:${earn.id}` },
        ],
      },
      _sum: { points: true },
    });
    const points = -earn.points - (reversed._sum.points ?? 0);
    if (points < 0)
      await db.pharmacyLoyaltyPointsEntry.create({
        data: {
          ...scope,
          customerId: earn.customerId,
          saleId: earn.saleId,
          tenderId: earn.tenderId,
          kind: 'EARN_REVERSAL',
          points,
          collectionId,
          programVersionId: earn.programVersionId,
          idempotencyKey: `loyalty:collection-reversal:${earn.id}`,
        },
      });
  }
}
