/**
 * #732 — live cold-chain sensor push: parsing, authentication order and the
 * alert hand-off. Persistence, RLS and the real PUR-07 evaluator are proved in
 * `cold-chain-sensors.db.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformFindUnique: vi.fn(),
  tenantDb: {
    $queryRaw: vi.fn(),
    pharmacyBranch: { findFirst: vi.fn() },
    pharmacyTemperatureLog: { findMany: vi.fn() },
    pharmacyColdChainSensor: { update: vi.fn() },
    pharmacyStockSignal: { count: vi.fn() },
  },
  withTenantDb: vi.fn(),
  hasModule: vi.fn(),
  ingest: vi.fn(),
  statuses: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => unknown) =>
    run({ pharmacyColdChainSensor: { findUnique: mocks.platformFindUnique } })
  ),
  withTenantDb: mocks.withTenantDb,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('./temperature-log', () => ({
  ingestTemperatureReadings: mocks.ingest,
  loadTemperatureZoneStatuses: mocks.statuses,
}));
vi.mock('./stock-signals-operations', () => ({ refreshStockSignals: mocks.refresh }));

import { hashDeviceSecret } from '@/lib/retail-terminal/device-secret';

import {
  isColdChainSensorSecret,
  MAX_SENSOR_READINGS_PER_PUSH,
  parseSensorPush,
  receiveSensorPush,
  SensorTemperatureReadingSource,
} from './cold-chain-sensors';
import { PharmacyInventoryError } from './inventory';

const NOW = new Date('2026-10-31T10:00:00.000Z');
const SECRET = `pcs_${'a'.repeat(43)}`;

const SENSOR = {
  id: 'sensor_1',
  organizationId: 'org_a',
  branchId: 'branch_a',
  stockLocationId: 'fridge_1',
  deviceIdentifier: 'SN-001',
  status: 'ACTIVE',
  revokedAt: null,
  lastReadingAt: null,
  enrolledByActorId: 'user_admin',
};

function push(...minutesAgo: number[]) {
  return {
    readings: minutesAgo.map((minutes, index) => ({
      recordedAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
      temperatureC: 9 + index,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platformFindUnique.mockResolvedValue({ organizationId: 'org_a' });
  mocks.withTenantDb.mockImplementation(async (_org: string, run: (db: unknown) => unknown) =>
    run(mocks.tenantDb)
  );
  mocks.tenantDb.$queryRaw.mockResolvedValue([SENSOR]);
  mocks.tenantDb.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch_a' });
  mocks.tenantDb.pharmacyTemperatureLog.findMany.mockResolvedValue([]);
  mocks.tenantDb.pharmacyColdChainSensor.update.mockResolvedValue({});
  mocks.tenantDb.pharmacyStockSignal.count.mockResolvedValue(0);
  mocks.hasModule.mockReturnValue(true);
  mocks.ingest.mockResolvedValue({ count: 1 });
  mocks.statuses.mockResolvedValue([{ stockLocationId: 'fridge_1', status: 'IN_RANGE' }]);
  mocks.refresh.mockResolvedValue({ raised: 1, refreshed: 0, closed: 0, signals: [] });
});

describe('sensor secret shape', () => {
  it('accepts only the pcs_ prefix with a 32-byte base64url body', () => {
    expect(isColdChainSensorSecret(SECRET)).toBe(true);
    expect(isColdChainSensorSecret(`pcd_${'a'.repeat(43)}`)).toBe(false);
    expect(isColdChainSensorSecret(`pcs_${'a'.repeat(42)}`)).toBe(false);
    expect(isColdChainSensorSecret(`pcs_${'a'.repeat(42)}!`)).toBe(false);
    expect(isColdChainSensorSecret('')).toBe(false);
  });
});

describe('parseSensorPush', () => {
  it('parses a bounded batch and collapses repeated timestamps', () => {
    const body = push(10, 5);
    body.readings.push({ ...body.readings[0]! });
    const readings = parseSensorPush(body, NOW);
    expect(readings).toEqual([
      { recordedAt: new Date('2026-10-31T09:50:00.000Z'), temperatureC: 9 },
      { recordedAt: new Date('2026-10-31T09:55:00.000Z'), temperatureC: 10 },
    ]);
  });

  it('refuses the whole batch for a future, too-old or malformed reading', () => {
    expect(parseSensorPush(push(5, -10), NOW)).toBeNull();
    expect(parseSensorPush(push(5, 8 * 24 * 60), NOW)).toBeNull();
    expect(
      parseSensorPush({ readings: [{ recordedAt: 'yesterday', temperatureC: 5 }] }, NOW)
    ).toBeNull();
    expect(
      parseSensorPush({ readings: [{ recordedAt: NOW.toISOString(), temperatureC: 101 }] }, NOW)
    ).toBeNull();
  });

  it('refuses unknown fields, so a body can never pick its own zone or tenant', () => {
    expect(parseSensorPush({ ...push(1), stockLocationId: 'other_zone' }, NOW)).toBeNull();
    expect(
      parseSensorPush(
        { readings: [{ recordedAt: NOW.toISOString(), temperatureC: 5, organizationId: 'x' }] },
        NOW
      )
    ).toBeNull();
  });

  it('refuses an empty or oversized batch', () => {
    expect(parseSensorPush({ readings: [] }, NOW)).toBeNull();
    const oversized = {
      readings: Array.from({ length: MAX_SENSOR_READINGS_PER_PUSH + 1 }, (_, index) => ({
        recordedAt: new Date(NOW.getTime() - index * 1000).toISOString(),
        temperatureC: 5,
      })),
    };
    expect(parseSensorPush(oversized, NOW)).toBeNull();
  });
});

describe('SensorTemperatureReadingSource', () => {
  it('is a SENSOR source that stamps the enrolled serial on every reading', async () => {
    const source = new SensorTemperatureReadingSource('SN-001', [
      { recordedAt: NOW, temperatureC: 4 },
    ]);
    expect(source.kind).toBe('SENSOR');
    await expect(source.read()).resolves.toEqual([
      { recordedAt: NOW, temperatureC: 4, deviceIdentifier: 'SN-001' },
    ]);
  });
});

describe('receiveSensorPush', () => {
  it('rejects a malformed secret before any database lookup', async () => {
    await expect(receiveSensorPush('pcs_short', push(1), NOW)).resolves.toEqual({
      ok: false,
      error: 'unauthorized',
    });
    expect(mocks.platformFindUnique).not.toHaveBeenCalled();
  });

  it('looks the sensor up only by the hash of its secret', async () => {
    mocks.platformFindUnique.mockResolvedValue(null);
    await expect(receiveSensorPush(SECRET, push(1), NOW)).resolves.toEqual({
      ok: false,
      error: 'unauthorized',
    });
    expect(mocks.platformFindUnique).toHaveBeenCalledWith({
      where: { secretHash: hashDeviceSecret(SECRET) },
      select: { organizationId: true },
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('runs inside the tenant that owns the sensor', async () => {
    mocks.platformFindUnique.mockResolvedValue({ organizationId: 'org_b' });
    mocks.tenantDb.$queryRaw.mockResolvedValue([{ ...SENSOR, organizationId: 'org_b' }]);
    await receiveSensorPush(SECRET, push(1), NOW);
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org_b', expect.any(Function));
  });

  it('refuses a revoked sensor exactly like an unknown one and writes nothing', async () => {
    mocks.tenantDb.$queryRaw.mockResolvedValue([
      { ...SENSOR, status: 'REVOKED', revokedAt: new Date('2026-10-30T00:00:00.000Z') },
    ]);
    await expect(receiveSensorPush(SECRET, push(1), NOW)).resolves.toEqual({
      ok: false,
      error: 'unauthorized',
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.tenantDb.pharmacyColdChainSensor.update).not.toHaveBeenCalled();
  });

  it('authenticates before reporting a bad body', async () => {
    mocks.platformFindUnique.mockResolvedValue(null);
    await expect(receiveSensorPush(SECRET, { nope: true }, NOW)).resolves.toMatchObject({
      error: 'unauthorized',
    });
    mocks.platformFindUnique.mockResolvedValue({ organizationId: 'org_a' });
    await expect(receiveSensorPush(SECRET, { nope: true }, NOW)).resolves.toMatchObject({
      error: 'invalid_body',
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('refuses a push when the tenant no longer has pharmacy-inventory', async () => {
    mocks.hasModule.mockReturnValue(false);
    await expect(receiveSensorPush(SECRET, push(1), NOW)).resolves.toEqual({
      ok: false,
      error: 'module_disabled',
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('refuses a push into an inactive branch', async () => {
    mocks.tenantDb.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(receiveSensorPush(SECRET, push(1), NOW)).resolves.toEqual({
      ok: false,
      error: 'zone_unavailable',
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('maps a deactivated zone to zone_unavailable', async () => {
    mocks.ingest.mockRejectedValue(new PharmacyInventoryError('CROSS_BRANCH_REFERENCE'));
    await expect(receiveSensorPush(SECRET, push(1), NOW)).resolves.toEqual({
      ok: false,
      error: 'zone_unavailable',
    });
  });

  it('writes the readings into the enrolled zone with the sensor scope', async () => {
    const result = await receiveSensorPush(SECRET, push(10, 5), NOW);
    expect(result).toEqual({
      ok: true,
      accepted: 2,
      duplicates: 0,
      zoneStatus: 'IN_RANGE',
      alertsRefreshed: false,
    });
    const [, scope, stockLocationId, source] = mocks.ingest.mock.calls[0]!;
    expect(scope).toEqual({
      organizationId: 'org_a',
      branchId: 'branch_a',
      actorId: 'user_admin',
    });
    expect(stockLocationId).toBe('fridge_1');
    expect(source).toBeInstanceOf(SensorTemperatureReadingSource);
    expect(mocks.tenantDb.pharmacyColdChainSensor.update).toHaveBeenCalledWith({
      where: { organizationId_id: { organizationId: 'org_a', id: 'sensor_1' } },
      data: { lastSeenAt: NOW, lastReadingAt: new Date('2026-10-31T09:55:00.000Z') },
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('skips readings the sensor already delivered, so retries are idempotent', async () => {
    const body = push(10, 5);
    mocks.tenantDb.pharmacyTemperatureLog.findMany.mockResolvedValue([
      { recordedAt: new Date(body.readings[0]!.recordedAt) },
    ]);
    const result = await receiveSensorPush(SECRET, body, NOW);
    expect(result).toMatchObject({ ok: true, accepted: 1, duplicates: 1 });
    expect(mocks.tenantDb.pharmacyTemperatureLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: 'SENSOR',
          deviceIdentifier: 'SN-001',
          stockLocationId: 'fridge_1',
        }),
      })
    );

    mocks.ingest.mockClear();
    mocks.tenantDb.pharmacyTemperatureLog.findMany.mockResolvedValue(
      body.readings.map((reading) => ({ recordedAt: new Date(reading.recordedAt) }))
    );
    await expect(receiveSensorPush(SECRET, body, NOW)).resolves.toMatchObject({
      ok: true,
      accepted: 0,
      duplicates: 2,
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('raises stock alerts when the push moves the zone into EXCURSION', async () => {
    mocks.statuses
      .mockResolvedValueOnce([{ stockLocationId: 'fridge_1', status: 'OUT_OF_RANGE_PENDING' }])
      .mockResolvedValueOnce([{ stockLocationId: 'fridge_1', status: 'EXCURSION' }]);
    const result = await receiveSensorPush(SECRET, push(1), NOW);
    expect(result).toMatchObject({ ok: true, zoneStatus: 'EXCURSION', alertsRefreshed: true });
    expect(mocks.refresh).toHaveBeenCalledWith(
      mocks.tenantDb,
      { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_admin' },
      NOW
    );
  });

  it('closes a live COLD_CHAIN alert once the zone is back in range', async () => {
    // A quiet sensor leaves the zone UNMONITORED before the recovery push.
    mocks.statuses
      .mockResolvedValueOnce([{ stockLocationId: 'fridge_1', status: 'UNMONITORED' }])
      .mockResolvedValueOnce([{ stockLocationId: 'fridge_1', status: 'IN_RANGE' }]);
    mocks.tenantDb.pharmacyStockSignal.count.mockResolvedValue(1);
    await expect(receiveSensorPush(SECRET, push(1), NOW)).resolves.toMatchObject({
      alertsRefreshed: true,
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.tenantDb.pharmacyStockSignal.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        branchId: 'branch_a',
        stockLocationId: 'fridge_1',
        kind: 'COLD_CHAIN',
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'SNOOZED', 'STALE'] },
      },
    });
  });

  it('does not re-evaluate an in-range zone that has no live alert', async () => {
    await expect(receiveSensorPush(SECRET, push(1), NOW)).resolves.toMatchObject({
      alertsRefreshed: false,
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(['OUT_OF_RANGE_PENDING', 'UNMONITORED'] as const)(
    'never closes a live alert on %s, only on positive in-range evidence',
    async (status) => {
      mocks.statuses
        .mockResolvedValueOnce([{ stockLocationId: 'fridge_1', status: 'EXCURSION' }])
        .mockResolvedValueOnce([{ stockLocationId: 'fridge_1', status }]);
      mocks.tenantDb.pharmacyStockSignal.count.mockResolvedValue(1);
      await expect(receiveSensorPush(SECRET, push(1), NOW)).resolves.toMatchObject({
        alertsRefreshed: false,
      });
      expect(mocks.refresh).not.toHaveBeenCalled();
    }
  );

  it('leaves alerts alone while the zone stays in EXCURSION', async () => {
    mocks.statuses.mockResolvedValue([{ stockLocationId: 'fridge_1', status: 'EXCURSION' }]);
    await expect(receiveSensorPush(SECRET, push(1), NOW)).resolves.toMatchObject({
      alertsRefreshed: false,
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
