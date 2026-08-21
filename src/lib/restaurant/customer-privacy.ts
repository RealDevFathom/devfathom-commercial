import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { CustomerError } from './customers';

const EXPORT_SELECT = {
  id: true,
  organizationId: true,
  displayName: true,
  givenName: true,
  familyName: true,
  birthDate: true,
  notes: true,
  anonymizedAt: true,
  createdAt: true,
  updatedAt: true,
  identifiers: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  interactions: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
  tagAssignments: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { tag: true },
  },
  consentEvents: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
  loyaltyAccount: {
    include: {
      pointsEntries: {
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        include: { programVersion: true },
      },
    },
  },
  orders: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { bills: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
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
}: Prisma.RestaurantBillGetPayload<Record<string, never>>) {
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

export async function anonymizeCustomer(
  db: ScopedDb,
  input: { customerId: string; at?: Date }
) {
  return runInTransaction(db, async (tx) => {
    const customer = await tx.restaurantCustomer.findUnique({
      where: { id: input.customerId },
      select: { id: true, anonymizedAt: true },
    });
    if (!customer) throw new CustomerError('Customer does not exist.', 'NOT_FOUND');
    if (customer.anonymizedAt) return { customerId: customer.id, anonymizedAt: customer.anonymizedAt };

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
