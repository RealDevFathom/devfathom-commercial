// Run only on a new, migrated disposable database as NOSUPERUSER NOBYPASSRLS.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { addSaleLine, createSale } from './sales';
import { receiveLot } from './stock-ledger';
import { applyPharmacyTender } from './settlement';
import { readCounterReceipt } from './counter';
import { buildCounterReceiptPreview } from './counter-receipt-presentation';

const url = process.env.PHARMACY727_TEST_DATABASE_URL;
if (url && !new URL(url).pathname.startsWith('/pharmacy727_'))
  throw new Error('PHARMACY727_TEST_DATABASE_URL must identify a new disposable pharmacy727_* database.');
if (url) process.env.DATABASE_URL = url;
const database = url ? describe : describe.skip;
afterAll(async () => { if (url) await db.$disconnect(); });

async function isolated(work: (tx: ScopedDb, scope: { organizationId: string; branchId: string; actorId: string }, sibling: string) => Promise<void>) {
  const rollback = new Error('rollback pharmacy727 fixture');
  try {
    await db.$transaction(async (tx) => {
      const [role] = await tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
      );
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const organizationId = `org_${randomUUID()}`;
      const branchId = `branch_${randomUUID()}`;
      const sibling = `branch_${randomUUID()}`;
      await tx.$queryRawUnsafe("SELECT set_config('app.is_platform_admin', 'true', true)");
      await tx.$executeRawUnsafe(
        `INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,"deploymentMode","createdAt","updatedAt")
         VALUES ($1,$1,$1,$1,'PHARMACY','ACTIVE','SHARED',now(),now())`, organizationId
      );
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)", organizationId
      );
      for (const id of [branchId, sibling]) await tx.pharmacyBranch.create({ data: {
        id, organizationId, code: id, name: 'Promotions test', addressLine: 'Test', city: 'Test', provinceCode: 'PB',
      } });
      await tx.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branchId);
      await work(tx as ScopedDb, { organizationId, branchId, actorId: 'promotion-test-owner' }, sibling);
      throw rollback;
    }, { timeout: 30000 });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

