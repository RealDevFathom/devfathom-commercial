// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  addSaleLine,
  assertVoucherEligibility,
  changeSaleStatus,
  createSale,
} from '@/lib/pharmacy/sales';
import { receiveLot } from '@/lib/pharmacy/stock-ledger';
import { linkCustomerToSale } from '@/lib/pharmacy/customer-loyalty';
import { applyPharmacyTender } from '@/lib/pharmacy/settlement';
import { approveMarketingCampaign } from '@/lib/pharmacy/marketing-service';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;

const suffix = randomUUID().slice(0, 8);
const organizationId = `qa795_${suffix}`;
const scope = { organizationId, branchId: `qa795_br_${suffix}`, actorId: `qa795_actor_${suffix}` };
const otherBranchId = `qa795_other_${suffix}`;
const otherOrg = `qa795_foreign_${suffix}`;
const tenant = <T>(run: (db: ScopedDb) => Promise<T>) => withTenantDb(organizationId, run);
let locationId: string;
let ownerPinCredentialId: string;

beforeAll(async () => {
  if (!databaseUrl) return;
  process.env.DATABASE_URL = databaseUrl;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  await withPlatformDb(async (db) => {
    const [role] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'select rolsuper,rolbypassrls from pg_roles where rolname=current_user'
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    for (const org of [organizationId, otherOrg])
      await db.$executeRawUnsafe(
        `INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,$1,$1,'PHARMACY','ACTIVE','SHARED',now(),now())`,
        org
      );
  });
  await tenant(async (db) => {
    await db.user.create({
      data: {
        id: scope.actorId,
        organizationId,
        name: 'Synthetic owner',
        email: `${scope.actorId}@example.test`,
        department: 'Pharmacy',
        title: 'Owner',
        role: 'ADMIN',
      },
    });
    const staff = await db.restaurantStaffProfile.create({
      data: { organizationId, userId: scope.actorId, displayName: 'Synthetic owner' },
    });
    ownerPinCredentialId = (
      await db.restaurantOperatorCredential.create({
        data: {
          organizationId,
          staffProfileId: staff.id,
          type: 'PIN',
          credentialHash: await hashOperatorCredential('PIN', '4821'),
        },
      })
    ).id;
    for (const id of [scope.branchId, otherBranchId])
      await db.pharmacyBranch.create({
        data: {
          id,
          organizationId,
          code: id,
          name: id,
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
    locationId = (
      await db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId: scope.branchId,
          code: 'MAIN',
          name: 'Stock',
          kind: 'STORE',
        },
      })
    ).id;
  });
});

