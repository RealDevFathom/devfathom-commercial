import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { CustomerError, lockCustomer } from './customers';

const BILL_EXPORT_SELECT = {
  id: true,
  orderId: true,
  branchId: true,
  businessDate: true,
  status: true,
  subtotal: true,
  taxTotal: true,
  serviceChargeTotal: true,
  compTotal: true,
  discountTotal: true,
  roundingAdjustment: true,
  grandTotal: true,
  receiptNumber: true,
  settledAt: true,
  createdAt: true,
} satisfies Prisma.RestaurantBillSelect;

const EXPORT_SELECT = {
  id: true,
  displayName: true,
  givenName: true,
  familyName: true,
  birthDate: true,
  notes: true,
  anonymizedAt: true,
  createdAt: true,
  updatedAt: true,
  identifiers: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      kind: true,
      normalizedValue: true,
      verifiedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  interactions: {
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      branchId: true,
      orderId: true,
      type: true,
      occurredAt: true,
      createdAt: true,
    },
  },
  tagAssignments: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      tagId: true,
      createdAt: true,
      tag: {
        select: { id: true, name: true, color: true, createdAt: true, updatedAt: true },
      },
    },
  },
  consentEvents: {
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      channel: true,
      granted: true,
      source: true,
      actorId: true,
      policyVersion: true,
      occurredAt: true,
      createdAt: true,
    },
  },
  loyaltyAccount: {
    select: {
      id: true,
      active: true,
      enrolledAt: true,
      deactivatedAt: true,
      createdAt: true,
      updatedAt: true,
      pointsEntries: {
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          accountId: true,
          programVersionId: true,
          kind: true,
          points: true,
          billId: true,
          refundId: true,
          reversesEntryId: true,
          reason: true,
          expiresAt: true,
          occurredAt: true,
          createdAt: true,
          programVersion: {
            select: {
              id: true,
              versionNumber: true,
              effectiveFrom: true,
              earnRate: true,
              redemptionValue: true,
              expiryDays: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  },
  orders: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      branchId: true,
      orderNumber: true,
      businessDate: true,
      status: true,
      channel: true,
      openedAt: true,
      closedAt: true,
      cancelledAt: true,
      createdAt: true,
      bills: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: BILL_EXPORT_SELECT,
      },
    },
  },
} satisfies Prisma.RestaurantCustomerSelect;

function runInTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

function exportBill({
  subtotal,
  taxTotal,
  serviceChargeTotal,
  compTotal,
  discountTotal,
  roundingAdjustment,
  grandTotal,
  ...bill
}: Prisma.RestaurantBillGetPayload<{ select: typeof BILL_EXPORT_SELECT }>) {
  return {
    ...bill,
    subtotal: subtotal.toString(),
    taxTotal: taxTotal.toString(),
    serviceChargeTotal: serviceChargeTotal.toString(),
    compTotal: compTotal.toString(),
    discountTotal: discountTotal.toString(),
    roundingAdjustment: roundingAdjustment.toString(),
    grandTotal: grandTotal.toString(),
  };
}

export async function exportCustomerData(db: ScopedDb, customerId: string) {
  const customer = await db.restaurantCustomer.findUnique({
    where: { id: customerId },
    select: EXPORT_SELECT,
  });
  if (!customer) throw new CustomerError('Customer does not exist.', 'NOT_FOUND');

  const {
    identifiers,
    interactions,
    tagAssignments,
    consentEvents,
    loyaltyAccount,
    orders,
    ...profile
  } = customer;
  const loyaltyLedger = loyaltyAccount?.pointsEntries ?? [];
  const programVersions = new Map(
    loyaltyLedger.map(({ programVersion }) => [programVersion.id, programVersion])
  );

  return {
    profile,
    identifiers,
    interactions,
    tags: tagAssignments.map(({ tag }) => tag),
    tagAssignments: tagAssignments.map(({ tag, ...assignment }) => {
      void tag;
      return assignment;
    }),
    consentEvents,
    loyaltyAccount: loyaltyAccount
      ? (({ pointsEntries, ...account }) => {
          void pointsEntries;
          return account;
        })(loyaltyAccount)
      : null,
    loyaltyProgramVersions: [...programVersions.values()].map(
      ({ earnRate, redemptionValue, ...version }) => ({
        ...version,
        earnRate: earnRate.toString(),
        redemptionValue: redemptionValue.toString(),
      })
    ),
    loyaltyLedger: loyaltyLedger.map(({ programVersion, ...entry }) => {
      void programVersion;
      return entry;
    }),
    orders: orders.map(({ bills, ...order }) => {
      void bills;
      return order;
    }),
    bills: orders.flatMap(({ bills }) => bills.map(exportBill)),
  };
}

export async function anonymizeCustomer(db: ScopedDb, input: { customerId: string; at?: Date }) {
  return runInTransaction(db, async (tx) => {
    const customer = await lockCustomer(tx, input.customerId);
    if (customer.anonymizedAt)
      return { customerId: customer.id, anonymizedAt: customer.anonymizedAt };

    const anonymizedAt = input.at ?? new Date();
    await tx.customerIdentifier.deleteMany({ where: { customerId: customer.id } });
    await tx.customerTagAssignment.deleteMany({ where: { customerId: customer.id } });
    await tx.restaurantCustomer.update({
      where: { id: customer.id },
      data: {
        displayName: null,
        givenName: null,
        familyName: null,
        birthDate: null,
        notes: null,
        anonymizedAt,
      },
    });
    await tx.loyaltyAccount.updateMany({
      where: { customerId: customer.id },
      data: { active: false, deactivatedAt: anonymizedAt },
    });
    return { customerId: customer.id, anonymizedAt };
  });
}
