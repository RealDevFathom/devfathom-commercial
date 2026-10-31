/**
 * #732 — live cold-chain sensor push against migrated PostgreSQL with FORCE
 * RLS. This suite must run with a restricted runtime URL; without one it is
 * deliberately skipped so the release gate can reject a skipped focused run.
 *
 * Entitlement resolution is stubbed to "pharmacy-inventory enabled" (and to
 * "disabled" in one case): package/contract plumbing is proved elsewhere, and
 * this suite is about where readings land and who can see them.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const entitlements = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
  resolveOrganizationEntitlements: async () => ({
    enabledModules: entitlements.enabled ? ['pharmacy-inventory'] : [],
  }),
}));

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_i732_a_${suffix}`;
const ORG_B = `org_i732_b_${suffix}`;
const BRANCH_A = `branch_i732_a_${suffix}`;
const BRANCH_B = `branch_i732_b_${suffix}`;
const ORG_C = `org_i732_c_${suffix}`;
const BRANCH_C = `branch_i732_c_${suffix}`;
// User ids are global, so each organization gets its own enrolling admin.
const adminOf = (organizationId: string) => `cold_chain_admin_${organizationId}`;
const ADMIN = adminOf(ORG_A);
const LEAVER = `cold_chain_leaver_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  sensors: typeof import('./cold-chain-sensors');
  ledger: typeof import('./stock-ledger');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

function scope(organizationId: string, branchId: string, actorId = adminOf(organizationId)) {
  return { organizationId, branchId, actorId };
}

async function zone(
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
          addressLine: '1 Sensor Road',
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

async function enroll(
  organizationId: string,
  branchId: string,
  stockLocationId: string,
  options: { actorId?: string; deviceIdentifier?: string } = {}
) {
  return inOrg(organizationId, (db) =>
    deps.sensors.enrollColdChainSensor(db, scope(organizationId, branchId, options.actorId), {
      stockLocationId,
      name: 'Fridge probe',
      deviceIdentifier: options.deviceIdentifier ?? `SN-${randomBytes(4).toString('hex')}`,
    })
  );
}

function readings(...points: Array<[string, number]>) {
  return {
    readings: points.map(([recordedAt, temperatureC]) => ({ recordedAt, temperatureC })),
  };
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, sensors, ledger, roleGuard, departments] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./cold-chain-sensors'),
    import('./stock-ledger'),
    import('@/lib/testing/rls-role-guard'),
    import('@/lib/test-support/departments'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    sensors,
    ledger,
  };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  // The push refuses a suspended tenant and an inactive enroller, so both
  // must exist as real rows.
  await scopedDb.withPlatformDb(async (db) => {
    for (const organizationId of [ORG_A, ORG_B, ORG_C]) {
      await db.organization.create({
        data: {
          id: organizationId,
          slug: organizationId.replaceAll('_', '-'),
          legalName: `Cold chain ${organizationId}`,
          displayName: `Cold chain ${organizationId}`,
          vertical: 'PHARMACY',
          status: 'ACTIVE',
        },
      });
    }
    await departments.seedDepartments(db, [ORG_A, ORG_B, ORG_C], ['LEADERSHIP']);
  });
  const member = (id: string, organizationId: string) => ({
    id,
    organizationId,
    name: id,
    email: `${id}@cold-chain.test`,
    role: 'ADMIN' as const,
    department: 'LEADERSHIP',
    title: 'Pharmacy administrator',
    status: 'ACTIVE' as const,
  });
  for (const organizationId of [ORG_A, ORG_B, ORG_C]) {
    await inOrg(organizationId, (db) =>
      db.user.create({ data: member(adminOf(organizationId), organizationId) })
    );
  }
  await inOrg(ORG_A, (db) => db.user.create({ data: member(LEAVER, ORG_A) }));
}, 120_000);

describeIfDatabase('#732 live cold-chain sensor push', () => {
  it('stores pushed readings as SENSOR evidence in the enrolled zone only', async () => {
    const fridge = await zone(ORG_A, BRANCH_A, 'COLD');
    const { sensor, secret } = await enroll(ORG_A, BRANCH_A, fridge);
    const now = new Date('2026-10-31T08:30:00.000Z');

    const result = await deps.sensors.receiveSensorPush(
      secret,
      readings(['2026-10-31T08:00:00.000Z', 5.1], ['2026-10-31T08:15:00.000Z', 9.2]),
      now
    );
    expect(result).toMatchObject({ ok: true, accepted: 2, duplicates: 0 });

    const stored = await inOrg(ORG_A, async (db) => ({
      logs: await db.pharmacyTemperatureLog.findMany({
        where: { stockLocationId: fridge },
        orderBy: { recordedAt: 'asc' },
      }),
      sensor: await db.pharmacyColdChainSensor.findUniqueOrThrow({ where: { id: sensor.id } }),
    }));
    expect(stored.logs).toMatchObject([
      {
        source: 'SENSOR',
        deviceIdentifier: sensor.deviceIdentifier,
        branchId: BRANCH_A,
        actorId: ADMIN,
        outOfRange: false,
      },
      { source: 'SENSOR', deviceIdentifier: sensor.deviceIdentifier, outOfRange: true },
    ]);
    expect(stored.sensor.lastSeenAt).toEqual(now);
    expect(stored.sensor.lastReadingAt).toEqual(new Date('2026-10-31T08:15:00.000Z'));
    expect(stored.sensor.secretHash).not.toContain(secret);
  });

  it('is idempotent when a sensor retries the same push', async () => {
    const fridge = await zone(ORG_A, BRANCH_A, 'COLD');
    const { secret } = await enroll(ORG_A, BRANCH_A, fridge);
    const now = new Date('2026-10-31T09:30:00.000Z');
    const body = readings(['2026-10-31T09:00:00.000Z', 4], ['2026-10-31T09:15:00.000Z', 4.5]);

    await deps.sensors.receiveSensorPush(secret, body, now);
    const retry = await deps.sensors.receiveSensorPush(secret, body, now);
    expect(retry).toMatchObject({ ok: true, accepted: 0, duplicates: 2 });
    await expect(
      inOrg(ORG_A, (db) => db.pharmacyTemperatureLog.count({ where: { stockLocationId: fridge } }))
    ).resolves.toBe(2);
  });

  it('refuses a revoked sensor and a rotated-out secret without writing', async () => {
    const fridge = await zone(ORG_A, BRANCH_A, 'COLD');
    const first = await enroll(ORG_A, BRANCH_A, fridge);
    const now = new Date('2026-10-31T10:30:00.000Z');
    const body = readings(['2026-10-31T10:00:00.000Z', 5]);

    const rotated = await inOrg(ORG_A, (db) =>
      deps.sensors.rotateColdChainSensorSecret(db, scope(ORG_A, BRANCH_A), first.sensor.id)
    );
    await expect(deps.sensors.receiveSensorPush(first.secret, body, now)).resolves.toEqual({
      ok: false,
      error: 'unauthorized',
    });

    await inOrg(ORG_A, (db) =>
      deps.sensors.revokeColdChainSensor(db, scope(ORG_A, BRANCH_A), first.sensor.id, now)
    );
    await expect(deps.sensors.receiveSensorPush(rotated.secret, body, now)).resolves.toEqual({
      ok: false,
      error: 'unauthorized',
    });
    await expect(
      inOrg(ORG_A, (db) => db.pharmacyTemperatureLog.count({ where: { stockLocationId: fridge } }))
    ).resolves.toBe(0);
  });

  it('refuses a push once the tenant is suspended, and writes nothing', async () => {
    const fridge = await zone(ORG_C, BRANCH_C, 'COLD');
    const { sensor, secret } = await enroll(ORG_C, BRANCH_C, fridge);
    const body = readings(['2026-10-31T10:00:00.000Z', 5]);
    const now = new Date('2026-10-31T10:30:00.000Z');
    // The lifecycle is control-plane state, changed by the platform.
    await deps.withPlatformDb((db) =>
      db.organization.update({ where: { id: ORG_C }, data: { status: 'SUSPENDED' } })
    );
    await expect(deps.sensors.receiveSensorPush(secret, body, now)).resolves.toEqual({
      ok: false,
      error: 'organization_suspended',
    });
    const stored = await inOrg(ORG_C, async (db) => ({
      logs: await db.pharmacyTemperatureLog.count({ where: { stockLocationId: fridge } }),
      sensor: await db.pharmacyColdChainSensor.findUniqueOrThrow({ where: { id: sensor.id } }),
    }));
    expect(stored.logs).toBe(0);
    expect(stored.sensor.lastSeenAt).toBeNull();
  });

  it('stops a sensor whose enroller is inactive until an admin rotates it', async () => {
    const fridge = await zone(ORG_A, BRANCH_A, 'COLD');
    const { sensor, secret } = await enroll(ORG_A, BRANCH_A, fridge, { actorId: LEAVER });
    await inOrg(ORG_A, (db) =>
      db.user.update({ where: { id: LEAVER }, data: { status: 'INACTIVE' } })
    );
    const now = new Date('2026-10-31T11:30:00.000Z');
    const body = readings(['2026-10-31T11:00:00.000Z', 5]);
    await expect(deps.sensors.receiveSensorPush(secret, body, now)).resolves.toEqual({
      ok: false,
      error: 'sensor_owner_inactive',
    });

    const rotated = await inOrg(ORG_A, (db) =>
      deps.sensors.rotateColdChainSensorSecret(db, scope(ORG_A, BRANCH_A), sensor.id)
    );
    expect(rotated.sensor.enrolledByActorId).toBe(ADMIN);
    await expect(deps.sensors.receiveSensorPush(rotated.secret, body, now)).resolves.toMatchObject(
      { ok: true, accepted: 1 }
    );
    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyTemperatureLog.findMany({
          where: { stockLocationId: fridge },
          select: { actorId: true },
        })
      )
    ).resolves.toEqual([{ actorId: ADMIN }]);
  });

  it('re-enrolls a revoked serial on its own row and refuses an active duplicate', async () => {
    const fridge = await zone(ORG_A, BRANCH_A, 'COLD');
    const deviceIdentifier = `SN-REUSE-${randomBytes(4).toString('hex')}`;
    const first = await enroll(ORG_A, BRANCH_A, fridge, { deviceIdentifier });
    await expect(enroll(ORG_A, BRANCH_A, fridge, { deviceIdentifier })).rejects.toMatchObject({
      reason: 'DUPLICATE_DEVICE_IDENTIFIER',
    });
    const now = new Date('2026-10-31T12:00:00.000Z');
    await inOrg(ORG_A, (db) =>
      deps.sensors.revokeColdChainSensor(db, scope(ORG_A, BRANCH_A), first.sensor.id, now)
    );

    const again = await enroll(ORG_A, BRANCH_A, fridge, { deviceIdentifier });
    expect(again.sensor).toMatchObject({
      id: first.sensor.id,
      deviceIdentifier,
      status: 'ACTIVE',
      revokedAt: null,
    });
    await expect(
      deps.sensors.receiveSensorPush(first.secret, readings(['2026-10-31T11:55:00.000Z', 5]), now)
    ).resolves.toEqual({ ok: false, error: 'unauthorized' });
    await expect(
      deps.sensors.receiveSensorPush(again.secret, readings(['2026-10-31T11:55:00.000Z', 5]), now)
    ).resolves.toMatchObject({ ok: true, accepted: 1 });
  });

  it('refuses a push while the tenant lacks pharmacy-inventory', async () => {
    const fridge = await zone(ORG_A, BRANCH_A, 'COLD');
    const { secret } = await enroll(ORG_A, BRANCH_A, fridge);
    entitlements.enabled = false;
    try {
      await expect(
        deps.sensors.receiveSensorPush(
          secret,
          readings(['2026-10-31T11:00:00.000Z', 5]),
          new Date('2026-10-31T11:05:00.000Z')
        )
      ).resolves.toEqual({ ok: false, error: 'module_disabled' });
    } finally {
      entitlements.enabled = true;
    }
  });

  it('refuses enrollment on an ambient zone or on a zone in another tenant', async () => {
    const shelf = await zone(ORG_A, BRANCH_A, 'AMBIENT');
    await expect(enroll(ORG_A, BRANCH_A, shelf)).rejects.toMatchObject({
      reason: 'LOCATION_NOT_COLD_CHAIN',
    });
    const otherFridge = await zone(ORG_B, BRANCH_B, 'COLD');
    await expect(enroll(ORG_A, BRANCH_A, otherFridge)).rejects.toMatchObject({
      reason: 'CROSS_BRANCH_REFERENCE',
    });
  });

  it("hides one tenant's sensors from another and refuses cross-tenant writes", async () => {
    const fridge = await zone(ORG_A, BRANCH_A, 'COLD');
    const { sensor } = await enroll(ORG_A, BRANCH_A, fridge);
    await zone(ORG_B, BRANCH_B, 'COLD');

    const visible = await inOrg(ORG_B, (db) =>
      db.pharmacyColdChainSensor.findMany({ where: { id: sensor.id } })
    );
    expect(visible).toEqual([]);

    const message = await inOrg(ORG_B, (db) =>
      db.pharmacyColdChainSensor
        .update({ where: { id: sensor.id }, data: { status: 'REVOKED', revokedAt: new Date() } })
        .then(() => 'ACCEPTED — expected rejection')
        .catch((error: Error) => error.message)
    );
    expect(message).not.toBe('ACCEPTED — expected rejection');
    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyColdChainSensor.findUniqueOrThrow({ where: { id: sensor.id } })
      )
    ).resolves.toMatchObject({ status: 'ACTIVE', revokedAt: null });
  });

  it('raises the existing COLD_CHAIN stock alert when a push starts an excursion', async () => {
    const fridge = await zone(ORG_A, BRANCH_A, 'COLD');
    const { secret } = await enroll(ORG_A, BRANCH_A, fridge);
    await inOrg(ORG_A, async (db) => {
      const medicine = await db.medicine.create({
        data: {
          organizationId: ORG_A,
          productName: `Sensor vaccine ${randomBytes(4).toString('hex')}`,
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
        stockLocationId: fridge,
        unitsPerPack: 10,
        supplierName: 'Cold Distributor',
        supplierInvoiceRef: `INV-${randomBytes(4).toString('hex')}`,
        unitCostMinor: 100,
        printedMrpMinor: 200,
        receivedExpiresAt: batch.expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 10,
        idempotencyKey: `receive-${randomBytes(4).toString('hex')}`,
        receivedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
    });

    // One warm reading is only pending; no alert yet.
    const pending = await deps.sensors.receiveSensorPush(
      secret,
      readings(['2026-10-31T12:00:00.000Z', 8.5]),
      new Date('2026-10-31T12:00:30.000Z')
    );
    expect(pending).toMatchObject({ ok: true, alertsRefreshed: false });

    // The run now spans the 30-minute excursion window.
    const excursion = await deps.sensors.receiveSensorPush(
      secret,
      readings(['2026-10-31T12:15:00.000Z', 8.8], ['2026-10-31T12:30:00.000Z', 9.1]),
      new Date('2026-10-31T12:30:30.000Z')
    );
    expect(excursion).toMatchObject({
      ok: true,
      zoneStatus: 'EXCURSION',
      alertsRefreshed: true,
    });
    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyStockSignal.findMany({
          where: { stockLocationId: fridge, kind: 'COLD_CHAIN', status: 'OPEN' },
          select: { kind: true },
        })
      )
    ).resolves.toEqual([{ kind: 'COLD_CHAIN' }]);

    // Recovery closes it again.
    const recovered = await deps.sensors.receiveSensorPush(
      secret,
      readings(['2026-10-31T12:45:00.000Z', 5]),
      new Date('2026-10-31T12:45:30.000Z')
    );
    expect(recovered).toMatchObject({ ok: true, zoneStatus: 'IN_RANGE', alertsRefreshed: true });
    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyStockSignal.count({
          where: { stockLocationId: fridge, kind: 'COLD_CHAIN', status: 'OPEN' },
        })
      )
    ).resolves.toBe(0);
  });
});
