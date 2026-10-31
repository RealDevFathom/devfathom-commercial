/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const sends = vi.hoisted(() => ({ sendTemplate: vi.fn() }));
vi.mock('./whatsapp/provider', async () => ({
  ...(await vi.importActual<typeof import('./whatsapp/provider')>('./whatsapp/provider')),
  createWhatsAppProvider: () => ({ name: 'mock', sendTemplate: sends.sendTemplate }),
}));

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const prefix = `restock_${randomUUID().replaceAll('-', '')}`;
const scope = { organizationId: prefix, branchId: `${prefix}_branch`, actorId: 'staff' };
let tenancy: typeof import('@/lib/tenancy/scoped-db');
let sales: typeof import('./sales');
let worker: typeof import('./back-in-stock-worker');
let ledger: typeof import('./stock-ledger');
let consent: typeof import('./consent-writer');

function tenant<T>(run: (db: ScopedDb) => Promise<T>, drain = false) {
  return tenancy.withTenantDb(
    scope.organizationId,
    async (db) => {
      await db.$queryRawUnsafe(
        "SELECT set_config('app.current_branch_id', $1, true)",
        scope.branchId
      );
      return run(db);
    },
    { skipDrain: !drain }
  );
}

async function fixture() {
  return tenant(async (db) => {
    const patient = await db.pharmacyPatient.create({
      data: {
        organizationId: scope.organizationId,
        displayName: 'Synthetic patient',
        phone: '923001234567',
      },
    });
    await consent.writePatientConsent(db, scope.organizationId, scope.actorId, {
      patientId: patient.id,
      purpose: 'REMINDERS',
      channel: 'WHATSAPP',
      granted: true,
    });
    const customer = await db.pharmacyCustomer.create({
      data: {
        organizationId: scope.organizationId,
        patientId: patient.id,
        displayName: 'Synthetic customer',
        whatsappOptIn: true,
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId: scope.organizationId,
        productName: `Medicine ${randomUUID()}`,
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId: scope.organizationId, presentation: 'Tablet' } },
        strengths: {
          create: {
            organizationId: scope.organizationId,
            value: 10,
            unit: 'mg',
            ingredient: {
              create: { organizationId: scope.organizationId, name: `Salt ${randomUUID()}` },
            },
          },
        },
      },
      include: { presentations: true, strengths: { include: { ingredient: true } } },
    });
    const pack = await db.packLevel.create({
      data: {
        organizationId: scope.organizationId,
        presentationId: medicine.presentations[0].id,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        code: randomUUID(),
        name: 'Shelf',
        kind: 'STORE',
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId: scope.organizationId,
        medicineId: medicine.id,
        batchNumber: randomUUID(),
        expiresAt: new Date('2035-01-01'),
        expiryPrecision: 'DAY',
      },
    });
    const lots = [];
    for (let n = 0; n < 2; n++) {
      const received = await ledger.receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Synthetic distributor',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 10,
        printedMrpMinor: 1000,
        receivedExpiresAt: new Date('2035-01-01'),
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 20,
        receivedAt: new Date(),
        idempotencyKey: randomUUID(),
      });
      lots.push(received.lot);
    }
    const demand = await db.unfulfilledDemandEvent.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        requestedMedicineId: medicine.id,
        requestedText: 'Brand label',
        saleUnit: 'UNIT',
        quantity: 1,
        reason: 'NOT_CARRIED',
        inventoryRuleSnapshot: {},
        estimatedValueMinor: 10000,
        capturedByUserId: scope.actorId,
      },
    });
    const interest = await sales.addRestockInterest(db, scope, {
      demandEventId: demand.id,
      patientId: patient.id,
      channel: 'WHATSAPP',
      quantityUnits: 1,
    });
    return { patient, customer, medicine, pack, location, interest, lots };
  });
}

beforeEach(() => {
  sends.sendTemplate
    .mockReset()
    .mockResolvedValue({ providerMessageId: 'ack', acceptedByProvider: true });
});

