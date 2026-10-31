// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db as runtimeDb } from '@/lib/db';
import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  createChronicRefillSubscription,
  createDueChronicRefillOrder,
  listChronicRefillSubscriptions,
  processDueChronicRefills,
  updateChronicRefillSubscription,
} from './chronic-refills';
import { writePatientConsent } from './consent-writer';
import {
  placeCustomerOrder,
  startCustomerOrderCheckout,
  transitionCustomerOrder,
} from './customer-ordering';
import { addSaleLine, createSale } from './sales';
import { applyPharmacyTender } from './settlement';
import { approveChronicRefillAsOwner } from './chronic-refill-owner-approval';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { receiveLot } from './stock-ledger';
import { MockWhatsAppProvider, readWhatsAppConfig } from './whatsapp/provider';
import { processDueWhatsAppRefillReminders } from './whatsapp/refill-reminders';

// Exercise messaging eligibility independently of plan provisioning.
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({}),
}));

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const organizationId = `org_refill_${suffix}`;
const branchId = `branch_refill_${suffix}`;
const actorId = `actor_refill_${suffix}`;
const cashierId = `cashier_refill_${suffix}`;
const scope = { organizationId, branchId, actorId };
const now = new Date();
now.setUTCHours(12, 0, 0, 0);
const DAY = 86_400_000;

type Item = { medicineId: string; presentationId: string; packLevelId: string };
let otc: Item;
let rx: Item;
let patientId: string;
let customerId: string;
let prescriptionLineId: string;
let consentId: string;

const tenant = <T>(run: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(organizationId, run, { userId: actorId });

function subscribe(
  item: Item,
  extra: Partial<Parameters<typeof createChronicRefillSubscription>[2]> = {}
) {
  return tenant((db) =>
    createChronicRefillSubscription(db, scope, {
      customerId,
      ...item,
      quantityPacks: 1,
      fulfillment: 'COLLECT',
      paymentMode: 'KHATA',
      cadenceDays: 30,
      nextDueAt: now,
      ...extra,
    })
  );
}

beforeAll(async () => {
  if (!databaseUrl) return;
  await assertRlsEnforcingRole(withPlatformDb);
  await withPlatformDb((db) =>
    db.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: 'Refill test',
        displayName: 'Refill test',
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: 'UTC',
      },
    })
  );
  await tenant(async (db) => {
    await db.organizationDepartment.create({ data: { organizationId, key: 'QA', name: 'QA' } });
    const role = await db.organizationRole.create({
      data: {
        organizationId,
        key: 'refill-staff',
        name: 'Refill staff',
        // Releasing an Rx cycle needs the same grant as selling an Rx line.
        permissions: {
          create: [
            { organizationId, capability: 'pharmacy:orders', effect: 'ALLOW' },
            { organizationId, capability: 'pharmacy:dispense', effect: 'ALLOW' },
          ],
        },
      },
    });
    for (const id of [actorId, cashierId])
      await db.user.create({
        data: {
          id,
          organizationId,
          organizationRoleId: role.id,
          name: 'Refill staff',
          email: `${id}@example.test`,
          department: 'QA',
          title: 'Staff',
          status: 'ACTIVE',
        },
      });
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: 'MAIN',
        name: 'Main',
        addressLine: '1 Test',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    await db.pharmacyBranchAssignment.create({
      data: { organizationId, branchId, userId: actorId },
    });
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: 'Synthetic', phone: '03001234567' },
    });
    patientId = patient.id;
    const customer = await db.pharmacyCustomer.create({
      data: { organizationId, patientId, displayName: 'Synthetic', whatsappOptIn: true },
    });
    customerId = customer.id;
    const location = await db.pharmacyStockLocation.create({
      data: { organizationId, branchId, code: 'STORE', name: 'Store', kind: 'STORE' },
    });
    for (const isRx of [false, true]) {
      const medicine = await db.medicine.create({
        data: {
          organizationId,
          productName: isRx ? 'Synthetic Rx' : 'Synthetic OTC',
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          otc: !isRx,
          rx: isRx,
          presentations: { create: { organizationId, presentation: 'Tablets' } },
        },
        include: { presentations: true },
      });
      const presentationId = medicine.presentations[0]!.id;
      const pack = await db.packLevel.create({
        data: {
          organizationId,
          presentationId,
          versionGroupId: randomUUID(),
          version: 1,
          level: 'STRIP',
          unitsPerParent: 10,
          effectiveFrom: new Date(now.getTime() - DAY),
        },
      });
      const expiresAt = new Date(now.getTime() + 365 * DAY);
      const batch = await db.pharmacyManufacturingBatch.create({
        data: { organizationId, medicineId: medicine.id, batchNumber: randomUUID(), expiresAt },
      });
      await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Synthetic',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 100,
        printedMrpMinor: 2000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 1000,
        idempotencyKey: randomUUID(),
        receivedAt: new Date(now.getTime() - DAY),
      });
      const item = { medicineId: medicine.id, presentationId, packLevelId: pack.id };
      if (isRx) rx = item;
      else otc = item;
    }
    const prescriber = await db.pharmacyPrescriber.create({
      data: { organizationId, name: 'Synthetic', registrationNumber: randomUUID() },
    });
    const prescription = await db.prescription.create({
      data: {
        organizationId,
        patientId,
        prescriberId: prescriber.id,
        sourceKind: 'PAPER_IMAGE',
        sourceFileRef: 'synthetic',
        validFrom: new Date(now.getTime() - DAY),
        validUntil: new Date(now.getTime() + 365 * DAY),
        authorizedRepeats: 10,
        capturedByUserId: actorId,
      },
    });
    const line = await db.prescriptionLine.create({
      data: {
        organizationId,
        prescriptionId: prescription.id,
        lineNumber: 1,
        medicineId: rx.medicineId,
        presentationId: rx.presentationId,
        authorizedCanonicalUnits: 100,
        directions: 'Daily',
      },
    });
    prescriptionLineId = line.id;
    const consent = await writePatientConsent(
      db,
      organizationId,
      actorId,
      { patientId, purpose: 'REMINDERS', channel: 'WHATSAPP', granted: true },
      new Date(now.getTime() - DAY)
    );
    consentId = consent.id;
  });
}, 30_000);