database('#727 pharmacy promotion PostgreSQL acceptance', () => {
  it('enforces tenant/branch RLS, database rule checks and immutable rule content', async () => {
    await isolated(async (tx, scope, sibling) => {
      const data = {
        organizationId: scope.organizationId, branchId: scope.branchId, name: 'Offer',
        createdByUserId: scope.actorId, effectiveFrom: new Date('2026-01-01'),
        effectiveTo: new Date('2100-01-01'), benefitBasisPoints: 1000,
      };
      const offer = await tx.pharmacyPromotion.create({ data });
      const [flags] = await tx.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='pharmacy_promotions'"
      );
      expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      await tx.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", sibling);
      expect(await tx.pharmacyPromotion.findMany({ where: { id: offer.id } })).toEqual([]);
      expect((await tx.pharmacyPromotion.updateMany({ where: { id: offer.id }, data: { active: false } })).count).toBe(0);
      await tx.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", scope.branchId);
      await tx.$queryRawUnsafe("SELECT set_config('app.current_organization_id', 'other_tenant', true)");
      expect(await tx.pharmacyPromotion.findMany({ where: { id: offer.id } })).toEqual([]);
      await tx.$queryRawUnsafe("SELECT set_config('app.current_organization_id', $1, true)", scope.organizationId);
      for (const invalid of [
        { ...data, branchId: sibling },
        { ...data, organizationId: 'other_tenant' },
        { ...data, effectiveTo: data.effectiveFrom },
        { ...data, benefitMinor: 1 },
        { ...data, benefitBasisPoints: 10001 },
        { ...data, medicineId: 'foreign_medicine' },
      ]) {
        await tx.$executeRawUnsafe('SAVEPOINT invalid_offer');
        await expect(tx.pharmacyPromotion.create({ data: invalid })).rejects.toThrow();
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT invalid_offer');
      }
      await tx.$executeRawUnsafe('SAVEPOINT immutable_offer');
      await expect(tx.pharmacyPromotion.update({ where: { id: offer.id }, data: { name: 'Changed' } })).rejects.toThrow();
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT immutable_offer');
      await tx.pharmacyPromotion.update({ where: { id: offer.id }, data: { active: false } });
      await tx.$executeRawUnsafe('SAVEPOINT reactivation');
      await expect(tx.pharmacyPromotion.update({ where: { id: offer.id }, data: { active: true } })).rejects.toThrow();
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT reactivation');
    });
  });

  it('settles the promoted net, posts the same discount and reprints it after deactivation', async () => {
    await isolated(async (tx, scope) => {
      const medicine = await tx.medicine.create({ data: {
        organizationId: scope.organizationId, productName: 'Counter OTC', productFamily: 'PHARMACEUTICAL',
        saleable: true, otc: true,
        presentations: { create: { organizationId: scope.organizationId, presentation: 'Tablet' } },
      }, include: { presentations: true } });
      const presentation = medicine.presentations[0]!;
      const pack = await tx.packLevel.create({ data: {
        organizationId: scope.organizationId, presentationId: presentation.id,
        versionGroupId: randomUUID(), version: 1, level: 'UNIT', unitsPerParent: 1,
        effectiveFrom: new Date('2026-01-01'),
      } });
      const location = await tx.pharmacyStockLocation.create({ data: {
        organizationId: scope.organizationId, branchId: scope.branchId,
        code: 'STORE', name: 'Store', kind: 'STORE',
      } });
      const expiresAt = new Date('2100-01-01');
      const batch = await tx.pharmacyManufacturingBatch.create({ data: {
        organizationId: scope.organizationId, medicineId: medicine.id,
        batchNumber: 'PROMO-727', expiresAt, expiryPrecision: 'DAY',
      } });
      await receiveLot(tx, scope, {
        manufacturingBatchId: batch.id, packLevelId: pack.id, stockLocationId: location.id,
        unitsPerPack: 1, supplierName: 'Test', supplierInvoiceRef: randomUUID(),
        unitCostMinor: 100, printedMrpMinor: 1005, receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY', quantityUnits: 10, idempotencyKey: randomUUID(),
        receivedAt: new Date('2026-01-01'),
      });
      const offer = await tx.pharmacyPromotion.create({ data: {
        organizationId: scope.organizationId, branchId: scope.branchId, medicineId: medicine.id,
        name: 'Nov offer', effectiveFrom: new Date(Date.now() - 60_000), effectiveTo: expiresAt,
        benefitBasisPoints: 1000, createdByUserId: scope.actorId,
      } });
      const sale = await createSale(tx, scope);
      const input = {
        saleId: sale.id, medicineId: medicine.id, presentationId: presentation.id, packLevelId: pack.id,
        saleUnit: 'UNIT' as const, quantity: 3, canonicalUnitsPerSaleUnit: 1, idempotencyKey: randomUUID(),
      };
      const { line } = await addSaleLine(tx, scope, input, { applyCounterPromotions: true });
      expect(line).toMatchObject({ discountMinor: 302, discountKind: 'PROMOTION', promotionId: offer.id });
      const tender = {
        saleId: sale.id, deviceId: randomUUID(), businessDate: new Date('2026-11-01'),
        type: 'BANK_TRANSFER' as const, amountMinor: 2713, idempotencyKey: randomUUID(),
      };
      await applyPharmacyTender(tx, scope, tender);
      const before = await readCounterReceipt(tx, scope, sale.id, { name: 'Test', currency: 'PKR' });
      expect(before.receiptNumber).not.toBeNull();
      expect(before.totals).toMatchObject({ grossMinor: 3015, discountMinor: 302, netMinor: 2713 });
      expect(before.lines[0]!.promotionName).toBe('Nov offer');
      const discounts = await tx.financeJournalLine.aggregate({
        where: { organizationId: scope.organizationId, branchId: scope.branchId,
          sourceLineId: line.id, accountCode: 'SALES_DISCOUNT', side: 'DEBIT' },
        _sum: { amountMinor: true },
      });
      expect(discounts._sum.amountMinor).toBe(302);
      await tx.pharmacyPromotion.update({ where: { id: offer.id }, data: { active: false } });
      const reprint = await readCounterReceipt(tx, scope, sale.id, { name: 'Test', currency: 'PKR' });
      expect(reprint).toEqual(before);
      expect(buildCounterReceiptPreview(reprint, 'en', 58, true)).toContain('Nov offer (-3.02)');
      const next = await createSale(tx, scope);
      const subsequent = await addSaleLine(tx, scope, { ...input, saleId: next.id, idempotencyKey: randomUUID() }, { applyCounterPromotions: true });
      expect(subsequent.line.discountMinor).toBe(0);
      expect(subsequent.line.promotionId).toBeNull();
    });
  });
});
