// WHA-1392: opt-in, newly owned disposable PostgreSQL only. No live fixture authority.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PharmacyDemoResult } from '../scripts/pharmacy-demo-contract';

const reviewRoot = process.env.PHARMACY_DEMO_REVIEW_ROOT;
if (reviewRoot) {
  const metadata = JSON.parse(await readFile(`${reviewRoot}/../pg-owned.json`, 'utf8'));
  if (!/^\/Users\/Saad\/\.paperclip\/p1392-[a-zA-Z0-9_-]+$/.test(metadata.socket))
    throw new Error('NEW_OWNED_UNIX_SOCKET_REQUIRED');
  // Construct only this run's connection; never consume inherited target credentials.
  process.env.DATABASE_URL = `postgresql://review_runtime@localhost:55439/review1392?host=${encodeURIComponent(metadata.socket)}`;
  const { PrismaClient } = await import(
    /* @vite-ignore */ `${reviewRoot}/src/generated/prisma/client.ts`
  );
  const { withTenantDb } = await import(
    /* @vite-ignore */ `${reviewRoot}/src/lib/tenancy/scoped-db.ts`
  );
  const helper = await import(
    /* @vite-ignore */ `${reviewRoot}/scripts/pharmacy-demo-inventory.ts`
  );
  const { targetNamespace } = await import(
    /* @vite-ignore */ `${reviewRoot}/scripts/seed-pharmacy-demo.ts`
  );
  const org = 'oracle_sql_org',
    branch = 'oracle_sql_branch',
    actor = 'oracle_receiver';
  const at = new Date('2026-09-07T07:00:00.000Z');
  const namespace = targetNamespace({
    environment: 'disposable',
    targetKey: 'owned-sql',
    organizationId: org,
    branchId: branch,
  });

  describe('new inventory disposable SQL service proof', () => {
    it('posts real bonus/quarantine stock and rolls back a late caller failure', async () => {
      const owner = new PrismaClient({
        adapter: new PrismaPg({
          host: metadata.socket,
          port: 55439,
          database: 'review1392',
          user: 'review_owner',
        }),
      });
      // Schema-owner-only synthetic prerequisites, never real onboarding/approval evidence.
      const f = await owner.$transaction(async (db: typeof owner) => {
        await db.$queryRawUnsafe("SELECT set_config('app.current_organization_id', $1, true)", org);
        await db.organization.create({
          data: {
            id: org,
            slug: org,
            legalName: 'DISPOSABLE TEST',
            displayName: 'DISPOSABLE TEST',
            vertical: 'PHARMACY',
            currency: 'PKR',
          },
        });
        await db.organizationDepartment.create({
          data: { organizationId: org, key: 'test', name: 'Test' },
        });
        await db.user.create({
          data: {
            id: actor,
            organizationId: org,
            name: 'Synthetic receiver',
            email: 'receiver@example.invalid',
            department: 'test',
            title: 'Test',
          },
        });
        await db.pharmacyBranch.create({
          data: {
            id: branch,
            organizationId: org,
            code: 'TEST',
            name: 'Test',
            addressLine: 'Test',
            city: 'Test',
            provinceCode: 'PB',
          },
        });
        await db.pharmacyCentralPurchasingAccess.create({
          data: { organizationId: org, userId: actor, grantedById: 'synthetic-schema-owner' },
        });
        const medicine = await db.medicine.create({
          data: {
            organizationId: org,
            productName: 'DISPOSABLE synthetic stock',
            productFamily: 'PHARMACEUTICAL',
            presentations: { create: { organizationId: org, presentation: 'Synthetic pack' } },
          },
          include: { presentations: true },
        });
        const pack = await db.packLevel.create({
          data: {
            organizationId: org,
            presentationId: medicine.presentations[0].id,
            versionGroupId: 'test-pack',
            version: 1,
            level: 'STRIP',
            unitsPerParent: 10,
            effectiveFrom: new Date('2026-01-01'),
          },
        });
        const store = await db.pharmacyStockLocation.create({
          data: {
            organizationId: org,
            branchId: branch,
            code: 'STORE',
            name: 'Synthetic store',
            kind: 'STORE',
          },
        });
        const quarantine = await db.pharmacyStockLocation.create({
          data: {
            organizationId: org,
            branchId: branch,
            code: 'QUAR',
            name: 'Synthetic quarantine',
            kind: 'QUARANTINE',
          },
        });
        const supplier = await db.pharmacySupplier.create({
          data: {
            organizationId: org,
            name: 'DISPOSABLE supplier',
            authorized: true,
            licences: {
              create: {
                licenceType: 'DRUG_SALE',
                licenceNumber: 'DISPOSABLE-NOT-LICENCE',
                issuingAuthority: 'SYNTHETIC TEST ONLY',
                issuedAt: new Date('2025-01-01'),
                expiresAt: new Date('2028-01-01'),
                verifiedAt: at,
              },
            },
          },
          include: { licences: true },
        });
        const order = await db.pharmacyPurchaseOrder.create({
          data: {
            organizationId: org,
            branchId: branch,
            reference: `${namespace}po`,
            supplierId: supplier.id,
            createdByUserId: 'synthetic-creator',
            lines: {
              create: {
                lineNumber: 1,
                medicineId: medicine.id,
                packLevelId: pack.id,
                orderedPacks: 4,
                canonicalUnitsPerPack: 10,
                orderedCanonicalUnits: 40,
                listPricePerPackMinor: 15000,
              },
            },
          },
          include: { lines: true },
        });
        await db.pharmacyPurchaseOrder.update({
          where: { id: order.id },
          data: { status: 'SUBMITTED', submittedAt: at },
        });
        await db.pharmacyPurchaseOrder.update({
          where: { id: order.id },
          data: { status: 'APPROVED', approvedAt: at, approvedByUserId: 'synthetic-approver' },
        });
        await db.pharmacyPurchaseOrderApproval.create({
          data: {
            organizationId: org,
            purchaseOrderId: order.id,
            actorUserId: 'synthetic-approver',
            policy: 'PUR-02:SEGREGATION_OF_DUTIES',
            decision: 'APPROVED',
            fromStatus: 'SUBMITTED',
            toStatus: 'APPROVED',
          },
        });
        await db.pharmacyPurchaseOrder.update({
          where: { id: order.id },
          data: { status: 'SENT', sentAt: at },
        });
        const receipt = await db.pharmacyGoodsReceipt.create({
          data: {
            organizationId: org,
            branchId: branch,
            reference: `${namespace}gr`,
            supplierId: supplier.id,
            purchaseOrderId: order.id,
            supplierInvoiceRef: 'DISPOSABLE-INVOICE',
            supplierInvoiceDate: at,
            warrantyEvidenceRef: 'DISPOSABLE-NOT-WARRANTY',
            receivedByUserId: actor,
            receivedAt: at,
            lines: {
              create: {
                lineNumber: 1,
                purchaseOrderLineId: order.lines[0].id,
                medicineId: medicine.id,
                packLevelId: pack.id,
                batchNumber: `${namespace}batch`,
                printedExpiry: new Date('2027-01-01'),
                expiryPrecision: 'DAY',
                printedMrpMinor: 20000,
                canonicalUnitsPerPack: 10,
                receivedPacks: 2,
                bonusPacks: 1,
                receivedCanonicalUnits: 20,
                bonusCanonicalUnits: 10,
                acceptedCanonicalUnits: 28,
                rejectedCanonicalUnits: 2,
                rejectionReason: 'Synthetic damaged pack',
                invoicedPricePerPackMinor: 15000,
                unitCostMinor: 1000,
                stockLocationId: store.id,
                quarantineLocationId: quarantine.id,
              },
            },
          },
        });
        const sentinel = await db.pharmacyStockLocation.create({
          data: {
            organizationId: org,
            branchId: branch,
            code: 'LEGIT-SENTINEL',
            name: 'Unrelated operator row',
            kind: 'STORE',
          },
        });
        return { medicine, pack, store, quarantine, supplier, receipt, sentinel };
      });
      await owner.$disconnect();
      const facts = {
        organizationId: org,
        branchId: branch,
        ownerUserId: 'synthetic-owner',
        actorId: actor,
        namespace,
        businessDate: '2026-09-07',
        scenarioAt: at.toISOString(),
        timezone: 'Asia/Karachi',
        currency: 'PKR',
        purchasingEntitled: true,
        organizationPurchaser: true,
        actors: [
          {
            actorId: actor,
            userId: actor,
            organizationId: org,
            branchId: branch,
            active: true,
            synthetic: true,
            capabilities: [
              'pharmacyPurchasing.createCentralPurchaseOrder',
              'pharmacyPurchasing.postGoodsReceipt',
            ],
          },
        ],
        modules: [{ key: 'pharmacy-procurement', enabled: true }],
        references: [
          ['medicine', f.medicine.id],
          ['presentation', f.medicine.presentations[0].id],
          ['pack', f.pack.id],
          ['supplier', f.supplier.id],
          ['location', f.store.id],
          ['location', f.quarantine.id],
        ].map(([kind, id]) => ({
          kind,
          id,
          organizationId: org,
          branchId: branch,
          approved: true,
          observedHash: 'a'.repeat(64),
        })),
        approvedCatalog: {
          medicineId: f.medicine.id,
          presentationId: f.medicine.presentations[0].id,
          packLevelId: f.pack.id,
          stockLocationId: f.store.id,
          canonicalUnitsPerPack: 10,
        },
        supplier: {
          id: f.supplier.id,
          authorized: true,
          licences: [
            {
              id: f.supplier.licences[0].id,
              verified: true,
              expiresAt: '2028-01-01T00:00:00.000Z',
            },
          ],
        },
        orderedPacks: 4,
        listPricePerPackMinor: 15000,
      };
      const scoped = <T>(fn: (db: typeof owner) => Promise<T>): Promise<T> => withTenantDb(org, fn);
      const snapshot = () =>
        scoped(async (db) => ({
          receipts: await db.pharmacyGoodsReceipt.findMany(),
          lines: await db.pharmacyGoodsReceiptLine.findMany(),
          lots: await db.pharmacyInventoryLot.findMany(),
          batches: await db.pharmacyManufacturingBatch.findMany(),
          movements: await db.pharmacyStockMovement.findMany(),
          balances: await db.pharmacyStockBalance.findMany(),
          exceptions: await db.pharmacyReceivingException.findMany(),
          sentinel: await db.pharmacyStockLocation.findUnique({ where: { id: f.sentinel.id } }),
        }));
      await scoped(async (db) => {
        const roles = await db.$queryRawUnsafe(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
        );
        expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const tables = await db.$queryRawUnsafe(
          "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('pharmacy_inventory_lots','pharmacy_stock_movements','pharmacy_stock_balances','pharmacy_goods_receipts')"
        );
        expect(tables).toHaveLength(4);
        expect(
          tables.every(
            (t: { relrowsecurity: boolean; relforcerowsecurity: boolean }) =>
              t.relrowsecurity && t.relforcerowsecurity
          )
        ).toBe(true);
      });
      const observed = await scoped((db) =>
        helper.observeInventoryDemoReceipt(db, facts, f.receipt.id)
      );
      const input = {
        goodsReceiptId: f.receipt.id,
        reference: f.receipt.reference,
        snapshotHash: helper.inventoryDemoReceiptHash(observed),
        operatorConfirmationReference: 'SYNTHETIC-TEST-ONLY',
        acceptedUnits: 28,
        rejectedUnits: 2,
        unitCostMinor: 1000,
      };
      const plan = helper.planPreparedInventoryReceipt(facts, input);
      expect(plan.unmet).toEqual([]);
      const before = await snapshot();
      await expect(
        scoped(async (db) => {
          const result = await helper.executePreparedInventoryReceipt(db, facts, input, {
            state: 'new',
            hash: plan.digest,
          });
          expect(result.status).toBe('applied');
          throw new Error('LATE_CALLER_FAILURE');
        })
      ).rejects.toThrow('LATE_CALLER_FAILURE');
      expect(await snapshot()).toEqual(before);
      const result = await scoped<PharmacyDemoResult>((db) =>
        helper.executePreparedInventoryReceipt(db, facts, input, {
          state: 'new',
          hash: plan.digest,
        })
      );
      expect(result.status).toBe('applied');
      if (result.status === 'refused') throw new Error('EXPECTED_SQL_APPLICATION');
      const after = await snapshot();
      expect(
        after.balances
          .map((b: { disposition: string; onHandUnits: number }) => [b.disposition, b.onHandUnits])
          .sort()
      ).toEqual([
        ['AVAILABLE', 28],
        ['QUARANTINE', 2],
      ]);
      expect(after.lots).toHaveLength(1);
      expect(after.movements).toHaveLength(2);
      expect(after.receipts[0].status).toBe('POSTED');
      expect(after.exceptions.length).toBeGreaterThan(0);
      expect(after.exceptions.every((e: { status: string }) => e.status === 'OPEN')).toBe(true);
      expect(after.sentinel).toEqual(before.sentinel);
      expect(result.records[0]).toMatchObject({
        persistedId: f.receipt.id,
        observedFacts: {
          acceptedUnits: 28,
          rejectedUnits: 2,
          unitCostMinor: 1000,
          inventoryValueMinor: 30000,
          inventoryLotId: after.lots[0].id,
        },
      });
      expect(
        await scoped((db) =>
          helper.executePreparedInventoryReceipt(db, facts, input, {
            state: 'refuse',
            reason: 'ROOT_REFUSED',
          })
        )
      ).toMatchObject({ status: 'refused' });
      expect(
        await scoped((db) =>
          helper.executePreparedInventoryReceipt(db, facts, input, {
            state: 'preserve',
            hash: plan.digest,
            records: result.records,
          })
        )
      ).toMatchObject({ status: 'replayed' });
      expect(await snapshot()).toEqual(after);
      // Enum short circuits prove no additional work, not durable root reconciliation.
    }, 30000);
  });
}