afterAll(async () => {
  if (databaseUrl) await runtimeDb.$disconnect();
});

async function approveRx() {
  return tenant(async (db) => {
    const sale = await createSale(db, scope);
    const { line } = await addSaleLine(db, scope, {
      saleId: sale.id,
      ...rx,
      saleUnit: 'PACK',
      quantity: 1,
      canonicalUnitsPerSaleUnit: 10,
      idempotencyKey: randomUUID(),
    });
    const item = await db.pharmacyPharmacistReviewItem.create({
      data: {
        organizationId,
        prescriptionLineId,
        saleLineId: line.id,
        requestedByUserId: cashierId,
      },
    });
    const decision = await db.pharmacyPharmacistReviewDecision.create({
      data: {
        organizationId,
        reviewItemId: item.id,
        kind: 'SIGN',
        actorUserId: actorId,
        signedAt: now,
      },
    });
    return Object.assign(decision, { saleId: sale.id });
  });
}

describeIfDatabase('chronic refill runtime regressions', () => {
  it('discovers subscriptions in platform scope and creates automatic orders as their staff actor', async () => {
    const subscription = await subscribe(otc);
    const visible = await withPlatformDb((db) => listChronicRefillSubscriptions(db, scope));
    expect(visible).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: subscription.id })])
    );
    const result = await processDueChronicRefills({ now });
    expect(result.created).toBeGreaterThan(0);
    const cycles = await tenant(
      (db) => db.$queryRaw<{ orderId: string }[]>`
      SELECT "orderId" FROM pharmacy_chronic_refill_cycles WHERE "subscriptionId" = ${subscription.id}
    `
    );
    expect(cycles).toHaveLength(1);
    const order = await tenant((db) =>
      db.pharmacyCustomerOrder.findUnique({ where: { id: cycles[0]!.orderId } })
    );
    expect(order).toMatchObject({ placedByUserId: actorId, intendedPaymentMethod: 'CREDIT' });
    expect(
      await withTenantDb(`other_refill_${suffix}`, (db) =>
        listChronicRefillSubscriptions(db, scope)
      )
    ).toEqual([]);
    expect(
      await withPlatformDb(
        (db) => db.$executeRaw`
        UPDATE pharmacy_chronic_refill_subscriptions SET "cadenceDays" = 10
        WHERE id = ${subscription.id}
      `
      )
    ).toBe(0);
  });

  it('rejects missing approval with a domain error instead of invalid SQL', async () => {
    const subscription = await subscribe(rx, { prescriptionLineId });
    await expect(
      tenant((db) =>
        createDueChronicRefillOrder(db, scope, {
          subscriptionId: subscription.id,
          pharmacistDecisionId: 'missing',
          now,
        })
      )
    ).rejects.toMatchObject({ reason: 'PHARMACIST_APPROVAL_REQUIRED' });
  });

  it.each(['COLLECT', 'DELIVER'] as const)(
    'carries a signed Rx cycle through %s handoff and checkout',
    async (fulfillment) => {
      const subscription = await subscribe(rx, {
        prescriptionLineId,
        fulfillment,
        ...(fulfillment === 'DELIVER' ? { addressLine: '1 Test', city: 'Lahore' } : {}),
      });
      const approval = await approveRx();
      const { order } = await tenant((db) =>
        createDueChronicRefillOrder(db, scope, {
          subscriptionId: subscription.id,
          pharmacistDecisionId: approval.id,
          now,
        })
      );
      expect(order).not.toBeNull();
      for (const action of ['accept', 'pack'] as const)
        await tenant((db) => transitionCustomerOrder(db, scope, { orderId: order!.id, action }));
      const handoffInput = {
        orderId: order!.id,
        action: fulfillment === 'COLLECT' ? ('ready' as const) : ('dispatch' as const),
        runnerUserId: actorId,
      };
      // Approval must not make controlled stock eligible for handoff.
      await tenant((db) =>
        db.medicine.update({ where: { id: rx.medicineId }, data: { controlled: true } })
      );
      try {
        await expect(
          tenant((db) => transitionCustomerOrder(db, scope, handoffInput))
        ).rejects.toMatchObject({ reason: 'RESERVATION_UNAVAILABLE' });
      } finally {
        await tenant((db) =>
          db.medicine.update({ where: { id: rx.medicineId }, data: { controlled: false } })
        );
      }
      const handoff = await tenant((db) => transitionCustomerOrder(db, scope, handoffInput));
      expect(handoff?.status).toBe(
        fulfillment === 'COLLECT' ? 'READY_FOR_COLLECTION' : 'OUT_FOR_DELIVERY'
      );
      await tenant((db) =>
        db.medicine.update({ where: { id: rx.medicineId }, data: { saleable: false } })
      );
      try {
        await expect(
          tenant((db) => startCustomerOrderCheckout(db, scope, order!.id))
        ).rejects.toMatchObject({ reason: 'RESERVATION_UNAVAILABLE' });
      } finally {
        await tenant((db) =>
          db.medicine.update({ where: { id: rx.medicineId }, data: { saleable: true } })
        );
      }
      const checkout = await tenant((db) => startCustomerOrderCheckout(db, scope, order!.id));
      expect(checkout.replayed).toBe(false);
      const lines = await tenant((db) =>
        db.pharmacySaleLine.findMany({ where: { saleId: checkout.saleId } })
      );
      // The refill dispenses against its prescription: completion records the fill.
      expect(lines).toEqual([
        expect.objectContaining({
          medicineId: rx.medicineId,
          quantity: 1,
          canonicalUnits: 10,
          prescriptionLineId,
          prescriptionPatientId: patientId,
        }),
      ]);
      const another = await subscribe(rx, { prescriptionLineId });
      await expect(
        tenant((db) =>
          createDueChronicRefillOrder(db, scope, {
            subscriptionId: another.id,
            pharmacistDecisionId: approval.id,
            now,
          })
        )
      ).rejects.toMatchObject({ reason: 'PHARMACIST_APPROVAL_REQUIRED' });
    }
  );

  it('refuses a pharmacist signature made before the subscription existed', async () => {
    const stale = await approveRx();
    const subscription = await subscribe(rx, { prescriptionLineId });
    await expect(
      tenant((db) =>
        createDueChronicRefillOrder(db, scope, {
          subscriptionId: subscription.id,
          pharmacistDecisionId: stale.id,
          now,
        })
      )
    ).rejects.toMatchObject({ reason: 'PHARMACIST_APPROVAL_REQUIRED' });
  });

  it('keeps a consumed signature from also completing its reviewed sale', async () => {
    const subscription = await subscribe(rx, { prescriptionLineId });
    const approval = await approveRx();
    await tenant((db) =>
      createDueChronicRefillOrder(db, scope, {
        subscriptionId: subscription.id,
        pharmacistDecisionId: approval.id,
        now,
      })
    );
    await expect(
      tenant(
        (db) => db.$executeRaw`
        UPDATE pharmacy_sales SET status = 'COMPLETED' WHERE id = ${approval.saleId}
      `
      )
    ).rejects.toThrow(/consumed by a chronic refill cycle/);
  });

  it('refuses Rx handoff without an approved cycle', async () => {
    const order = await tenant((db) =>
      placeCustomerOrder(db, scope, {
        customerId,
        staff: true,
        fulfillment: 'COLLECT',
        intendedPaymentMethod: 'BANK_TRANSFER',
        reviewedRx: true,
        lines: [{ ...rx, saleUnit: 'PACK', quantity: 1 }],
      })
    );
    for (const action of ['accept', 'pack'] as const)
      await tenant((db) => transitionCustomerOrder(db, scope, { orderId: order!.id, action }));
    await expect(
      tenant((db) => transitionCustomerOrder(db, scope, { orderId: order!.id, action: 'ready' }))
    ).rejects.toMatchObject({ reason: 'RESERVATION_UNAVAILABLE' });
  });

  it('releases a reviewed pack without consuming another pack or leaving the review sale open', async () => {
    const subscription = await subscribe(rx, { prescriptionLineId });
    const stock = () => tenant((db) => db.$queryRaw<{ units: number }[]>`
      SELECT SUM(balance."onHandUnits")::integer AS units FROM pharmacy_stock_balances balance
      JOIN pharmacy_inventory_lots lot ON lot."organizationId" = balance."organizationId" AND lot.id = balance."inventoryLotId"
      WHERE balance."organizationId" = ${organizationId} AND balance."branchId" = ${branchId}
        AND lot."packLevelId" = ${rx.packLevelId}
    `);
    const before = (await stock())[0]!.units;
    const approval = await approveRx();
    expect((await stock())[0]!.units).toBe(before - 10);
    const { order } = await tenant((db) => createDueChronicRefillOrder(db, scope, {
      subscriptionId: subscription.id, pharmacistDecisionId: approval.id, now,
    }));
    expect((await stock())[0]!.units).toBe(before);
    expect(await tenant((db) => db.pharmacySale.findUnique({ where: { id: approval.saleId } })))
      .toMatchObject({ status: 'VOID' });
    const reservations = await tenant((db) => db.pharmacyRestockReservation.findMany({
      where: { interest: { orderLine: { orderId: order!.id } }, status: 'RESERVED' },
    }));
    expect(reservations.reduce((sum, row) => sum + row.reservedUnits, 0)).toBe(10);
  });

  it.each([
    ['before-handoff', 'COLLECT'], ['before-handoff', 'DELIVER'],
    ['after-checkout', 'COLLECT'], ['after-checkout', 'DELIVER'],
  ] as const)('honors a refusal %s for %s', async (stage, fulfillment) => {
    const subscription = await subscribe(rx, { prescriptionLineId, fulfillment,
      ...(fulfillment === 'DELIVER' ? { addressLine: '1 Test', city: 'Lahore' } : {}),
    });
    const approval = await approveRx();
    const { order } = await tenant((db) => createDueChronicRefillOrder(db, scope, {
      subscriptionId: subscription.id, pharmacistDecisionId: approval.id, now,
    }));
    for (const action of ['accept', 'pack'] as const)
      await tenant((db) => transitionCustomerOrder(db, scope, { orderId: order!.id, action }));
    const handoff = { orderId: order!.id, runnerUserId: actorId,
      action: fulfillment === 'DELIVER' ? 'dispatch' as const : 'ready' as const };
    let saleId: string | undefined;
    if (stage === 'after-checkout') {
      await tenant((db) => transitionCustomerOrder(db, scope, handoff));
      saleId = (await tenant((db) => startCustomerOrderCheckout(db, scope, order!.id))).saleId;
    }
    await tenant((db) => db.pharmacyPharmacistReviewDecision.create({ data: {
      organizationId, reviewItemId: approval.reviewItemId, kind: 'REFUSE', actorUserId: actorId,
      reason: 'Stop this dispense',
    } }));
    if (saleId) {
      await expect(tenant((db) => applyPharmacyTender(db, scope, {
        saleId: saleId!, deviceId: `refill_device_${suffix}`, businessDate: now,
        type: 'BANK_TRANSFER', amountMinor: 2000, idempotencyKey: randomUUID(),
      }))).rejects.toThrow(/refused/);
      await expect(tenant((db) => db.$executeRaw`
        UPDATE pharmacy_sales SET status = 'COMPLETED' WHERE id = ${saleId}
      `)).rejects.toThrow(/refused/);
      await expect(tenant((db) => db.$executeRaw`
        UPDATE pharmacy_customer_orders SET status = 'COMPLETED' WHERE id = ${order!.id}
      `)).rejects.toThrow(/refused/);
      await expect(tenant((db) => startCustomerOrderCheckout(db, scope, order!.id))).rejects.toThrow(/refused/);
    } else {
      await expect(tenant((db) => transitionCustomerOrder(db, scope, handoff))).rejects.toMatchObject({ reason: 'RESERVATION_UNAVAILABLE' });
    }
  });

  it('requires owner PIN reauthentication and immutable audit for requester self-approval', async () => {
    const subscription = await subscribe(rx, { prescriptionLineId });
    const original = await tenant((db) => db.user.findUniqueOrThrow({ where: { id: actorId } }));
    const credentialHash = await hashOperatorCredential('PIN', '812679');
    const { staff, credential, review } = await tenant(async (db) => {
      const role = await db.organizationRole.create({ data: {
        organizationId, key: 'owner-operator', name: 'Owner operator',
        permissions: { create: [{ organizationId, capability: 'pharmacy:dispense', effect: 'ALLOW' }] },
      } });
      await db.user.update({ where: { id: actorId }, data: { organizationRoleId: role.id } });
      const staff = await db.restaurantStaffProfile.create({ data: { organizationId, userId: actorId, displayName: 'Solo owner' } });
      const credential = await db.restaurantOperatorCredential.create({ data: {
        organizationId, staffProfileId: staff.id, type: 'PIN', credentialHash,
      } });
      const sale = await createSale(db, scope);
      const { line } = await addSaleLine(db, scope, {
        saleId: sale.id, ...rx, saleUnit: 'PACK', quantity: 1,
        canonicalUnitsPerSaleUnit: 10, idempotencyKey: randomUUID(),
      });
      const review = await db.pharmacyPharmacistReviewItem.create({ data: {
        organizationId, prescriptionLineId, saleLineId: line.id, requestedByUserId: actorId,
      } });
      return { staff, credential, review };
    });
    try {
      await expect(tenant((db) => db.pharmacyPharmacistReviewDecision.create({ data: {
        organizationId, reviewItemId: review.id, kind: 'SIGN', actorUserId: actorId, signedAt: new Date(),
      } }))).rejects.toThrow(/cannot approve/);
      const input = { subscriptionId: subscription.id, reviewItemId: review.id,
        staffProfileId: staff.id, reason: 'Owner reviewed this refill', pin: '000000' };
      expect(await tenant((db) => approveChronicRefillAsOwner(db, scope, input))).toEqual({ blocked: true });
      expect(await tenant((db) => db.restaurantOperatorCredential.findUnique({ where: { id: credential.id } })))
        .toMatchObject({ failedAttempts: 1 });
      const released = await tenant(async (db) => {
        const approval = await approveChronicRefillAsOwner(db, scope, { ...input, pin: '812679' });
        if ('blocked' in approval) throw new Error('Owner approval unexpectedly refused');
        return createDueChronicRefillOrder(db, scope, {
          subscriptionId: subscription.id, pharmacistDecisionId: approval.decisionId, now,
        });
      });
      expect(released.order).toBeTruthy();
      const events = await tenant((db) => db.$queryRaw<{ kind: string; details: unknown }[]>`
        SELECT kind, details FROM pharmacy_chronic_refill_events WHERE "subscriptionId" = ${subscription.id}
      `);
      expect(events).toEqual([expect.objectContaining({ kind: 'OWNER_PIN_APPROVED' })]);
      expect(JSON.stringify(events)).not.toContain('812679');
    } finally {
      await tenant((db) => db.user.update({ where: { id: actorId }, data: { organizationRoleId: original.organizationRoleId } }));
    }
  });

  it('keeps refill history immutable outside the named platform purge', async () => {
    const subscription = await subscribe(otc);
    await tenant((db) => createDueChronicRefillOrder(db, scope, { subscriptionId: subscription.id, now }));
    await tenant((db) => updateChronicRefillSubscription(db, scope, { subscriptionId: subscription.id, action: 'PAUSE' }));
    for (const table of ['pharmacy_chronic_refill_cycles', 'pharmacy_chronic_refill_events']) {
      await expect(tenant(async (db) => {
        await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${organizationId}, true)`;
        await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "subscriptionId" = $1`, subscription.id);
      })).rejects.toThrow(/append-only/);
      expect(await withPlatformDb((db) => db.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "subscriptionId" = $1`, subscription.id
      ))).toBe(0);
      expect(await withPlatformDb(async (db) => {
        await db.$queryRaw`SELECT set_config('app.purging_organization_id', 'another-tenant', true)`;
        return db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "subscriptionId" = $1`, subscription.id);
      })).toBe(0);
    }
  });

  it('requires received payment before a PREPAY delivery can dispatch', async () => {
    const subscription = await subscribe(otc, {
      fulfillment: 'DELIVER', addressLine: '1 Test', city: 'Lahore', paymentMode: 'PREPAY',
    });
    const { order } = await tenant((db) => createDueChronicRefillOrder(db, scope, { subscriptionId: subscription.id, now }));
    for (const action of ['accept', 'pack'] as const)
      await tenant((db) => transitionCustomerOrder(db, scope, { orderId: order!.id, action }));
    const dispatch = () => tenant((db) => transitionCustomerOrder(db, scope, {
      orderId: order!.id, action: 'dispatch', runnerUserId: actorId,
    }));
    await expect(dispatch()).rejects.toMatchObject({ reason: 'PREPAY_REQUIRED' });
    const { saleId } = await tenant((db) => startCustomerOrderCheckout(db, scope, order!.id));
    await expect(dispatch()).rejects.toMatchObject({ reason: 'PREPAY_REQUIRED' });
    await tenant((db) => applyPharmacyTender(db, scope, {
      saleId, deviceId: `refill_device_${suffix}`, businessDate: now,
      type: 'BANK_TRANSFER', amountMinor: 1000, idempotencyKey: randomUUID(),
    }));
    await expect(dispatch()).rejects.toMatchObject({ reason: 'PREPAY_REQUIRED' });
    await tenant((db) => applyPharmacyTender(db, scope, {
      saleId, deviceId: `refill_device_${suffix}`, businessDate: now,
      type: 'BANK_TRANSFER', amountMinor: 1000, idempotencyKey: randomUUID(),
    }));
    expect(await dispatch()).toMatchObject({ status: 'OUT_FOR_DELIVERY' });
  });

  it('finds chronic reminders in platform scope and honors appended consent withdrawal', async () => {
    const due = new Date(now.getTime() + DAY);
    const subscription = await subscribe(otc, { nextDueAt: due, reminderConsentId: consentId });
    await tenant((db) => createDueChronicRefillOrder(db, scope, { subscriptionId: subscription.id, now }));
    const config = readWhatsAppConfig({
      PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER: 'neutral_due_v1',
      PHARMACY_WHATSAPP_REMINDER_LEAD_DAYS: '1',
      PHARMACY_WHATSAPP_ORGANIZATION_ID: organizationId,
      PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'synthetic',
    });
    const provider = new MockWhatsAppProvider(config);
    const first = await processDueWhatsAppRefillReminders({ now, config, provider });
    expect(first.prepared).toBe(1);
    expect(provider.calls).toHaveLength(1);
    // A new customer avoids the independent daily reminder cap, so only the
    // superseding consent version can prevent the second provider call.
    await tenant(async (db) => {
      const patient = await db.pharmacyPatient.create({
        data: { organizationId, displayName: 'Withdrawn', phone: '03007654321' },
      });
      const customer = await db.pharmacyCustomer.create({
        data: {
          organizationId,
          patientId: patient.id,
          displayName: 'Withdrawn',
          whatsappOptIn: true,
        },
      });
      const grant = await writePatientConsent(
        db,
        organizationId,
        actorId,
        { patientId: patient.id, purpose: 'REMINDERS', channel: 'WHATSAPP', granted: true },
        new Date(now.getTime() - DAY)
      );
      await createChronicRefillSubscription(db, scope, {
        customerId: customer.id,
        ...otc,
        quantityPacks: 1,
        fulfillment: 'COLLECT',
        paymentMode: 'PREPAY',
        cadenceDays: 30,
        nextDueAt: due,
        reminderConsentId: grant.id,
      });
      await writePatientConsent(
        db,
        organizationId,
        actorId,
        { patientId: patient.id, purpose: 'REMINDERS', channel: 'WHATSAPP', granted: false },
        now
      );
    });
    const second = await processDueWhatsAppRefillReminders({ now, config, provider });
    expect(second.skippedNoConsent).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(1);
  });
});