async function fixture(
  family: 'FRONT_SHOP' | 'PHARMACEUTICAL' | 'ALTERNATIVE' | 'DEVICE' | 'BIOLOGICAL' = 'FRONT_SHOP'
) {
  return tenant(async (db) => {
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: 'Synthetic customer' },
    });
    const customer = await db.pharmacyCustomer.create({
      data: { organizationId, patientId: patient.id, displayName: 'Synthetic customer' },
    });
    await db.patientConsent.create({
      data: {
        organizationId,
        patientId: patient.id,
        purpose: 'LOYALTY',
        channel: 'IN_PERSON',
        version: 1,
        granted: true,
        recordedByUserId: scope.actorId,
      },
    });
    const segment = await db.pharmacyMarketingSegment.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        name: randomUUID(),
        definition: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
        createdByUserId: scope.actorId,
      },
    });
    const template = await db.pharmacyMarketingTemplate.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        name: randomUUID(),
        body: 'Save on essentials. Reply STOP.',
        channel: 'WHATSAPP',
        approvedByUserId: scope.actorId,
        approvedAt: new Date(),
      },
    });
    const campaign = await db.pharmacyCampaign.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        name: randomUUID(),
        segmentId: segment.id,
        templateId: template.id,
        scheduledAt: new Date('2026-01-01'),
        quietHours: { startHour: 22, endHour: 8 },
        frequencyCap: { max: 1, windowDays: 7 },
        voucherEnabled: true,
        voucherDiscountMinor: 250,
      },
    });
    expect(
      await approveMarketingCampaign(db, { ...scope, timezone: 'UTC' }, campaign.id, new Date(), '4821')
    ).toEqual({ status: 'APPROVED' });
    await db.pharmacyCampaign.update({ where: { id: campaign.id }, data: { status: 'CAPTURED' } });
    const capture = await db.pharmacyCampaignCapture.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        campaignId: campaign.id,
        customerId: customer.id,
        channel: 'WHATSAPP',
        idempotencyKey: randomUUID(),
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: 'Synthetic essentials',
        productFamily: family,
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Retail' } },
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
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: randomUUID(),
        expiresAt: new Date('2031-01-01'),
        expiryPrecision: 'DAY',
      },
    });
    const { lot } = await receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      stockLocationId: locationId,
      unitsPerPack: 10,
      supplierName: 'Test',
      supplierInvoiceRef: randomUUID(),
      unitCostMinor: 1,
      printedMrpMinor: 1000,
      receivedExpiresAt: new Date('2031-01-01'),
      receivedExpiryPrecision: 'DAY',
      quantityUnits: 30,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2026-01-01'),
    });
    const sale = await createSale(db, scope);
    await db.pharmacySale.update({ where: { id: sale.id }, data: { customerId: customer.id } });
    return {
      saleId: sale.id,
      campaignId: campaign.id,
      captureId: capture.id,
      customerId: customer.id,
      patientId: patient.id,
      lotId: lot.id,
      medicineId: medicine.id,
      presentationId,
      packLevelId: pack.id,
    };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const lineInput = (f: Fixture) => ({
  saleId: f.saleId,
  medicineId: f.medicineId,
  presentationId: f.presentationId,
  packLevelId: f.packLevelId,
  saleUnit: 'UNIT' as const,
  quantity: 10,
  canonicalUnitsPerSaleUnit: 1,
  discountKind: 'PROMOTION' as const,
  discountMinor: 250,
  voucherCampaignId: f.campaignId,
  approvedByUserId: scope.actorId,
  approvalPolicy: 'Owner-approved campaign',
  idempotencyKey: randomUUID(),
});
const state = (f: Fixture) =>
  tenant(async (db) => ({
    redemptions: await db.pharmacyVoucherRedemption.count({ where: { captureId: f.captureId } }),
    lines: await db.pharmacySaleLine.count({ where: { medicineId: f.medicineId } }),
    movements: await db.pharmacyStockMovement.count({ where: { inventoryLotId: f.lotId } }),
    balances: await db.pharmacyStockBalance.findMany({
      where: { inventoryLotId: f.lotId },
      select: { onHandUnits: true, disposition: true },
      orderBy: { disposition: 'asc' },
    }),
  }));

