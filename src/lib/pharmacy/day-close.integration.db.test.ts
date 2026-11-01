// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { PHARMACY_E2E as fixture } from '../../../tests/e2e/pharmacy-counter-fixture';
import { closePharmacyDay, readPharmacyClose } from './day-close';
import { openPharmacyDrawer } from './settlement';

const enabled = process.env.PHARMACY_E2E === '1' && !!process.env.PHARMACY_E2E_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.PHARMACY_E2E_DATABASE_URL;

describe.skipIf(!enabled)('pharmacy day close database boundaries', () => {
  it.each([
    ['an empty day', false, 0],
    ['a day with completed sales', true, 1_250],
  ] as const)(
    'closes %s without mutating append-only rows',
    async (_label, withSale, grossMinor) => {
      const id = randomUUID();
      const branchId = `branch_close_case_${id}`;
      const businessDate = new Date('2036-10-20T00:00:00.000Z');
      const scope = { organizationId: fixture.organizationId, branchId, actorId: fixture.adminId };

      const close = await withTenantDb(scope.organizationId, async (db) => {
        await db.pharmacyBranch.create({
          data: {
            id: branchId,
            organizationId: scope.organizationId,
            code: `CASE-${id}`,
            name: 'Day close case branch',
            addressLine: '1 Test Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
        if (withSale) {
          const medicine = await db.medicine.create({
            data: {
              organizationId: scope.organizationId,
              productName: 'Synthetic day-close medicine',
              productFamily: 'PHARMACEUTICAL',
            },
          });
          const presentation = await db.presentation.create({
            data: {
              organizationId: scope.organizationId,
              medicineId: medicine.id,
              presentation: 'Tablet',
            },
          });
          const pack = await db.packLevel.create({
            data: {
              organizationId: scope.organizationId,
              presentationId: presentation.id,
              versionGroupId: `close-pack-${id}`,
              version: 1,
              level: 'UNIT',
              unitsPerParent: 1,
              effectiveFrom: new Date('2036-01-01'),
            },
          });
          const sale = await db.pharmacySale.create({
            data: {
              organizationId: scope.organizationId,
              branchId,
              createdByUserId: scope.actorId,
              status: 'COMPLETED',
              completedAt: new Date(),
              businessDate,
            },
          });
          await db.pharmacySaleLine.create({
            data: {
              organizationId: scope.organizationId,
              branchId,
              saleId: sale.id,
              medicineId: medicine.id,
              presentationId: presentation.id,
              packLevelId: pack.id,
              saleUnit: 'UNIT',
              quantity: 1,
              canonicalUnitsPerSaleUnit: 1,
              canonicalUnits: 1,
              unitPriceMinor: grossMinor,
              proRataCeilingMinor: grossMinor,
              unitCostMinor: 500,
              idempotencyKey: `close-sale-${id}`,
            },
          });
        }
        const preview = await readPharmacyClose(db, scope, businessDate);
        return closePharmacyDay(db, scope, {
          businessDate,
          sourceHash: preview.totals.sourceHash,
          counts: [],
          varianceNote: '',
        });
      });

      expect(close).toMatchObject({ sequence: 1, grossSalesMinor: grossMinor });
    }
  );

  it('closes and locks a day with one immutable close insert', async () => {
    const id = randomUUID();
    const branchId = `branch_day_close_${id}`;
    const businessDate = new Date('2036-10-21T00:00:00.000Z');
    const scope = {
      organizationId: fixture.organizationId,
      branchId,
      actorId: fixture.adminId,
    };

    const close = await withTenantDb(scope.organizationId, async (db) => {
      await db.pharmacyBranch.create({
        data: {
          id: branchId,
          organizationId: scope.organizationId,
          code: `CLOSE-${id}`,
          name: 'Day close regression branch',
          addressLine: '1 Test Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      await openPharmacyDrawer(db, scope, {
        businessDate,
        deviceId: `device_${id}`,
        openingFloatMinor: 10_000,
      });
      const preview = await readPharmacyClose(db, scope, businessDate);
      return closePharmacyDay(db, scope, {
        businessDate,
        sourceHash: preview.totals.sourceHash,
        counts: [{ drawerSessionId: preview.drawers[0]!.id, countedCashMinor: 9_900 }],
        varianceNote: 'Short by one rupee at count.',
      });
    });

    expect(close).toMatchObject({
      organizationId: scope.organizationId,
      branchId,
      businessDate,
      sequence: 1,
      reason: 'Short by one rupee at count.',
      cashExpectedMinor: 10_000,
      cashCountedMinor: 9_900,
      cashVarianceMinor: -100,
    });

    await expect(
      withTenantDb(scope.organizationId, (db) =>
        db.pharmacyDailyClose.update({
          where: {
            organizationId_id: { organizationId: scope.organizationId, id: close.id },
          },
          data: { reason: 'An update must never rewrite close evidence.' },
        })
      )
    ).rejects.toThrow(/append-only/i);
  });
});
