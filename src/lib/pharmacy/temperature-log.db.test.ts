/**
 * INV-05 temperature ingestion against migrated PostgreSQL with FORCE RLS.
 * This suite must run with a restricted runtime URL; without one it is
 * deliberately skipped so the release gate can reject a skipped focused run.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1337_a_${suffix}`;
const ORG_B = `org_wha1337_b_${suffix}`;
const BRANCH_A = `branch_wha1337_a_${suffix}`;
const BRANCH_B = `branch_wha1337_b_${suffix}`;
const ACTOR = 'cold_chain_operator';

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  temperature: typeof import('./temperature-log');
  ledger: typeof import('./stock-ledger');
  signals: typeof import('./stock-signals-operations');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

async function location(
  organizationId: string,
  branchId: string,
  kind: 'COLD' | 'AMBIENT'
): Promise<string> {
  return inOrg(organizationId, async (db) => {
    await db.pharmacyBranch.createMany({
      data: [
        {
          id: branchId,
          organizationId,
          code: branchId,
          name: `Branch ${branchId}`,
          addressLine: '1 Cold Chain Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      ],
      skipDuplicates: true,
    });
    const created = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId,
        code: `${kind}-${randomBytes(4).toString('hex')}`,
        name: kind === 'COLD' ? 'Vaccine fridge' : 'Ambient shelf',
        kind: kind === 'COLD' ? 'FRIDGE' : 'STORE',
        coldChain: kind === 'COLD',
        minimumTemperatureC: kind === 'COLD' ? 2 : null,
        maximumTemperatureC: kind === 'COLD' ? 8 : null,
        expectedTemperatureReadingIntervalMinutes: 15,
        temperatureExcursionDurationMinutes: 30,
      },
    });
    return created.id;
  });
}

function scope(organizationId: string, branchId: string) {
  return { organizationId, branchId, actorId: ACTOR };
}

async function rejection(
  organizationId: string,
  work: (db: ScopedDb) => Promise<unknown>
): Promise<string> {
  return inOrg(organizationId, (db) =>
    work(db)
      .then(() => 'ACCEPTED — expected rejection')
      .catch((error: Error) => error.message)
  );
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, temperature, ledger, signals, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./temperature-log'),
    import('./stock-ledger'),
    import('./stock-signals-operations'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, temperature, ledger, signals };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
}, 120_000);

describeIfDatabase('INV-05 temperature ingestion persistence', () => {
  it('stores a whole logger import with source and optional device attribution', async () => {
    const locationId = await location(ORG_A, BRANCH_A, 'COLD');
    const rows = await inOrg(ORG_A, async (db) => {
      const result = await deps.temperature.ingestTemperatureReadings(
        db,
        scope(ORG_A, BRANCH_A),
        locationId,
        new deps.temperature.CsvTemperatureReadingSource(
          'recordedAt,temperatureC,deviceIdentifier\n' +
            '2026-09-05T08:00:00.000Z,5.2,LOGGER-42\n' +
            '2026-09-05T08:15:00.000Z,8.4,\n'
        )
      );
      expect(result).toEqual({ count: 2 });
      return db.pharmacyTemperatureLog.findMany({
        where: { stockLocationId: locationId },
        orderBy: { recordedAt: 'asc' },
      });
    });
    expect(rows).toMatchObject([
      { source: 'IMPORT', deviceIdentifier: 'LOGGER-42', outOfRange: false },
      { source: 'IMPORT', deviceIdentifier: null, outOfRange: true },
    ]);
  });

  it("makes another organization's zone and readings invisible and unwritable", async () => {
    const locationId = await location(ORG_A, BRANCH_A, 'COLD');
    await inOrg(ORG_A, (db) =>
      deps.temperature.ingestTemperatureReadings(
        db,
        scope(ORG_A, BRANCH_A),
        locationId,
        new deps.temperature.ManualTemperatureReadingSource({
          temperatureC: 5,
          recordedAt: new Date('2026-09-05T09:00:00.000Z'),
        })
      )
    );

    const visible = await inOrg(ORG_B, async (db) => {
      await db.pharmacyBranch.createMany({
        data: [
          {
            id: BRANCH_B,
            organizationId: ORG_B,
            code: BRANCH_B,
            name: 'Other organization branch',
            addressLine: '2 Isolation Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        ],
        skipDuplicates: true,
      });
      return db.pharmacyTemperatureLog.findMany({
        where: { organizationId: ORG_A, stockLocationId: locationId },
      });
    });
    expect(visible).toEqual([]);

    const message = await rejection(ORG_B, (db) =>
      db.pharmacyTemperatureLog.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          stockLocationId: locationId,
          actorId: ACTOR,
          temperatureC: 5,
          recordedAt: new Date('2026-09-05T09:15:00.000Z'),
          outOfRange: false,
          source: 'MANUAL',
        },
      })
    );
    expect(message).not.toBe('ACCEPTED — expected rejection');
  });

  it('rejects update and delete while retaining the original reading', async () => {
    const locationId = await location(ORG_A, BRANCH_A, 'COLD');
    const logId = await inOrg(ORG_A, async (db) => {
      await deps.temperature.ingestTemperatureReadings(
        db,
        scope(ORG_A, BRANCH_A),
        locationId,
        new deps.temperature.ManualTemperatureReadingSource({
          temperatureC: 5.4,
          recordedAt: new Date('2026-09-05T10:00:00.000Z'),
        })
      );
      return (
        await db.pharmacyTemperatureLog.findFirstOrThrow({
          where: { stockLocationId: locationId },
        })
      ).id;
    });

    expect(
      await rejection(ORG_A, (db) =>
        db.pharmacyTemperatureLog.update({
          where: { id: logId },
          data: { temperatureC: 6.2 },
        })
      )
    ).not.toBe('ACCEPTED — expected rejection');
    expect(
      await rejection(ORG_A, (db) => db.pharmacyTemperatureLog.delete({ where: { id: logId } }))
    ).not.toBe('ACCEPTED — expected rejection');
    await expect(
      inOrg(ORG_A, (db) => db.pharmacyTemperatureLog.findUniqueOrThrow({ where: { id: logId } }))
    ).resolves.toMatchObject({ temperatureC: 5.4 });
  });

  it('accepts ambient readings but never derives a cold-chain excursion', async () => {
    const locationId = await location(ORG_A, BRANCH_A, 'AMBIENT');
    const at = new Date('2026-09-05T11:00:00.000Z');
    const result = await inOrg(ORG_A, async (db) => {
      await deps.temperature.ingestTemperatureReadings(
        db,
        scope(ORG_A, BRANCH_A),
        locationId,
        new deps.temperature.CsvTemperatureReadingSource(
          'recordedAt,temperatureC\n' +
            '2026-09-05T10:30:00.000Z,45\n' +
            '2026-09-05T10:45:00.000Z,46\n' +
            '2026-09-05T11:00:00.000Z,47\n'
        )
      );
      return {
        logs: await db.pharmacyTemperatureLog.findMany({ where: { stockLocationId: locationId } }),
        statuses: await deps.temperature.loadTemperatureZoneStatuses(
          db,
          scope(ORG_A, BRANCH_A),
          at,
          [locationId]
        ),
      };
    });
    expect(result.logs.every((row) => row.outOfRange === false)).toBe(true);
    expect(result.statuses).toMatchObject([{ stockLocationId: locationId, status: 'MONITORED' }]);
  });

  it('feeds only a sustained excursion into the existing PUR-07 COLD_CHAIN signal path', async () => {
    const locationId = await location(ORG_A, BRANCH_A, 'COLD');
    const signalKinds = await inOrg(ORG_A, async (db) => {
      const medicine = await db.medicine.create({
        data: {
          organizationId: ORG_A,
          productName: `Cold medicine ${randomBytes(4).toString('hex')}`,
          productFamily: 'PHARMACEUTICAL',
          coldChain: true,
          presentations: {
            create: { organizationId: ORG_A, presentation: 'Vial, 10 per pack' },
          },
        },
        include: { presentations: true },
      });
      const packLevel = await db.packLevel.create({
        data: {
          organizationId: ORG_A,
          presentationId: medicine.presentations[0]!.id,
          versionGroupId: `pack-${randomBytes(4).toString('hex')}`,
          version: 1,
          level: 'STRIP',
          unitsPerParent: 10,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: ORG_A,
          medicineId: medicine.id,
          batchNumber: `B-${randomBytes(4).toString('hex')}`,
          expiresAt: new Date('2028-01-01T00:00:00.000Z'),
          expiryPrecision: 'DAY',
        },
      });
      await deps.ledger.receiveLot(db, scope(ORG_A, BRANCH_A), {
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        stockLocationId: locationId,
        unitsPerPack: 10,
        supplierName: 'Cold Distributor',
        supplierInvoiceRef: `INV-${randomBytes(4).toString('hex')}`,
        unitCostMinor: 100,
        printedMrpMinor: 200,
        receivedExpiresAt: batch.expiresAt as Date,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 10,
        idempotencyKey: `receive-${randomBytes(4).toString('hex')}`,
        receivedAt: new Date('2026-09-01T00:00:00.000Z'),
      });

      await deps.temperature.ingestTemperatureReadings(
        db,
        scope(ORG_A, BRANCH_A),
        locationId,
        new deps.temperature.ManualTemperatureReadingSource({
          temperatureC: 8.5,
          recordedAt: new Date('2026-09-05T10:30:00.000Z'),
        })
      );
      const pending = await deps.signals.refreshStockSignals(
        db,
        scope(ORG_A, BRANCH_A),
        new Date('2026-09-05T10:30:00.000Z')
      );
      expect(pending.signals.map((signal) => signal.kind)).not.toContain('COLD_CHAIN');

      await deps.temperature.ingestTemperatureReadings(
        db,
        scope(ORG_A, BRANCH_A),
        locationId,
        new deps.temperature.CsvTemperatureReadingSource(
          'recordedAt,temperatureC,deviceIdentifier\n' +
            '2026-09-05T10:45:00.000Z,8.6,LOGGER-42\n' +
            '2026-09-05T11:00:00.000Z,8.7,LOGGER-42\n'
        )
      );
      await deps.signals.refreshStockSignals(
        db,
        scope(ORG_A, BRANCH_A),
        new Date('2026-09-05T11:00:00.000Z')
      );
      return db.pharmacyStockSignal.findMany({
        where: { stockLocationId: locationId, status: 'OPEN' },
        select: { kind: true },
      });
    });
    expect(signalKinds).toEqual([{ kind: 'COLD_CHAIN' }]);
  });

  it('writes nothing when a later import row is invalid', async () => {
    const locationId = await location(ORG_A, BRANCH_A, 'COLD');
    await expect(
      inOrg(ORG_A, (db) =>
        deps.temperature.ingestTemperatureReadings(
          db,
          scope(ORG_A, BRANCH_A),
          locationId,
          new deps.temperature.CsvTemperatureReadingSource(
            'recordedAt,temperatureC\n' + '2026-09-05T12:00:00.000Z,5\n' + 'invalid,6\n'
          )
        )
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyTemperatureLog.count({ where: { stockLocationId: locationId } })
      )
    ).resolves.toBe(0);
  });
});
