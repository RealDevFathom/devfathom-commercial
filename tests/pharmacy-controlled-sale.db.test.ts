import { expect, it, vi } from 'vitest';
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(),
}));
import { pharmacySalesRouter } from '@/server/routers/pharmacy-sales';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';
import {
  prepareControlledFixture,
  pharmacistPin,
  staffId,
} from './e2e/pharmacy-controlled-fixture';
import { PHARMACY_E2E as f } from './e2e/pharmacy-counter-fixture';

it.skipIf(process.env.PHARMACY_E2E !== '1')(
  'adds an authorized controlled line with its fill, signature and reconciled register atomically',
  async () => {
    await prepareControlledFixture();
    const rollback = new Error('rollback test sale');
    await expect(
      withTenantDb(
        f.organizationId,
        async (db) => {
          const caller = pharmacySalesRouter.createCaller({
            db,
            entitlements: {
              organizationId: f.organizationId,
              enabledModules: ['pharmacy-counter'],
              modules: [],
            },
            session: {
              expires: 'later',
              user: {
                id: f.adminId,
                role: 'ADMIN',
                status: 'ACTIVE',
                organizationId: f.organizationId,
              },
            },
            organization: { id: f.organizationId },
            support: null,
            requestMeta: { ip: null, userAgent: null },
            audit: { detail: {} },
          } as unknown as TRPCContext);
          const sale = await caller.create({ branchId: f.branchId });
          const result = await caller.addLine({
            branchId: f.branchId,
            saleId: sale.id,
            medicineId: f.medicines.rx.id,
            presentationId: f.medicines.rx.presentationId,
            packLevelId: f.medicines.rx.packLevelIds.unit,
            saleUnit: 'UNIT',
            quantity: 1,
            canonicalUnitsPerSaleUnit: 1,
            idempotencyKey: 'controlled-db-success',
            controlledAuthorization: {
              patientId: f.patientId,
              prescriptionLineId: f.medicines.rx.prescriptionLineId,
              staffProfileId: staffId,
              pin: pharmacistPin,
            },
          });
          expect(result).not.toHaveProperty('blocked');
          if ('blocked' in result) throw new Error(result.blocked);
          const entries = await db.pharmacyControlledRegisterEntry.findMany({
            where: { stockMovementId: { in: result.allocation.movementIds } },
          });
          expect(entries).toHaveLength(1);
          const actual = await db.pharmacyStockBalance.aggregate({
            where: { inventoryLotId: entries[0].inventoryLotId, branchId: f.branchId },
            _sum: { onHandUnits: true },
          });
          expect(entries[0].runningBalance).toBe(actual._sum.onHandUnits);
          expect(
            await db.prescriptionFill.count({
              where: { idempotencyKey: `controlled:${result.line.id}` },
            })
          ).toBe(1);
          expect(
            await db.pharmacyPharmacistReviewItem.count({
              where: { saleLineId: result.line.id, decisions: { some: { kind: 'SIGN' } } },
            })
          ).toBe(1);
          throw rollback;
        },
        { timeout: 30000 }
      )
    ).rejects.toBe(rollback);
  },
  45000
);
