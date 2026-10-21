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