// NEW 89cf1ba valuation proof. Earlier 148-line receiving regression above is preserved.
if (reviewRoot) {
  const metadata = JSON.parse(await readFile(`${reviewRoot}/../pg-owned.json`, 'utf8'));
  if (!/^\/Users\/Saad\/\.paperclip\/p1392-[a-zA-Z0-9_-]+$/.test(metadata.socket))
    throw new Error('NEW_OWNED_UNIX_SOCKET_REQUIRED');
  // Construct only this run's connection; never consume inherited target credentials.
  process.env.DATABASE_URL = `postgresql://review_runtime@localhost:55439/review1392?host=${encodeURIComponent(metadata.socket)}`;
  const { PrismaClient } = await import(
    /* @vite-ignore */ `${reviewRoot}/src/generated/prisma/client.ts`
  );
  const { withTenantDb } = await import(
    /* @vite-ignore */ `${reviewRoot}/src/lib/tenancy/scoped-db.ts`
  );
  const helper = await import(
    /* @vite-ignore */ `${reviewRoot}/scripts/pharmacy-demo-inventory.ts`
  );
  const { targetNamespace } = await import(
    /* @vite-ignore */ `${reviewRoot}/scripts/seed-pharmacy-demo.ts`
  );
  const org = 'oracle_sql_org',
    branch = 'oracle_sql_branch',
    actor = 'oracle_receiver';
  const at = new Date('2026-09-07T07:00:00.000Z');
  const namespace = targetNamespace({
    environment: 'disposable',
    targetKey: 'owned-sql',
    organizationId: org,
    branchId: branch,
  });

  describe('new receipt valuation independent SQL', () => {
    it('enforces actual mutation authority, conservation, refusal and valuation rollback', async () => {
      const owner = new PrismaClient({
        adapter: new PrismaPg({
          host: metadata.socket,
          port: 55439,
          database: 'review1392',
          user: 'review_owner',
        }),
      });
      // Schema-owner-only synthetic prerequisites, never real onboarding/approval evidence.
      const f = await owner.$transaction(async (db: typeof owner) => {
        await db.$queryRawUnsafe("SELECT set_config('app.current_organization_id', $1, true)", org);
        await db.organization.create({
          data: {
            id: org,
            slug: org,
            legalName: 'DISPOSABLE TEST',
            displayName: 'DISPOSABLE TEST',
            vertical: 'PHARMACY',
            currency: 'PKR',
          },
        });
        await db.organizationDepartment.create({
          data: { organizationId: org, key: 'test', name: 'Test' },
        });
        await db.user.create({
          data: {
            id: actor,
            organizationId: org,
            name: 'Synthetic receiver',
            email: 'receiver@example.invalid',
            role: 'ADMIN',
            department: 'test',
            title: 'Test',
          },
        });
        await db.pharmacyBranch.create({
          data: {
            id: branch,
            organizationId: org,
            code: 'TEST',
            name: 'Test',
            addressLine: 'Test',
            city: 'Test',
            provinceCode: 'PB',
          },
        });
        await db.pharmacyCentralPurchasingAccess.create({
          data: { organizationId: org, userId: actor, grantedById: 'synthetic-schema-owner' },
        });
        const medicine = await db.medicine.create({
          data: {
            organizationId: org,
            productName: 'DISPOSABLE synthetic stock',
            productFamily: 'PHARMACEUTICAL',
            presentations: { create: { organizationId: org, presentation: 'Synthetic pack' } },
          },
          include: { presentations: true },
        });
        const pack = await db.packLevel.create({
          data: {
            organizationId: org,
            presentationId: medicine.presentations[0].id,
            versionGroupId: 'test-pack',
            version: 1,
            level: 'STRIP',
            unitsPerParent: 10,
            effectiveFrom: new Date('2026-01-01'),
          },
        });
        const store = await db.pharmacyStockLocation.create({
          data: {
            organizationId: org,
            branchId: branch,
            code: 'STORE',
            name: 'Synthetic store',
            kind: 'STORE',
          },
        });
        const quarantine = await db.pharmacyStockLocation.create({
          data: {
            organizationId: org,
            branchId: branch,
            code: 'QUAR',
            name: 'Synthetic quarantine',
            kind: 'QUARANTINE',
          },
        });
        const supplier = await db.pharmacySupplier.create({
          data: {
            organizationId: org,
            name: 'DISPOSABLE supplier',
            authorized: true,
            licences: {
              create: {
                licenceType: 'DRUG_SALE',
                licenceNumber: 'DISPOSABLE-NOT-LICENCE',
                issuingAuthority: 'SYNTHETIC TEST ONLY',
                issuedAt: new Date('2025-01-01'),
                expiresAt: new Date('2028-01-01'),
                verifiedAt: at,
              },
            },
          },
          include: { licences: true },
        });
        const order = await db.pharmacyPurchaseOrder.create({
          data: {
            organizationId: org,
            branchId: branch,
            reference: `${namespace}po`,
            supplierId: supplier.id,
            createdByUserId: 'synthetic-creator',
            lines: {
              create: {
                lineNumber: 1,
                medicineId: medicine.id,
                packLevelId: pack.id,
                orderedPacks: 4,
                canonicalUnitsPerPack: 10,
                orderedCanonicalUnits: 40,
                listPricePerPackMinor: 15000,
              },
            },
          },
          include: { lines: true },
        });
        await db.pharmacyPurchaseOrder.update({
          where: { id: order.id },
          data: { status: 'SUBMITTED', submittedAt: at },
        });
        await db.pharmacyPurchaseOrder.update({
          where: { id: order.id },
          data: { status: 'APPROVED', approvedAt: at, approvedByUserId: 'synthetic-approver' },
        });
        await db.pharmacyPurchaseOrderApproval.create({
          data: {
            organizationId: org,
            purchaseOrderId: order.id,
            actorUserId: 'synthetic-approver',
            policy: 'PUR-02:SEGREGATION_OF_DUTIES',
            decision: 'APPROVED',
            fromStatus: 'SUBMITTED',
            toStatus: 'APPROVED',
          },
        });
        await db.pharmacyPurchaseOrder.update({
          where: { id: order.id },
          data: { status: 'SENT', sentAt: at },
        });
        const receipt = await db.pharmacyGoodsReceipt.create({
          data: {
            organizationId: org,
            branchId: branch,
            reference: `${namespace}gr`,
            supplierId: supplier.id,
            purchaseOrderId: order.id,
            supplierInvoiceRef: 'DISPOSABLE-INVOICE',
            supplierInvoiceDate: at,
            warrantyEvidenceRef: 'DISPOSABLE-NOT-WARRANTY',
            receivedByUserId: actor,
            receivedAt: at,
            lines: {
              create: {
                lineNumber: 1,
                purchaseOrderLineId: order.lines[0].id,
                medicineId: medicine.id,
                packLevelId: pack.id,
                batchNumber: `${namespace}batch`,
                printedExpiry: new Date('2027-01-01'),
                expiryPrecision: 'DAY',
                printedMrpMinor: 20000,
                canonicalUnitsPerPack: 10,
                receivedPacks: 2,
                bonusPacks: 1,
                receivedCanonicalUnits: 20,
                bonusCanonicalUnits: 10,
                acceptedCanonicalUnits: 28,
                rejectedCanonicalUnits: 2,
                rejectionReason: 'Synthetic damaged pack',
                invoicedPricePerPackMinor: 15000,
                unitCostMinor: 1000,
                stockLocationId: store.id,
                quarantineLocationId: quarantine.id,
              },
            },
          },
        });
        const sentinel = await db.pharmacyStockLocation.create({
          data: {
            organizationId: org,
            branchId: branch,
            code: 'LEGIT-SENTINEL',
            name: 'Unrelated operator row',
            kind: 'STORE',
          },
        });
        return { medicine, pack, store, quarantine, supplier, receipt, sentinel };
      });
      for (const [id, role] of [
        ['valuation-denied', 'ADMIN'],
        ['valuation-reader', 'EMPLOYEE'],
      ]) {
        await owner.user.create({
          data: {
            id,
            organizationId: org,
            name: 'TEST only',
            email: id + '@example.invalid',
            role,
            department: 'test',
            title: 'TEST',
          },
        });
      }
      await owner.userPermissionOverride.create({
        data: {
          organizationId: org,
          userId: 'valuation-denied',
          capability: 'admin:access',
          effect: 'DENY',
          reason: 'DISPOSABLE explicit denial',
        },
      });
      await owner.userPermissionOverride.create({
        data: {
          organizationId: org,
          userId: 'valuation-reader',
          capability: 'finance:read',
          effect: 'ALLOW',
          reason: 'DISPOSABLE read only',
        },
      });
      await owner.organization.create({
        data: {
          id: 'valuation_foreign',
          slug: 'valuation-foreign',
          legalName: 'FOREIGN TEST',
          displayName: 'FOREIGN TEST',
        },
      });
      await owner.pharmacyBranch.create({
        data: {
          id: 'valuation_foreign_branch',
          organizationId: 'valuation_foreign',
          code: 'FOREIGN',
          name: 'FOREIGN TEST',
          addressLine: 'TEST',
          city: 'TEST',
          provinceCode: 'PB',
        },
      });
      await owner.pharmacyStockLocation.create({
        data: {
          organizationId: 'valuation_foreign',
          branchId: 'valuation_foreign_branch',
          code: 'FOREIGN-SENTINEL',
          name: 'Unrelated foreign row',
          kind: 'STORE',
        },
      });
      await owner.$disconnect();
      const facts = {
        organizationId: org,
        branchId: branch,
        ownerUserId: 'synthetic-owner',
        actorId: actor,
        namespace,
        businessDate: '2026-09-07',
        scenarioAt: at.toISOString(),
        timezone: 'Asia/Karachi',
        currency: 'PKR',
        purchasingEntitled: true,
        organizationPurchaser: true,
        actors: [
          {
            actorId: actor,
            userId: actor,
            organizationId: org,
            branchId: branch,
            active: true,
            synthetic: true,
            capabilities: [
              'pharmacyPurchasing.createCentralPurchaseOrder',
              'pharmacyPurchasing.postGoodsReceipt',
            ],
          },
        ],
        modules: [{ key: 'pharmacy-procurement', enabled: true }],
        references: [
          ['medicine', f.medicine.id],
          ['presentation', f.medicine.presentations[0].id],
          ['pack', f.pack.id],
          ['supplier', f.supplier.id],
          ['location', f.store.id],
          ['location', f.quarantine.id],
        ].map(([kind, id]) => ({
          kind,
          id,
          organizationId: org,
          branchId: branch,
          approved: true,
          observedHash: 'a'.repeat(64),
        })),
        approvedCatalog: {
          medicineId: f.medicine.id,
          presentationId: f.medicine.presentations[0].id,
          packLevelId: f.pack.id,
          stockLocationId: f.store.id,
          canonicalUnitsPerPack: 10,
        },
        supplier: {
          id: f.supplier.id,
          authorized: true,
          licences: [
            {
              id: f.supplier.licences[0].id,
              verified: true,
              expiresAt: '2028-01-01T00:00:00.000Z',
            },
          ],
        },
        orderedPacks: 4,
        listPricePerPackMinor: 15000,
      };
      const scoped = <T>(fn: (db: typeof owner) => Promise<T>): Promise<T> => withTenantDb(org, fn);
      const snapshot = () =>
        scoped(async (db) => ({
          receipts: await db.pharmacyGoodsReceipt.findMany(),
          lines: await db.pharmacyGoodsReceiptLine.findMany(),
          lots: await db.pharmacyInventoryLot.findMany(),
          batches: await db.pharmacyManufacturingBatch.findMany(),
          movements: await db.pharmacyStockMovement.findMany(),
          balances: await db.pharmacyStockBalance.findMany(),
          exceptions: await db.pharmacyReceivingException.findMany(),
          entries: await db.financeJournalEntry.findMany({ include: { lines: true } }),
          sentinel: await db.pharmacyStockLocation.findUnique({ where: { id: f.sentinel.id } }),
        }));
      await scoped(async (db) => {
        const roles = await db.$queryRawUnsafe(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
        );
        expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const tables = await db.$queryRawUnsafe(
          "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('pharmacy_inventory_lots','pharmacy_stock_movements','pharmacy_stock_balances','pharmacy_goods_receipts')"
        );
        expect(tables).toHaveLength(4);
        expect(
          tables.every(
            (t: { relrowsecurity: boolean; relforcerowsecurity: boolean }) =>
              t.relrowsecurity && t.relforcerowsecurity
          )
        ).toBe(true);
      });
      const observed = await scoped((db) =>
        helper.observeInventoryDemoReceipt(db, facts, f.receipt.id)
      );
      const input = {
        goodsReceiptId: f.receipt.id,
        reference: f.receipt.reference,
        snapshotHash: helper.inventoryDemoReceiptHash(observed),
        operatorConfirmationReference: 'SYNTHETIC-TEST-ONLY',
        acceptedUnits: 28,
        rejectedUnits: 2,
        unitCostMinor: 1000,
      };
      const plan = helper.planPreparedInventoryReceipt(facts, input);
      expect(plan.unmet).toEqual([]);

      // Receiving is setup only; no count or rerun of the old receiving proof.
      const received = await scoped<PharmacyDemoResult>((db) =>
        helper.executePreparedInventoryReceipt(db, facts, input, {
          state: 'new',
          hash: plan.digest,
        })
      );
      if (received.status !== 'applied') throw new Error('RECEIVING_SETUP_REFUSED');
      const posted = await scoped((db) =>
        helper.observeInventoryDemoReceipt(db, facts, f.receipt.id)
      );
      facts.modules.push({ key: 'finance', enabled: true });
      facts.actors[0].capabilities.push('admin:access');
      const valuation = {
        actorId: actor,
        received: received.records[0],
        postedReceiptHash: helper.inventoryDemoReceiptHash(posted),
      };
      const vp = helper.planInventoryReceiptValuation(facts, valuation);
      expect(vp.unmet).toEqual([]);
      const execute = (ctx = facts, value = valuation) =>
        scoped<PharmacyDemoResult>((db) =>
          helper.executeInventoryReceiptValuation(db, ctx, value, {
            state: 'new',
            hash: helper.planInventoryReceiptValuation(ctx, value).digest,
          })
        );
      const before = await snapshot();
      const foreignSnapshot = () =>
        withTenantDb('valuation_foreign', async (db: typeof owner) =>
          db.pharmacyStockLocation.findMany({ orderBy: { id: 'asc' } })
        );
      const foreignBefore = await foreignSnapshot();
      for (const id of ['valuation-denied', 'valuation-reader']) {
        const ctx = { ...facts, actors: [{ ...facts.actors[0], actorId: id, userId: id }] };
        expect(await execute(ctx, { ...valuation, actorId: id })).toMatchObject({
          status: 'refused',
          unmetPrerequisites: ['FINANCE_POSTING_FORBIDDEN'],
        });
      }
      expect(
        await execute({
          ...facts,
          branchId: 'valuation_foreign_branch',
          actors: [{ ...facts.actors[0], branchId: 'valuation_foreign_branch' }],
        })
      ).toMatchObject({
        status: 'refused',
        unmetPrerequisites: ['POSTED_RECEIPT_CHANGED_OR_FOREIGN'],
      });
      expect(
        await execute(facts, { ...valuation, postedReceiptHash: 'b'.repeat(64) })
      ).toMatchObject({
        status: 'refused',
        unmetPrerequisites: ['POSTED_RECEIPT_CHANGED_OR_FOREIGN'],
      });
      const editedFacts = { ...valuation.received.observedFacts, inventoryValueMinor: 1 };
      const { createHash } = await import('node:crypto');
      expect(
        await execute(facts, {
          ...valuation,
          received: {
            ...valuation.received,
            observedFacts: editedFacts,
            observedHash: createHash('sha256').update(JSON.stringify(editedFacts)).digest('hex'),
          },
        })
      ).toMatchObject({ status: 'refused', unmetPrerequisites: ['RECEIVING_VALUATION_MISMATCH'] });
      expect(await snapshot()).toEqual(before);
      await expect(
        scoped(async (db) => {
          const result = await helper.executeInventoryReceiptValuation(db, facts, valuation, {
            state: 'new',
            hash: vp.digest,
          });
          expect(result.status).toBe('applied');
          throw new Error('LATE_VALUATION_FAILURE');
        })
      ).rejects.toThrow('LATE_VALUATION_FAILURE');
      expect(await snapshot()).toEqual(before);
      const result = await execute();
      expect(result.status).toBe('applied');
      if (result.status === 'refused') throw new Error('VALUATION_REFUSED');
      const after = await snapshot();
      expect(after.entries).toHaveLength(1);
      const entry = after.entries[0];
      expect(entry.id).toBe(result.records[0].persistedId);
      expect(entry.sourceId).toBe(f.receipt.id);
      expect(entry.sourceKind).toBe('PHARMACY_GOODS_RECEIPT');
      expect(entry.currency).toBe('PKR');
      expect(
        entry.lines
          .map(
            (l: {
              accountCode: string;
              side: string;
              amountMinor: number;
              locationId: string | null;
            }) => [l.accountCode, l.side, l.amountMinor, l.locationId]
          )
          .sort()
      ).toEqual(
        [
          ['GOODS_RECEIVED_ACCRUAL', 'CREDIT', 30000, null],
          ['INVENTORY', 'DEBIT', 2000, f.quarantine.id],
          ['INVENTORY', 'DEBIT', 28000, f.store.id],
        ].sort()
      );
      for (const line of entry.lines.filter(
        (l: { accountCode: string }) => l.accountCode === 'INVENTORY'
      )) {
        expect(line.productId).toBe(f.medicine.id);
        expect(line.lotId).toBe(before.lots[0].id);
        expect(line.branchId).toBe(branch);
      }
      expect(result.records[0]).toMatchObject({
        observedFacts: {
          paidUnits: 20,
          bonusUnits: 10,
          acceptedUnits: 28,
          quarantinedUnits: 2,
          inventoryMinor: 30000,
          accrualMinor: 30000,
        },
      });
      expect({ ...after, entries: [] }).toEqual(before);
      expect(await execute()).toMatchObject({
        status: 'refused',
        unmetPrerequisites: ['RECEIPT_VALUATION_ALREADY_EXISTS'],
      });
      expect(await snapshot()).toEqual(after);
      expect(await foreignSnapshot()).toEqual(foreignBefore);
      // Fresh-only calls; no root durability, concurrent serialization or live authority proof.
    }, 30000);
  });
}
