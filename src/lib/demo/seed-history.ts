import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { isDemoTenant } from '@/lib/demo/isolation';
import { cutBills } from '@/lib/restaurant/bills';
import { getOrderSettlementForBranch } from '@/lib/restaurant/checkout-routes';
import { correctClose, cutClose } from '@/lib/restaurant/daily-close';
import {
  createDeliveryAddress,
  createDeliveryFulfillment,
  createDeliveryZone,
  transitionDeliveryFulfillment,
} from '@/lib/restaurant/delivery';
import { enrollDevice } from '@/lib/restaurant/devices';
import { closeDrawerSession, openDrawerSession } from '@/lib/restaurant/drawer-sessions';
import { addItem, advanceItem, closeOrder, openOrder, sendOrder } from '@/lib/restaurant/orders';
import { refundTender } from '@/lib/restaurant/refunds';
import { publishTaxProfile } from '@/lib/restaurant/tax-publication';
import { applyTender, type ApplyTenderResult } from '@/lib/restaurant/tenders';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { buildEffectiveMenu } from '@/server/routers/restaurant-menus';
import type { TRPCContext } from '@/server/trpc';

import type { DemoRestaurantCatalogIds } from './seed-catalog';
import type { DemoRestaurantSeed } from './seed-data';
import type { DemoRestaurantOperationsIds } from './seed-operations';

type HistoricalOrder = DemoRestaurantSeed['sales']['historicalOrders'][number];
type LiveOrder = DemoRestaurantSeed['sales']['liveOrders'][number];
type Settlement = DemoRestaurantSeed['sales']['settlements'][number];

export type DemoRestaurantHistoryIds = {
  taxProfile: Record<string, string>;
  publication: Record<string, string>;
  posDevice: Record<string, string>;
  kdsDevice: Record<string, string>;
  deliveryZone: Record<string, string>;
  deliveryAddress: Record<string, string>;
  deliveryFulfillment: Record<string, string>;
  order: Record<string, string>;
  orderItem: Record<string, string>;
  bill: Record<string, string>;
  settlement: Record<string, string>;
  refund: Record<string, string>;
  dailyClose: Record<string, string>;
  dailyCloseCorrection: Record<string, string>;
  kdsTicket: Record<string, string>;
  liveDrawerSessionId: string;
  counts: {
    taxProfiles: number;
    devices: number;
    deliveryZones: number;
    deliveryAddresses: number;
    deliveryFulfillments: number;
    historicalOrders: number;
    historicalOrderLines: number;
    bills: number;
    tenders: number;
    cashTenders: number;
    cardTenders: number;
    refunds: number;
    historicalDrawerSessions: number;
    dailyCloses: number;
    dailyCloseCorrections: number;
    kdsTickets: number;
    liveOrders: number;
    liveBills: number;
    openDrawerSessions: number;
  };
};

type ActualTender = Pick<ApplyTenderResult, 'tenderId' | 'type' | 'amount'>;

function requiredId(ids: Record<string, string>, key: string, label: string): string {
  const id = ids[key];
  if (!id) throw new Error(`Missing demo ${label} mapping for ${key}.`);
  return id;
}

function at(value: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error(`Invalid demo timestamp: ${value}.`);
  return result;
}

const minusMinutes = (value: Date, minutes: number): Date =>
  new Date(value.getTime() - minutes * 60_000);

const dayKey = (branchId: string, businessDate: string): string => `${branchId}:${businessDate}`;

function operationKey(seed: DemoRestaurantSeed, ...parts: Array<string | number>): string {
  return `demo:s${seed.identity.seatNumber}:${parts.join(':')}`;
}

const MOCK_CARD_DECLINE_CENTS = new Set([13, 51, 54]);

export function safeDemoCardAmount(amount: Prisma.Decimal): Prisma.Decimal | null {
  if (!amount.greaterThan(0)) return null;
  if (!MOCK_CARD_DECLINE_CENTS.has(amount.mul(100).mod(100).toNumber())) return amount;
  const wholePkr = amount.floor();
  return wholePkr.greaterThan(0) ? wholePkr : null;
}