describe.skipIf(!url)('back-in-stock committed delivery on PostgreSQL', () => {
  beforeAll(async () => {
    [tenancy, sales, worker, ledger, consent] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./sales'),
      import('./back-in-stock-worker'),
      import('./stock-ledger'),
      import('./consent-writer'),
    ]);
    await tenancy.withPlatformDb(async (db) => {
      const [role] = await db.$queryRaw<
        { rolsuper: boolean; rolbypassrls: boolean }[]
      >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await db.organization.create({
        data: {
          id: scope.organizationId,
          slug: prefix,
          legalName: prefix,
          displayName: prefix,
          vertical: 'PHARMACY',
        },
      });
    });
    await tenant((db) =>
      db.pharmacyBranch.create({
        data: {
          id: scope.branchId,
          organizationId: scope.organizationId,
          code: 'TEST',
          name: 'Test branch',
          addressLine: 'Test',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      })
    );
  });
  afterAll(async () => {
    await (await import('@/lib/db')).db.$disconnect();
  });

  it.each(['PROCESSING', 'SENT', 'FAILED'] as const)(
    'allows the %s delivery state while preserving cancellation evidence',
    async (status) => {
      const f = await fixture();
      const [captured] = await tenant((db) =>
        sales.captureSafeRestockArrival(db, scope, { inventoryLotId: f.lots[0].id })
      );
      await expect(
        tenant((db) =>
          db.pharmacyRestockNotification.updateMany({
            where: { id: captured.notification!.id },
            data: { status },
          })
        )
      ).resolves.toEqual({ count: 1 });
      await expect(
        tenant((db) =>
          db.pharmacyRestockNotification.updateMany({
            where: { id: captured.notification!.id },
            data: { status: 'CANCELLED' },
          })
        )
      ).rejects.toThrow();
    }
  );

  it('sends after the capture and claim commit, then records acknowledgement once', async () => {
    const f = await fixture();
    sends.sendTemplate.mockImplementation(async () => {
      const notices = await tenant((db) =>
        db.pharmacyRestockNotification.findMany({ where: { interestId: f.interest.id } })
      );
      expect(notices).toMatchObject([{ status: 'PROCESSING' }]);
      return { providerMessageId: 'accepted', acceptedByProvider: true };
    });
    const [captured] = await tenant(
      (db) => sales.captureSafeRestockArrival(db, scope, { inventoryLotId: f.lots[0].id }),
      true
    );
    expect(sends.sendTemplate).toHaveBeenCalledTimes(1);
    const notice = await tenant((db) =>
      db.pharmacyRestockNotification.findFirstOrThrow({ where: { id: captured.notification!.id } })
    );
    expect(notice).toMatchObject({ status: 'SENT', providerMessageId: 'accepted' });
    expect(notice.sentAt).toBeInstanceOf(Date);
    await expect(worker.deliverBackInStockNotification(scope, notice.id)).resolves.toBe('SKIPPED');
    expect(sends.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('rolls back notification and outbox without sending when a sibling mutation fails', async () => {
    const f = await fixture();
    let notificationId = '';
    await expect(
      tenant(async (db) => {
        const [captured] = await sales.captureSafeRestockArrival(db, scope, {
          inventoryLotId: f.lots[0].id,
        });
        notificationId = captured.notification!.id;
        throw new Error('failed sibling');
      }, true)
    ).rejects.toThrow('failed sibling');
    expect(sends.sendTemplate).not.toHaveBeenCalled();
    expect(
      await tenant((db) =>
        db.pharmacyRestockNotification.count({ where: { interestId: f.interest.id } })
      )
    ).toBe(0);
    expect(
      await tenant((db) =>
        db.outboundEffect.count({
          where: { payload: { path: ['notificationId'], equals: notificationId } },
        })
      )
    ).toBe(0);
    await tenant(
      (db) => sales.captureSafeRestockArrival(db, scope, { inventoryLotId: f.lots[0].id }),
      true
    );
    expect(sends.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reserve: false, quantity: 1, sent: 1 },
    { reserve: true, quantity: 100, sent: 0 },
  ])(
    'posts GRN stock and dispatches available requests (%j)',
    async ({ reserve, quantity, sent }) => {
      const f = await fixture();
      await tenant((db) =>
        db.pharmacyRestockInterest.update({
          where: { id: f.interest.id },
          data: { reserveOnArrival: reserve, quantityUnits: quantity },
        })
      );
      const now = new Date();
      const receipt = await tenant(async (db) => {
        const supplier = await db.pharmacySupplier.create({
          data: {
            organizationId: scope.organizationId,
            name: `Supplier ${randomUUID()}`,
            authorized: true,
            licences: {
              create: {
                licenceType: 'DRUG_SALE',
                licenceNumber: randomUUID(),
                issuingAuthority: 'DRAP',
                issuedAt: new Date('2025-01-01'),
                expiresAt: new Date('2035-01-01'),
                verifiedAt: new Date('2025-01-02'),
              },
            },
          },
        });
        return db.pharmacyGoodsReceipt.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            reference: randomUUID(),
            supplierId: supplier.id,
            supplierInvoiceRef: randomUUID(),
            supplierInvoiceDate: now,
            warrantyEvidenceRef: 'Synthetic warranty',
            receivedByUserId: scope.actorId,
            receivedAt: now,
            directPurchase: true,
            bypassReason: 'Synthetic direct purchase',
            bypassApprovedByUserId: 'manager',
            bypassApprovedAt: now,
            lines: {
              create: {
                lineNumber: 1,
                medicineId: f.medicine.id,
                packLevelId: f.pack.id,
                batchNumber: randomUUID(),
                printedExpiry: new Date('2035-01-01'),
                expiryPrecision: 'DAY',
                printedMrpMinor: 1000,
                canonicalUnitsPerPack: 10,
                receivedPacks: 2,
                bonusPacks: 0,
                receivedCanonicalUnits: 20,
                bonusCanonicalUnits: 0,
                acceptedCanonicalUnits: 20,
                rejectedCanonicalUnits: 0,
                invoicedPricePerPackMinor: 100,
                unitCostMinor: 10,
                stockLocationId: f.location.id,
              },
            },
          },
        });
      });
      const { postGoodsReceipt } = await import('./goods-receipt');
      await tenant(
        (db) => postGoodsReceipt(db, scope, { goodsReceiptId: receipt.id, at: now }),
        true
      );
      expect(sends.sendTemplate).toHaveBeenCalledTimes(sent);
      expect(
        await tenant((db) =>
          db.pharmacyRestockNotification.count({
            where: { interestId: f.interest.id, status: 'SENT' },
          })
        )
      ).toBe(sent);
    }
  );

  it('deduplicates separate arriving lots even when they capture concurrently', async () => {
    const f = await fixture();
    const results = await Promise.all(
      f.lots.map((lot) =>
        tenant((db) => sales.captureSafeRestockArrival(db, scope, { inventoryLotId: lot.id }))
      )
    );
    expect(results.flat()).toHaveLength(1);
    expect(
      await tenant((db) =>
        db.pharmacyRestockNotification.count({ where: { interestId: f.interest.id } })
      )
    ).toBe(1);
    const notices = results.flat();
    expect(
      await tenant((db) =>
        db.outboundEffect.count({
          where: { payload: { path: ['notificationId'], equals: notices[0].notification!.id } },
        })
      )
    ).toBe(1);
  });

  it.each(['revoked', 'STOP'] as const)('rechecks %s after capture', async (change) => {
    const f = await fixture();
    const [captured] = await tenant((db) =>
      sales.captureSafeRestockArrival(db, scope, { inventoryLotId: f.lots[0].id })
    );
    await tenant(async (db) => {
      if (change === 'revoked')
        await consent.writePatientConsent(db, scope.organizationId, scope.actorId, {
          patientId: f.patient.id,
          purpose: 'REMINDERS',
          channel: 'WHATSAPP',
          granted: false,
        });
      else
        await db.pharmacyCustomer.update({
          where: { id: f.customer.id },
          data: { whatsappOptIn: false },
        });
    });
    await expect(
      worker.deliverBackInStockNotification(scope, captured.notification!.id)
    ).resolves.toBe('SKIPPED');
    expect(sends.sendTemplate).not.toHaveBeenCalled();
  });

  it('preserves opt-out committed during provider acknowledgement', async () => {
    const f = await fixture();
    const [captured] = await tenant((db) =>
      sales.captureSafeRestockArrival(db, scope, { inventoryLotId: f.lots[0].id })
    );
    sends.sendTemplate.mockImplementation(async () => {
      await tenant((db) => sales.optOutRestockInterest(db, scope, f.interest.id));
      return { providerMessageId: 'ack', acceptedByProvider: true };
    });
    await expect(
      worker.deliverBackInStockNotification(scope, captured.notification!.id)
    ).resolves.toBe('SENT');
    expect(
      await tenant((db) =>
        db.pharmacyRestockInterest.findFirstOrThrow({ where: { id: f.interest.id } })
      )
    ).toMatchObject({ status: 'OPTED_OUT' });
  });

  it('keeps other tenants and branches outside the delivery scope', async () => {
    const f = await fixture();
    const [captured] = await tenant((db) =>
      sales.captureSafeRestockArrival(db, scope, { inventoryLotId: f.lots[0].id })
    );
    await expect(
      worker.deliverBackInStockNotification(
        { ...scope, organizationId: `${prefix}_other` },
        captured.notification!.id
      )
    ).resolves.toBe('SKIPPED');
    await expect(
      worker.deliverBackInStockNotification(
        { ...scope, branchId: `${prefix}_other` },
        captured.notification!.id
      )
    ).resolves.toBe('SKIPPED');
    expect(sends.sendTemplate).not.toHaveBeenCalled();
  });

  it('records unsupported SMS delivery without leaving a captured notice', async () => {
    const f = await fixture();
    await tenant(async (db) => {
      await consent.writePatientConsent(db, scope.organizationId, scope.actorId, {
        patientId: f.patient.id,
        purpose: 'REMINDERS',
        channel: 'SMS',
        granted: true,
      });
      await db.pharmacyRestockInterest.update({
        where: { id: f.interest.id },
        data: { channel: 'SMS' },
      });
    });
    const [captured] = await tenant((db) =>
      sales.captureSafeRestockArrival(db, scope, { inventoryLotId: f.lots[0].id })
    );
    await expect(
      worker.deliverBackInStockNotification(scope, captured.notification!.id)
    ).resolves.toBe('SKIPPED');
    const notice = await tenant((db) =>
      db.pharmacyRestockNotification.findFirstOrThrow({ where: { id: captured.notification!.id } })
    );
    expect(notice).toMatchObject({ status: 'FAILED', lastError: 'UNSUPPORTED_CHANNEL' });
    expect(sends.sendTemplate).not.toHaveBeenCalled();
  });

  it('exposes uncertain sends for reference lookup and durable reconciliation without a resend', async () => {
    const f = await fixture();
    sends.sendTemplate.mockRejectedValue(new Error('unknown outcome'));
    const [captured] = await tenant((db) =>
      sales.captureSafeRestockArrival(db, scope, { inventoryLotId: f.lots[0].id })
    );
    await expect(
      worker.deliverBackInStockNotification(scope, captured.notification!.id)
    ).resolves.toBe('UNKNOWN');
    const queue = await tenant((db) => worker.reviewRestockNotifications(db, scope));
    const pending = queue.find((notice) => notice.id === captured.notification!.id)!;
    expect(pending).toMatchObject({ status: 'PROCESSING', lastError: 'UNKNOWN_PROVIDER_OUTCOME' });
    expect(pending).not.toHaveProperty('destination');
    await expect(
      tenant((db) => worker.reviewRestockNotifications(db, scope, pending.reference))
    ).resolves.toMatchObject([{ id: pending.id, interestId: f.interest.id }]);
    const sentAt = new Date();
    await tenant((db) => worker.reconcileRestockNotification(db, scope, {
      notificationId: pending.id,
      outcome: 'SENT',
      sentAt,
      providerMessageId: 'operator-verified-ack',
    }));
    await expect(
      worker.deliverBackInStockNotification(scope, pending.id)
    ).resolves.toBe('SKIPPED');
    expect(sends.sendTemplate).toHaveBeenCalledTimes(1);
    const [resolved] = await tenant((db) =>
      worker.reviewRestockNotifications(db, scope, pending.reference)
    );
    expect(resolved).toMatchObject({ status: 'SENT', sentAt });
  });

  it('reads actual catalog salt and arrival distributor in the report', async () => {
    const f = await fixture();
    await tenant((db) =>
      sales.captureSafeRestockArrival(db, scope, { inventoryLotId: f.lots[0].id })
    );
    const report = await tenant((db) => sales.restockRecoveryDashboard(db, scope));
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        salt: f.medicine.strengths[0].ingredient.name,
        distributor: 'Synthetic distributor',
        estimatedLostMinor: 10000,
      })
    );
  });
});