describeIfDatabase('voucher reservation lifecycle and evidence', () => {
  it('commits failed PIN counters and only stores approval evidence after a correct owner PIN', async () => {
    const f = await fixture();
    await tenant((db) =>
      db.pharmacyCampaign.update({
        where: { id: f.campaignId },
        data: {
          status: 'DRAFT',
          ownerApprovalPinCredentialId: null,
          ownerApprovedAt: null,
          ownerApprovedByUserId: null,
        },
      })
    );
    expect(
      await tenant((db) =>
        approveMarketingCampaign(db, { ...scope, timezone: 'UTC' }, f.campaignId, new Date(), '4822')
      )
    ).toHaveProperty('blocked');
    expect(
      await tenant((db) => db.restaurantOperatorCredential.findUniqueOrThrow({
        where: { id: ownerPinCredentialId }, select: { failedAttempts: true },
      }))
    ).toEqual({ failedAttempts: 1 });
    expect(
      await tenant((db) => db.pharmacyCampaign.findFirstOrThrow({
        where: { id: f.campaignId }, select: { status: true, ownerApprovalPinCredentialId: true },
      }))
    ).toEqual({ status: 'DRAFT', ownerApprovalPinCredentialId: null });
    expect(
      await tenant((db) =>
        approveMarketingCampaign(db, { ...scope, timezone: 'UTC' }, f.campaignId, new Date(), '4821')
      )
    ).toEqual({ status: 'APPROVED' });
  });
  it('requires persisted owner PIN evidence before funding an otherwise approved voucher', async () => {
    const f = await fixture();
    const campaign = await tenant((db) =>
      db.pharmacyCampaign.findFirstOrThrow({ where: { id: f.campaignId } })
    );
    expect(campaign).toMatchObject({
      ownerApprovedByUserId: scope.actorId,
      ownerApprovalPinCredentialId: ownerPinCredentialId,
    });
    await tenant((db) =>
      db.pharmacyCampaign.update({
        where: { id: f.campaignId }, data: { ownerApprovalPinCredentialId: null },
      })
    );
    await expect(tenant((db) => addSaleLine(db, scope, lineInput(f)))).rejects.toMatchObject({
      reason: 'VOUCHER_NOT_ELIGIBLE',
    });
    expect(
      await tenant((db) => db.pharmacyVoucherRedemption.count({ where: { campaignId: f.campaignId } }))
    ).toBe(0);
  });
  it.each(['ReadCommitted', 'RepeatableRead'] as const)(
    'enforces single use for direct concurrent database claims at %s',
    async (isolationLevel) => {
      const f = await fixture();
      const promotion = { ...lineInput(f), voucherCampaignId: undefined };
      const firstLine = await tenant((db) => addSaleLine(db, scope, promotion));
      const secondLine = await tenant(async (db) => {
        const sale = await createSale(db, scope);
        await db.pharmacySale.update({
          where: { id: sale.id },
          data: { customerId: f.customerId },
        });
        return addSaleLine(db, scope, {
          ...promotion,
          saleId: sale.id,
          idempotencyKey: randomUUID(),
        });
      });
      // Both snapshots must exist before either claim, so this also exercises
      // the database guard without the domain eligibility pre-check.
      let started = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const claim = (saleLineId: string) =>
        withTenantDb(
          organizationId,
          async (db) => {
            if (++started === 2) release();
            await ready;
            return db.pharmacyVoucherRedemption.create({
              data: {
                organizationId,
                branchId: scope.branchId,
                campaignId: f.campaignId,
                captureId: f.captureId,
                customerId: f.customerId,
                saleLineId,
                discountMinor: 250,
                redeemedByUserId: scope.actorId,
              },
            });
          },
          { isolationLevel }
        );
      const results = await Promise.allSettled([
        claim(firstLine.line.id),
        claim(secondLine.line.id),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason.code).toBe(isolationLevel === 'ReadCommitted' ? 'P2002' : 'P2034');
      expect(
        await tenant((db) =>
          db.pharmacyVoucherRedemption.count({ where: { captureId: f.captureId } })
        )
      ).toBe(1);
    }
  );

  it('preserves an approved nonvoucher promotion', async () => {
    const f = await fixture();
    const input = { ...lineInput(f), voucherCampaignId: undefined };
    await expect(tenant((db) => addSaleLine(db, scope, input))).resolves.toMatchObject({
      line: { discountKind: 'PROMOTION', discountMinor: 250 },
    });
  });
  it.each(['PHARMACEUTICAL', 'ALTERNATIVE', 'DEVICE', 'BIOLOGICAL'] as const)(
    'refuses %s before money or stock changes',
    async (family) => {
      const f = await fixture(family);
      const before = await state(f);
      await expect(tenant((db) => addSaleLine(db, scope, lineInput(f)))).rejects.toMatchObject({
        reason: 'VOUCHER_NOT_ELIGIBLE',
      });
      expect(await state(f)).toEqual(before);
    }
  );
  it('persists one discount and rolls back a forced transaction failure', async () => {
    const f = await fixture();
    const before = await state(f);
    await expect(
      tenant(async (db) => {
        await addSaleLine(db, scope, lineInput(f));
        throw new Error('forced failure');
      })
    ).rejects.toThrow('forced failure');
    expect(await state(f)).toEqual(before);
    await tenant((db) => addSaleLine(db, scope, lineInput(f)));
    expect(await state(f)).toMatchObject({ redemptions: 1, lines: 1 });
    const stored = await tenant((db) =>
      db.pharmacyVoucherRedemption.findFirstOrThrow({
        where: { captureId: f.captureId },
        include: { saleLine: true },
      })
    );
    expect(stored.discountMinor).toBe(stored.saleLine.discountMinor);
    expect(
      await tenant((db) =>
        db.pharmacySaleEvent.count({ where: { saleId: f.saleId, kind: 'LINE_ADDED' } })
      )
    ).toBe(1);
  });
  it('serializes simultaneous single-use redemption and rolls back loser stock', async () => {
    const f = await fixture();
    const second = await tenant(async (db) => {
      const s = await createSale(db, scope);
      await db.pharmacySale.update({ where: { id: s.id }, data: { customerId: f.customerId } });
      return s.id;
    });
    const results = await Promise.allSettled([
      tenant((db) => addSaleLine(db, scope, lineInput(f))),
      tenant((db) => addSaleLine(db, scope, lineInput({ ...f, saleId: second }))),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ reason: 'VOUCHER_ALREADY_REDEEMED' });
    expect(await state(f)).toMatchObject({ redemptions: 1, lines: 1 });
    const balances = await tenant((db) =>
      db.pharmacyStockBalance.aggregate({
        where: { inventoryLotId: f.lotId },
        _sum: { onHandUnits: true },
      })
    );
    expect(balances._sum.onHandUnits).toBe(20);
  });
  it('enforces foreign tenant and sibling branch reads and writes under RLS', async () => {
    const f = await fixture();
    await tenant((db) => addSaleLine(db, scope, lineInput(f)));
    const row = await tenant((db) =>
      db.pharmacyVoucherRedemption.findFirstOrThrow({ where: { captureId: f.captureId } })
    );
    expect(
      await withTenantDb(otherOrg, (db) =>
        db.pharmacyVoucherRedemption.findMany({ where: { id: row.id } })
      )
    ).toEqual([]);
    expect(
      await tenant(async (db) => {
        await db.$executeRawUnsafe(
          "select set_config('app.current_branch_id',$1,true)",
          otherBranchId
        );
        return db.pharmacyVoucherRedemption.findMany({ where: { id: row.id } });
      })
    ).toEqual([]);
    await expect(
      withTenantDb(otherOrg, (db) =>
        db.pharmacyVoucherRedemption.create({ data: { ...row, id: randomUUID() } })
      )
    ).rejects.toThrow();
    await expect(
      tenant(async (db) => {
        await db.$executeRawUnsafe(
          "select set_config('app.current_branch_id',$1,true)",
          otherBranchId
        );
        return db.pharmacyVoucherRedemption.create({ data: { ...row, id: randomUUID() } });
      })
    ).rejects.toThrow();
    await expect(
      withTenantDb(otherOrg, (db) =>
        assertVoucherEligibility(
          db,
          { organizationId: otherOrg, branchId: scope.branchId },
          f.campaignId,
          'FRONT_SHOP',
          f.customerId,
          250
        )
      )
    ).rejects.toMatchObject({ reason: 'VOUCHER_NOT_ELIGIBLE' });
  });
  it('keeps a voucher usable when its unpaid cart is voided', async () => {
    const f = await fixture();
    await tenant((db) => addSaleLine(db, scope, lineInput(f)));
    await tenant((db) => changeSaleStatus(db, scope, f.saleId, 'void', 'Customer cancelled'));
    expect(
      (
        await tenant((db) =>
          db.pharmacyStockBalance.aggregate({
            where: { inventoryLotId: f.lotId },
            _sum: { onHandUnits: true },
          })
        )
      )._sum.onHandUnits
    ).toBe(30);
    await expect(
      tenant((db) =>
        assertVoucherEligibility(db, scope, f.campaignId, 'FRONT_SHOP', f.customerId, 250)
      )
    ).resolves.toEqual({ captureId: f.captureId, customerId: f.customerId });
    const next = await tenant(async (db) => {
      const s = await createSale(db, scope);
      await db.pharmacySale.update({ where: { id: s.id }, data: { customerId: f.customerId } });
      return { ...f, saleId: s.id };
    });
    await tenant((db) => addSaleLine(db, scope, lineInput(next)));
    expect(await state(f)).toMatchObject({ redemptions: 2, lines: 2 });
    expect(
      await tenant((db) =>
        db.pharmacySaleEvent.count({ where: { saleId: f.saleId, kind: 'VOIDED' } })
      )
    ).toBe(1);
    await expect(
      tenant((db) => db.pharmacySale.update({ where: { id: f.saleId }, data: { status: 'OPEN' } }))
    ).rejects.toThrow('void voucher cart cannot be reopened');
  });
  it('keeps the reservation and stock intact when voiding rolls back', async () => {
    const f = await fixture();
    await tenant((db) => addSaleLine(db, scope, lineInput(f)));
    const before = await state(f);
    await expect(
      tenant(async (db) => {
        await changeSaleStatus(db, scope, f.saleId, 'void', 'Cancelled');
        throw new Error('void transaction failed');
      })
    ).rejects.toThrow('void transaction failed');
    expect(await state(f)).toEqual(before);
    expect(
      await tenant((db) =>
        db.pharmacySaleEvent.count({ where: { saleId: f.saleId, kind: 'VOIDED' } })
      )
    ).toBe(0);
    await expect(
      tenant((db) =>
        assertVoucherEligibility(db, scope, f.campaignId, 'FRONT_SHOP', f.customerId, 250)
      )
    ).rejects.toMatchObject({ reason: 'VOUCHER_ALREADY_REDEEMED' });
  });

  it('does not release a part-paid voucher when its cart is voided', async () => {
    const f = await fixture();
    await tenant((db) => addSaleLine(db, scope, lineInput(f)));
    await tenant((db) =>
      applyPharmacyTender(db, scope, {
        saleId: f.saleId,
        deviceId: randomUUID(),
        businessDate: new Date('2026-10-31'),
        type: 'BANK_TRANSFER',
        amountMinor: 100,
        idempotencyKey: randomUUID(),
      })
    );
    await tenant((db) =>
      changeSaleStatus(db, scope, f.saleId, 'void', 'Cancelled after part payment')
    );
    await expect(
      tenant((db) =>
        assertVoucherEligibility(db, scope, f.campaignId, 'FRONT_SHOP', f.customerId, 250)
      )
    ).rejects.toMatchObject({ reason: 'VOUCHER_ALREADY_REDEEMED' });
  });

  it('prevents a nonrecipient from retaining another customer voucher after relink', async () => {
    const f = await fixture();
    await tenant((db) => addSaleLine(db, scope, lineInput(f)));
    const other = await fixture();
    await expect(
      tenant((db) =>
        linkCustomerToSale(db, scope, {
          saleId: f.saleId,
          patientId: other.patientId,
          displayName: 'Other customer',
        })
      )
    ).rejects.toMatchObject({ reason: 'VOUCHER_CUSTOMER_MISMATCH' });
    await expect(
      tenant((db) =>
        db.pharmacySale.update({ where: { id: f.saleId }, data: { customerId: other.customerId } })
      )
    ).rejects.toThrow('voucher recipient cannot be reassigned');
    await tenant((db) =>
      linkCustomerToSale(db, scope, {
        saleId: f.saleId,
        patientId: f.patientId,
        displayName: 'Original customer',
      })
    );
    expect(
      await tenant((db) =>
        db.pharmacyCampaignCapture.count({
          where: { campaignId: f.campaignId, customerId: other.customerId },
        })
      )
    ).toBe(0);
    await expect(
      tenant((db) =>
        applyPharmacyTender(db, scope, {
          saleId: f.saleId,
          deviceId: randomUUID(),
          businessDate: new Date('2026-10-31'),
          type: 'BANK_TRANSFER',
          amountMinor: 750,
          idempotencyKey: randomUUID(),
        })
      )
    ).resolves.toMatchObject({ settled: true });
  });
  it('rejects enabled campaign with null discount in the database', async () => {
    const f = await fixture();
    await expect(
      tenant((db) =>
        db.pharmacyCampaign.update({
          where: { id: f.campaignId },
          data: { voucherDiscountMinor: null },
        })
      )
    ).rejects.toThrow();
  });
  it('keeps redemption evidence append only', async () => {
    const f = await fixture();
    await tenant((db) => addSaleLine(db, scope, lineInput(f)));
    await expect(
      tenant((db) => db.pharmacyVoucherRedemption.deleteMany({ where: { captureId: f.captureId } }))
    ).rejects.toThrow('append-only');
    await expect(
      tenant((db) =>
        db.pharmacyVoucherRedemption.updateMany({
          where: { captureId: f.captureId },
          data: { discountMinor: 1 },
        })
      )
    ).rejects.toThrow('append-only');
    await expect(tenant((db) => addSaleLine(db, scope, lineInput(f)))).rejects.toMatchObject({
      reason: 'VOUCHER_ALREADY_REDEEMED',
    });
  });
});