async function applyDemoTender(
  db: ScopedDb,
  input: {
    billId: string;
    branchId: string;
    staffProfileId: string;
    deviceId: string;
    idempotencyKey: string;
    type: 'CASH' | 'CARD';
    amount: Prisma.Decimal;
    now: Date;
  }
): Promise<ApplyTenderResult> {
  const actor = {
    staffProfileId: input.staffProfileId,
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey,
  };
  const command = {
    billId: input.billId,
    branchId: input.branchId,
    actor,
    now: input.now,
  };
  if (input.type === 'CASH') {
    return applyTender(db, {
      ...command,
      tender: {
        type: 'CASH',
        amount: input.amount,
        cashReceived: input.amount,
      },
    });
  }

  return applyTender(db, {
    ...command,
    tender: { type: 'CARD', amount: input.amount },
  });
}

export async function seedDemoRestaurantHistory(
  db: ScopedDb,
  seed: DemoRestaurantSeed,
  catalog: DemoRestaurantCatalogIds,
  context: TRPCContext,
  operations: DemoRestaurantOperationsIds
): Promise<DemoRestaurantHistoryIds> {
  if (context.db !== db) {
    throw new Error('History seeding requires context.db to be the provided scoped transaction.');
  }
  if (operations.managerStaffProfileId === operations.approverStaffProfileId) {
    throw new Error('Restaurant demo refunds and close corrections require a distinct approver.');
  }
  if (
    context.organization?.id !== seed.identity.organizationId ||
    context.organization.isDemo !== true ||
    !(await isDemoTenant(db))
  ) {
    throw new Error(
      'History fixture tax profiles may only be published for the active demo tenant.'
    );
  }

  const ids: DemoRestaurantHistoryIds = {
    taxProfile: {},
    publication: {},
    posDevice: {},
    kdsDevice: {},
    deliveryZone: {},
    deliveryAddress: {},
    deliveryFulfillment: {},
    order: {},
    orderItem: {},
    bill: {},
    settlement: {},
    refund: {},
    dailyClose: {},
    dailyCloseCorrection: {},
    kdsTicket: {},
    liveDrawerSessionId: '',
    counts: {
      taxProfiles: 0,
      devices: 0,
      deliveryZones: 0,
      deliveryAddresses: 0,
      deliveryFulfillments: 0,
      historicalOrders: 0,
      historicalOrderLines: 0,
      bills: 0,
      tenders: 0,
      cashTenders: 0,
      cardTenders: 0,
      refunds: 0,
      historicalDrawerSessions: 0,
      dailyCloses: 0,
      dailyCloseCorrections: 0,
      kdsTickets: 0,
      liveOrders: 0,
      liveBills: 0,
      openDrawerSessions: 0,
    },
  };
  const limits = context.entitlements.limits as Readonly<Record<string, number>>;
  const publications = await db.restaurantBranchMenuPublication.findMany({
    where: {
      branchId: { in: Object.values(catalog.branch) },
      status: 'PUBLISHED',
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, branchId: true, status: true },
  });
  const firstBusinessDate = seed.historicalBusinessDates[0];
  if (!firstBusinessDate) throw new Error('Demo history requires at least one business date.');
  const taxEffectiveFrom = at(`${firstBusinessDate}T00:00:00+05:00`);
  const taxRules = (['CASH', 'CARD', 'OTHER'] as const).map((paymentCategory) => ({
    ruleCode: `DEMO_SYNTHETIC_${paymentCategory}`,
    paymentCategory,
    rate: '0.160000',
    priceMode: 'INCLUSIVE' as const,
  }));
  const syntheticSource = {
    authorityCode: 'DEMO-SYNTHETIC-NON-AUTHORITY',
    documentTitle: 'Synthetic demo tax fixture - not legal or compliance guidance',
    sourceUrl: 'https://demo.invalid/synthetic-tax-fixture',
    contentHash: createHash('sha256')
      .update('DEMO SYNTHETIC TAX FIXTURE; NOT AN OFFICIAL OR COMPLIANCE SOURCE')
      .digest('hex'),
    retrievedAt: taxEffectiveFrom,
  };

  for (const branch of seed.branches) {
    const branchId = requiredId(catalog.branch, branch.id, 'branch');
    const taxProfileMetadata = {
      profileName: 'DEMO SYNTHETIC 16% INCLUSIVE - NOT TAX OR COMPLIANCE GUIDANCE',
      jurisdictionCode: branch.city === 'Karachi' ? 'PK-SD' : 'PK-PB',
      priceMode: 'INCLUSIVE',
      evidenceKind: 'CUSTOMER_SUPPLIED',
    } as const;
    const taxPayloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          branchDescriptorId: branch.id,
          effectiveFrom: taxEffectiveFrom.toISOString(),
          rules: taxRules,
          taxProfileMetadata,
          eligibilityEvidence: {
            kind: 'DEMO_SYNTHETIC',
            complianceAuthority: false,
            note: 'Fictional restaurant demo data; not tax or legal guidance.',
          },
        })
      )
      .digest('hex');
    const publishedTax = await publishTaxProfile(db as unknown as Prisma.TransactionClient, {
      organizationId: seed.identity.organizationId,
      branchId,
      effectiveFrom: taxEffectiveFrom,
      approvalReference: `DEMO-SYNTHETIC-NON-COMPLIANCE-S${seed.identity.seatNumber}`,
      idempotencyKey: operationKey(seed, 'tax-profile', branch.id),
      payloadHash: taxPayloadHash,
      source: syntheticSource,
      rules: taxRules,
      eligibilityEvidence: {
        kind: 'DEMO_SYNTHETIC',
        complianceAuthority: false,
        note: 'Fictional restaurant demo data; not tax or legal guidance.',
      },
      ...taxProfileMetadata,
      replaceOpenProfile: false,
    });
    if (publishedTax.kind !== 'created' && publishedTax.kind !== 'replay') {
      throw new Error(`Synthetic demo tax profile publication is occupied for ${branch.name}.`);
    }
    ids.taxProfile[branch.id] = publishedTax.profile.id;
    ids.counts.taxProfiles += 1;

    const publication = publications.find(
      (candidate) => candidate.branchId === branchId && candidate.status === 'PUBLISHED'
    );
    if (!publication) throw new Error(`Missing published demo menu for ${branch.name}.`);
    ids.publication[branch.id] = publication.id;

    const { device: posDevice } = await enrollDevice(db, {
      branchId,
      name: `Demo POS S${seed.identity.seatNumber} ${branch.name}`,
      kind: 'POS',
    });
    const { device: kdsDevice } = await enrollDevice(db, {
      branchId,
      name: `Demo KDS S${seed.identity.seatNumber} ${branch.name}`,
      kind: 'KDS',
      stationId: requiredId(catalog.station, `${branch.id}:HOT_KITCHEN`, 'hot-kitchen station'),
    });
    ids.posDevice[branch.id] = posDevice.id;
    ids.kdsDevice[branch.id] = kdsDevice.id;
    ids.counts.devices += 2;

    const zone = await createDeliveryZone(db, {
      organizationId: seed.identity.organizationId,
      branchId,
      name: `${branch.name} demo delivery area`,
      fixedFee: '0',
      promisedMinutes: 45,
      sortOrder: 0,
      areaPostalLabel: branch.city,
    });
    ids.deliveryZone[branch.id] = zone.id;
    ids.counts.deliveryZones += 1;
  }

  for (const branch of seed.branches) {
    for (const channel of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as const) {
      const sample = seed.sales.historicalOrders.find(
        (order) => order.branchId === branch.id && order.channel === channel
      );
      if (sample) {
        await buildEffectiveMenu(
          db,
          requiredId(ids.publication, branch.id, 'publication'),
          channel,
          at(sample.placedAt)
        );
      }
    }
  }

  const orderGroups = new Map<string, HistoricalOrder[]>();
  for (const order of seed.sales.historicalOrders) {
    const key = dayKey(order.branchId, order.businessDate);
    const group = orderGroups.get(key);
    if (group) group.push(order);
    else orderGroups.set(key, [order]);
  }
  const billByOrder = new Map(seed.sales.bills.map((bill) => [bill.orderId, bill] as const));
  const settlementsByOrder = new Map<string, Settlement[]>();
  for (const settlement of seed.sales.settlements) {
    const group = settlementsByOrder.get(settlement.orderId);
    if (group) group.push(settlement);
    else settlementsByOrder.set(settlement.orderId, [settlement]);
  }
  const refundsByOrder = new Map(
    seed.sales.refunds.map((refund) => [refund.orderId, refund] as const)
  );
  const customerById = new Map(
    seed.loyalty.customers.map((customer) => [customer.id, customer] as const)
  );
  const actualTenderByDescriptor = new Map<string, ActualTender>();
  const deliveryAddressByCustomer = new Map<string, string>();
  let historicalOrdinal = 0;

  const noteTender = (result: ApplyTenderResult): void => {
    ids.counts.tenders += 1;
    if (result.type === 'CASH') ids.counts.cashTenders += 1;
    else if (result.type === 'CARD') ids.counts.cardTenders += 1;
  };

  for (const closeDescriptor of seed.sales.dailyCloses) {
    const branchDescriptor = seed.branches.find((branch) => branch.id === closeDescriptor.branchId);
    if (!branchDescriptor) throw new Error(`Missing demo branch ${closeDescriptor.branchId}.`);
    const branchId = requiredId(catalog.branch, closeDescriptor.branchId, 'branch');
    const posDeviceId = requiredId(ids.posDevice, closeDescriptor.branchId, 'POS device');
    const drawerActor = {
      staffProfileId: operations.managerStaffProfileId,
      deviceId: posDeviceId,
      idempotencyKey: operationKey(
        seed,
        'drawer-open',
        closeDescriptor.branchId,
        closeDescriptor.businessDate
      ),
    };
    const openingFloat = new Prisma.Decimal(5_000);
    const drawer = await openDrawerSession(db, {
      organizationId: seed.identity.organizationId,
      entitlementLimits: limits,
      branchId,
      openingFloat,
      actor: drawerActor,
      now: new Date(`${closeDescriptor.businessDate}T01:00:00.000Z`),
    });
    ids.counts.historicalDrawerSessions += 1;
    let expectedCash = openingFloat;

    for (const order of orderGroups.get(
      dayKey(closeDescriptor.branchId, closeDescriptor.businessDate)
    ) ?? []) {
      historicalOrdinal += 1;
      const placedAt = at(order.placedAt);
      const completedAt = at(order.completedAt);
      const customerDescriptorId =
        order.customerId ??
        (order.channel === 'DELIVERY'
          ? seed.loyalty.customers[historicalOrdinal % seed.loyalty.customers.length]!.id
          : null);
      const customerId = customerDescriptorId
        ? requiredId(operations.customer, customerDescriptorId, 'customer')
        : null;
      const opened = await openOrder(db, {
        organizationId: seed.identity.organizationId,
        entitlementLimits: limits,
        branchId,
        channel: order.channel,
        customerId,
        publicationId: requiredId(ids.publication, order.branchId, 'publication'),
        tableIds: order.tableId
          ? [requiredId(catalog.table, order.tableId, 'restaurant table')]
          : [],
        coverCount: order.channel === 'DINE_IN' ? 2 : null,
        serverStaffProfileId: operations.managerStaffProfileId,
        actor: {
          staffProfileId: operations.managerStaffProfileId,
          deviceId: posDeviceId,
          idempotencyKey: operationKey(seed, 'order-open', historicalOrdinal),
        },
        now: placedAt,
      });
      ids.order[order.id] = opened.orderId;
      ids.counts.historicalOrders += 1;

      const itemIds: string[] = [];
      for (const [lineIndex, line] of order.lines.entries()) {
        const item = await addItem(db, {
          orderId: opened.orderId,
          menuItemId: requiredId(catalog.menuItem, line.variantId, 'menu item'),
          quantity: line.quantity,
          modifierOptionIds: line.modifiers.map((modifier) =>
            requiredId(catalog.modifierOption, modifier.optionId, 'modifier option')
          ),
          actor: {
            staffProfileId: operations.managerStaffProfileId,
            deviceId: posDeviceId,
            idempotencyKey: operationKey(seed, 'item-add', historicalOrdinal, lineIndex),
          },
          now: placedAt,
        });
        ids.orderItem[line.id] = item.itemId;
        itemIds.push(item.itemId);
        ids.counts.historicalOrderLines += 1;
      }

      let fulfillmentId: string | null = null;
      if (order.channel === 'DELIVERY') {
        if (!customerDescriptorId || !customerId) {
          throw new Error(`Delivery order ${order.id} has no persisted customer.`);
        }
        let addressId = deliveryAddressByCustomer.get(customerId);
        if (!addressId) {
          const customer = customerById.get(customerDescriptorId);
          if (!customer) throw new Error(`Missing delivery customer ${customerDescriptorId}.`);
          const address = await createDeliveryAddress(db, {
            organizationId: seed.identity.organizationId,
            customerId,
            label: 'Demo home',
            recipientName: customer.name,
            phone: customer.phone,
            addressLine1: `Demo address S${seed.identity.seatNumber}`,
            locality: branchDescriptor.city,
            administrativeArea: branchDescriptor.city,
            countryCode: 'PK',
            isDefault: true,
          });
          addressId = address.id;
          deliveryAddressByCustomer.set(customerId, addressId);
          ids.deliveryAddress[customerDescriptorId] = addressId;
          ids.counts.deliveryAddresses += 1;
        }
        const fulfillment = await createDeliveryFulfillment(db, {
          organizationId: seed.identity.organizationId,
          branchId,
          customerId,
          orderId: opened.orderId,
          addressId,
          zoneId: requiredId(ids.deliveryZone, order.branchId, 'delivery zone'),
          deviceId: posDeviceId,
          idempotencyKey: operationKey(seed, 'delivery-attach', historicalOrdinal),
          now: placedAt,
        });
        fulfillmentId = fulfillment.id;
        ids.deliveryFulfillment[order.id] = fulfillment.id;
        ids.counts.deliveryFulfillments += 1;
      }

      const sent = await sendOrder(db, {
        orderId: opened.orderId,
        actor: {
          staffProfileId: operations.managerStaffProfileId,
          deviceId: posDeviceId,
          idempotencyKey: operationKey(seed, 'order-send', historicalOrdinal),
        },
      });
      sent.tickets.forEach((ticket, ticketIndex) => {
        ids.kdsTicket[`${order.id}:${ticketIndex}`] = ticket.ticketId;
      });
      ids.counts.kdsTickets += sent.tickets.length;

      const kdsDeviceId = requiredId(ids.kdsDevice, order.branchId, 'KDS device');
      for (const [lineIndex, itemId] of itemIds.entries()) {
        for (const status of ['FIRING', 'PREPARED', 'SERVED'] as const) {
          await advanceItem(db, {
            orderId: opened.orderId,
            itemId,
            toStatus: status,
            actor: {
              staffProfileId: operations.managerStaffProfileId,
              deviceId: kdsDeviceId,
              idempotencyKey: operationKey(
                seed,
                'item-advance',
                historicalOrdinal,
                lineIndex,
                status
              ),
            },
          });
        }
      }

      if (!fulfillmentId) {
        await closeOrder(db, {
          orderId: opened.orderId,
          now: completedAt,
          actor: {
            staffProfileId: operations.managerStaffProfileId,
            deviceId: posDeviceId,
            idempotencyKey: operationKey(seed, 'order-payment-pending', historicalOrdinal),
          },
        });
      }

      const cut = await cutBills(db, {
        orderId: opened.orderId,
        branchId,
        split: { kind: 'NONE' },
        actor: {
          staffProfileId: operations.managerStaffProfileId,
          deviceId: posDeviceId,
          idempotencyKey: operationKey(seed, 'bill-cut', historicalOrdinal),
        },
      });
      if (cut.billIds.length !== 1) throw new Error(`Demo order ${order.id} did not cut one bill.`);
      const billId = cut.billIds[0]!;
      const billDescriptor = billByOrder.get(order.id);
      if (!billDescriptor) throw new Error(`Missing demo bill descriptor for ${order.id}.`);
      ids.bill[billDescriptor.id] = billId;
      ids.counts.bills += 1;

      const summary = await getOrderSettlementForBranch(db, opened.orderId, branchId);
      const summaryBill = summary?.bills.find((candidate) => candidate.id === billId);
      if (!summaryBill) throw new Error(`Missing settlement read model for ${billDescriptor.id}.`);
      const scriptedSettlements = settlementsByOrder.get(order.id) ?? [];
      if (scriptedSettlements.length === 0) {
        throw new Error(`Missing demo tender descriptor for ${order.id}.`);
      }
      let remaining = new Prisma.Decimal(summaryBill.grandTotal);
      for (const [settlementIndex, settlement] of scriptedSettlements.entries()) {
        const desiredAmount =
          settlementIndex === 0 && scriptedSettlements.length > 1
            ? remaining.mul('0.42').toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN)
            : remaining;
        if (!desiredAmount.greaterThan(0)) {
          throw new Error(`Demo settlement ${settlement.id} has no amount due.`);
        }
        const safeCardAmount =
          settlement.method === 'CARD' ? safeDemoCardAmount(desiredAmount) : null;
        const tenderType = safeCardAmount ? 'CARD' : 'CASH';
        const result = await applyDemoTender(db, {
          billId,
          branchId,
          staffProfileId: operations.managerStaffProfileId,
          deviceId: posDeviceId,
          idempotencyKey: operationKey(seed, 'tender', historicalOrdinal, settlementIndex),
          type: tenderType,
          amount: safeCardAmount ?? desiredAmount,
          now: completedAt,
        });
        ids.settlement[settlement.id] = result.tenderId;
        actualTenderByDescriptor.set(settlement.id, result);
        noteTender(result);
        if (result.type === 'CASH') expectedCash = expectedCash.plus(result.amount);
        remaining = result.remainingDue;
      }
      for (let balanceIndex = 0; !remaining.isZero(); balanceIndex += 1) {
        if (balanceIndex > 2) {
          throw new Error(
            `Demo bill ${billDescriptor.id} did not settle in three balance tenders.`
          );
        }
        const descriptor = scriptedSettlements.at(-1)!;
        const safeCardAmount = descriptor.method === 'CARD' ? safeDemoCardAmount(remaining) : null;
        const tenderType = safeCardAmount ? 'CARD' : 'CASH';
        const result = await applyDemoTender(db, {
          billId,
          branchId,
          staffProfileId: operations.managerStaffProfileId,
          deviceId: posDeviceId,
          idempotencyKey: operationKey(seed, 'tender-balance', historicalOrdinal, balanceIndex),
          type: tenderType,
          amount: safeCardAmount ?? remaining,
          now: completedAt,
        });
        ids.settlement[`${descriptor.id}:balance:${balanceIndex}`] = result.tenderId;
        noteTender(result);
        if (result.type === 'CASH') expectedCash = expectedCash.plus(result.amount);
        remaining = result.remainingDue;
      }
      if (!remaining.isZero()) throw new Error(`Demo bill ${billDescriptor.id} remains unsettled.`);

      if (fulfillmentId) {
        await transitionDeliveryFulfillment(db, {
          organizationId: seed.identity.organizationId,
          branchId,
          fulfillmentId,
          status: 'DISPATCHED',
          now: minusMinutes(completedAt, 2),
        });
        await transitionDeliveryFulfillment(db, {
          organizationId: seed.identity.organizationId,
          branchId,
          fulfillmentId,
          status: 'DELIVERED',
          now: minusMinutes(completedAt, 1),
        });
      }

      await closeOrder(db, {
        orderId: opened.orderId,
        now: completedAt,
        actor: {
          staffProfileId: operations.managerStaffProfileId,
          deviceId: posDeviceId,
          idempotencyKey: operationKey(seed, 'order-close', historicalOrdinal),
        },
      });

      const refundDescriptor = refundsByOrder.get(order.id);
      if (refundDescriptor) {
        const original = actualTenderByDescriptor.get(refundDescriptor.settlementId);
        if (!original) throw new Error(`Missing refund tender ${refundDescriptor.settlementId}.`);
        const amount = original.amount.mul('0.25').toDecimalPlaces(2);
        const refunded = await refundTender(db, {
          originalTenderId: original.tenderId,
          amount,
          reason: refundDescriptor.reason,
          branchId,
          approvingStaffProfileId: operations.approverStaffProfileId,
          actor: {
            staffProfileId: operations.managerStaffProfileId,
            deviceId: posDeviceId,
            idempotencyKey: operationKey(seed, 'refund', historicalOrdinal),
          },
          now: at(refundDescriptor.refundedAt),
        });
        ids.refund[refundDescriptor.id] = refunded.refundId;
        ids.counts.refunds += 1;
        if (original.type === 'CASH') expectedCash = expectedCash.minus(refunded.amount);
      }
    }

    const drawerClosed = await closeDrawerSession(db, {
      drawerSessionId: drawer.drawerSessionId,
      countedCash: expectedCash,
      actor: {
        staffProfileId: operations.managerStaffProfileId,
        deviceId: posDeviceId,
        idempotencyKey: operationKey(
          seed,
          'drawer-close',
          closeDescriptor.branchId,
          closeDescriptor.businessDate
        ),
      },
      now: at(closeDescriptor.closedAt),
    });
    if (!drawerClosed.expectedCash.equals(expectedCash)) {
      throw new Error(`Drawer ledger mismatch for ${closeDescriptor.businessDate}.`);
    }

    const cut = await cutClose(db, {
      branchId,
      businessDate: closeDescriptor.businessDate,
      actor: {
        staffProfileId: operations.managerStaffProfileId,
        deviceId: posDeviceId,
        idempotencyKey: operationKey(
          seed,
          'day-close',
          closeDescriptor.branchId,
          closeDescriptor.businessDate
        ),
      },
    });
    ids.dailyClose[closeDescriptor.id] = cut.dailyCloseId;
    ids.counts.dailyCloses += 1;
    let tipId = cut.dailyCloseId;
    for (const correction of closeDescriptor.corrections) {
      const corrected = await correctClose(db, {
        branchId,
        businessDate: closeDescriptor.businessDate,
        supersedesCloseId: tipId,
        reason: correction.reason,
        approvingStaffProfileId: operations.approverStaffProfileId,
        actor: {
          staffProfileId: operations.managerStaffProfileId,
          deviceId: posDeviceId,
          idempotencyKey: operationKey(
            seed,
            'day-correct',
            closeDescriptor.branchId,
            closeDescriptor.businessDate,
            correction.sequence
          ),
        },
      });
      tipId = corrected.dailyCloseId;
      ids.dailyCloseCorrection[correction.id] = corrected.dailyCloseId;
      ids.counts.dailyCloseCorrections += 1;
    }
  }

  const liveOrderByStatus = new Map<LiveOrder['status'], LiveOrder>(
    seed.sales.liveOrders.map((order) => [order.status, order])
  );
  for (const live of seed.sales.liveOrders) {
    const liveIndex = live.status === 'IN_PREPARATION' ? 'kds' : 'payment';
    const branchId = requiredId(catalog.branch, live.branchId, 'branch');
    const posDeviceId = requiredId(ids.posDevice, live.branchId, 'POS device');
    const openedAt = at(live.openedAt);
    const opened = await openOrder(db, {
      organizationId: seed.identity.organizationId,
      entitlementLimits: limits,
      branchId,
      channel: live.channel,
      publicationId: requiredId(ids.publication, live.branchId, 'publication'),
      tableIds: live.tableId ? [requiredId(catalog.table, live.tableId, 'restaurant table')] : [],
      coverCount: 2,
      serverStaffProfileId: operations.managerStaffProfileId,
      actor: {
        staffProfileId: operations.managerStaffProfileId,
        deviceId: posDeviceId,
        idempotencyKey: operationKey(seed, 'live-open', liveIndex),
      },
      now: openedAt,
    });
    ids.order[live.id] = opened.orderId;
    ids.counts.liveOrders += 1;

    const itemIds: string[] = [];
    for (const [lineIndex, line] of live.lines.entries()) {
      const item = await addItem(db, {
        orderId: opened.orderId,
        menuItemId: requiredId(catalog.menuItem, line.variantId, 'menu item'),
        quantity: line.quantity,
        modifierOptionIds: line.modifiers.map((modifier) =>
          requiredId(catalog.modifierOption, modifier.optionId, 'modifier option')
        ),
        actor: {
          staffProfileId: operations.managerStaffProfileId,
          deviceId: posDeviceId,
          idempotencyKey: operationKey(seed, 'live-item', liveIndex, lineIndex),
        },
        now: openedAt,
      });
      ids.orderItem[line.id] = item.itemId;
      itemIds.push(item.itemId);
    }
    const sent = await sendOrder(db, {
      orderId: opened.orderId,
      actor: {
        staffProfileId: operations.managerStaffProfileId,
        deviceId: posDeviceId,
        idempotencyKey: operationKey(seed, 'live-send', liveIndex),
      },
    });
    ids.counts.kdsTickets += sent.tickets.length;

    if (live.status === 'IN_PREPARATION') {
      for (const [lineIndex, itemId] of itemIds.entries()) {
        await advanceItem(db, {
          orderId: opened.orderId,
          itemId,
          toStatus: 'FIRING',
          actor: {
            staffProfileId: operations.managerStaffProfileId,
            deviceId: requiredId(ids.kdsDevice, live.branchId, 'KDS device'),
            idempotencyKey: operationKey(seed, 'live-fire', lineIndex),
          },
        });
      }
      const descriptor = seed.sales.kdsTickets.find((ticket) => ticket.orderId === live.id);
      if (descriptor && sent.tickets[0]) ids.kdsTicket[descriptor.id] = sent.tickets[0].ticketId;
      continue;
    }

    for (const [lineIndex, itemId] of itemIds.entries()) {
      for (const status of ['FIRING', 'PREPARED', 'SERVED'] as const) {
        await advanceItem(db, {
          orderId: opened.orderId,
          itemId,
          toStatus: status,
          actor: {
            staffProfileId: operations.managerStaffProfileId,
            deviceId: requiredId(ids.kdsDevice, live.branchId, 'KDS device'),
            idempotencyKey: operationKey(seed, 'live-advance', lineIndex, status),
          },
        });
      }
    }
    await closeOrder(db, {
      orderId: opened.orderId,
      now: openedAt,
      actor: {
        staffProfileId: operations.managerStaffProfileId,
        deviceId: posDeviceId,
        idempotencyKey: operationKey(seed, 'live-payment-pending'),
      },
    });
    const cut = await cutBills(db, {
      orderId: opened.orderId,
      branchId,
      split: { kind: 'NONE' },
      actor: {
        staffProfileId: operations.managerStaffProfileId,
        deviceId: posDeviceId,
        idempotencyKey: operationKey(seed, 'live-bill'),
      },
    });
    if (cut.billIds.length !== 1) throw new Error('Live payment order did not cut one bill.');
    ids.bill[live.bill.id] = cut.billIds[0]!;
    ids.counts.liveBills += 1;
  }

  const paymentLive = liveOrderByStatus.get('PAYMENT_PENDING');
  if (!paymentLive) throw new Error('Restaurant demo requires a payment-pending live order.');
  const liveDrawer = await openDrawerSession(db, {
    organizationId: seed.identity.organizationId,
    entitlementLimits: limits,
    branchId: requiredId(catalog.branch, paymentLive.branchId, 'branch'),
    openingFloat: '5000',
    actor: {
      staffProfileId: operations.managerStaffProfileId,
      deviceId: requiredId(ids.posDevice, paymentLive.branchId, 'POS device'),
      idempotencyKey: operationKey(seed, 'live-drawer-open'),
    },
    now: at(seed.generatedAt),
  });
  ids.liveDrawerSessionId = liveDrawer.drawerSessionId;
  ids.counts.openDrawerSessions = 1;

  const expectedCorrections = seed.sales.dailyCloses.reduce(
    (total, close) => total + close.corrections.length,
    0
  );
  if (
    ids.counts.taxProfiles !== seed.branches.length ||
    ids.counts.historicalOrders !== seed.sales.historicalOrders.length ||
    ids.counts.historicalOrderLines !==
      seed.sales.historicalOrders.reduce((total, order) => total + order.lines.length, 0) ||
    ids.counts.bills !== seed.sales.bills.length ||
    seed.sales.settlements.some((settlement) => !ids.settlement[settlement.id]) ||
    ids.counts.refunds !== seed.sales.refunds.length ||
    ids.counts.dailyCloses !== seed.sales.dailyCloses.length ||
    ids.counts.dailyCloseCorrections !== expectedCorrections ||
    ids.counts.liveOrders !== seed.sales.liveOrders.length
  ) {
    throw new Error('Restaurant demo history did not persist every required descriptor.');
  }
  return ids;
}
