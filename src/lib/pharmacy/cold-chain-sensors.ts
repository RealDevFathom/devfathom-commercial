import 'server-only';

import { z } from 'zod';

import { Prisma, type PharmacyColdChainSensor } from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import {
  generateDeviceSecret,
  hashDeviceSecret,
  isDeviceUsable,
} from '@/lib/retail-terminal/device-secret';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import { PharmacyInventoryError } from './inventory';
import type { LedgerScope } from './stock-ledger';
import { refreshStockSignals } from './stock-signals-operations';
import {
  ingestTemperatureReadings,
  loadTemperatureZoneStatuses,
  type TemperatureReading,
  type TemperatureReadingSource,
  type TemperatureZoneStatus,
} from './temperature-log';

/**
 * #732 — live cold-chain sensor push.
 *
 * A sensor is enrolled against exactly one validated cold-chain zone and is
 * handed a push secret ONCE (only its SHA-256 hash is stored). The webhook
 * resolves the sensor by that hash, then does all work inside the sensor's own
 * tenant transaction: readings go through the existing INV-05 seam (same range
 * flag trigger, same append-only table, same CAM-3 evidence request) with
 * source `SENSOR`, and when a push moves the zone into EXCURSION (or back in
 * range while an alert is live) the existing PUR-07 evaluator is re-run, so
 * the COLD_CHAIN stock alert is raised or closed immediately rather than at
 * the next manual refresh.
 */

export const COLD_CHAIN_SENSOR_SECRET_PREFIX = 'pcs_';
/** `pcs_` + 32 random bytes in base64url (43 characters). */
const SENSOR_SECRET_PATTERN = /^pcs_[A-Za-z0-9_-]{43}$/;

/** Bounds on one push. A sensor that buffered through an outage may replay up
 * to a week of readings; nothing may claim to be from the future. */
export const MAX_SENSOR_READINGS_PER_PUSH = 500;
export const MAX_SENSOR_BACKFILL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SENSOR_CLOCK_SKEW_MS = 2 * 60 * 1000;
/** Mirrors the PUR-07 live statuses: the ones a refresh may close. */
const LIVE_SIGNAL_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'SNOOZED', 'STALE'] as const;

export class PharmacyColdChainSensorError extends Error {
  constructor(
    readonly reason:
      | 'NOT_FOUND'
      | 'INVALID_NAME'
      | 'INVALID_DEVICE_IDENTIFIER'
      | 'DUPLICATE_DEVICE_IDENTIFIER'
      | 'LOCATION_NOT_COLD_CHAIN'
      | 'REVOKED'
  ) {
    super(reason);
    this.name = 'PharmacyColdChainSensorError';
  }
}

export function isColdChainSensorSecret(token: string): boolean {
  return SENSOR_SECRET_PATTERN.test(token);
}

/** What a tenant may see about a sensor — never the secret hash. */
export type ColdChainSensorView = Pick<
  PharmacyColdChainSensor,
  | 'id'
  | 'branchId'
  | 'stockLocationId'
  | 'name'
  | 'deviceIdentifier'
  | 'status'
  | 'revokedAt'
  | 'lastSeenAt'
  | 'lastReadingAt'
  | 'enrolledByActorId'
  | 'createdAt'
>;

const SENSOR_VIEW = {
  id: true,
  branchId: true,
  stockLocationId: true,
  name: true,
  deviceIdentifier: true,
  status: true,
  revokedAt: true,
  lastSeenAt: true,
  lastReadingAt: true,
  enrolledByActorId: true,
  createdAt: true,
} as const satisfies Prisma.PharmacyColdChainSensorSelect;

function cleanLabel(value: string, reason: 'INVALID_NAME' | 'INVALID_DEVICE_IDENTIFIER'): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120) throw new PharmacyColdChainSensorError(reason);
  return trimmed;
}

/**
 * Enroll a sensor on one validated cold-chain zone of the scoped branch. The
 * zone lookup is tenant- and branch-filtered and the composite foreign key
 * refuses anything else, so a sensor can never write into another branch.
 */
export async function enrollColdChainSensor(
  db: ScopedDb,
  scope: LedgerScope,
  input: { stockLocationId: string; name: string; deviceIdentifier: string }
): Promise<{ sensor: ColdChainSensorView; secret: string }> {
  const name = cleanLabel(input.name, 'INVALID_NAME');
  const deviceIdentifier = cleanLabel(input.deviceIdentifier, 'INVALID_DEVICE_IDENTIFIER');
  const location = await db.pharmacyStockLocation.findFirst({
    where: {
      id: input.stockLocationId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
    },
    select: { coldChain: true, minimumTemperatureC: true, maximumTemperatureC: true },
  });
  if (!location) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (
    !location.coldChain ||
    location.minimumTemperatureC === null ||
    location.maximumTemperatureC === null
  ) {
    throw new PharmacyColdChainSensorError('LOCATION_NOT_COLD_CHAIN');
  }
  const duplicate = await db.pharmacyColdChainSensor.findFirst({
    where: { organizationId: scope.organizationId, deviceIdentifier },
    select: { id: true },
  });
  if (duplicate) throw new PharmacyColdChainSensorError('DUPLICATE_DEVICE_IDENTIFIER');

  const { secret, secretHash } = generateDeviceSecret(COLD_CHAIN_SENSOR_SECRET_PREFIX);
  const sensor = await db.pharmacyColdChainSensor.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      stockLocationId: input.stockLocationId,
      name,
      deviceIdentifier,
      secretHash,
      enrolledByActorId: scope.actorId,
    },
    select: SENSOR_VIEW,
  });
  return { sensor, secret };
}

type SensorTrustRow = { id: string; status: 'ACTIVE' | 'REVOKED'; revokedAt: Date | null };

async function lockSensorInScope(db: ScopedDb, scope: LedgerScope, sensorId: string) {
  const rows = await db.$queryRaw<SensorTrustRow[]>(Prisma.sql`
    SELECT id, status, "revokedAt"
    FROM pharmacy_cold_chain_sensors
    WHERE id = ${sensorId}
      AND "organizationId" = ${scope.organizationId}
      AND "branchId" = ${scope.branchId}
    FOR UPDATE`);
  const row = rows[0];
  if (!row) throw new PharmacyColdChainSensorError('NOT_FOUND');
  return row;
}

/** Replace a sensor's push secret; the previous one stops working at once. */
export async function rotateColdChainSensorSecret(
  db: ScopedDb,
  scope: LedgerScope,
  sensorId: string
): Promise<{ sensor: ColdChainSensorView; secret: string }> {
  return db.$transaction(async (transaction) => {
    const tx = transaction as ScopedDb;
    const current = await lockSensorInScope(tx, scope, sensorId);
    if (!isDeviceUsable(current)) throw new PharmacyColdChainSensorError('REVOKED');
    const { secret, secretHash } = generateDeviceSecret(COLD_CHAIN_SENSOR_SECRET_PREFIX);
    const sensor = await tx.pharmacyColdChainSensor.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: sensorId } },
      data: { secretHash },
      select: SENSOR_VIEW,
    });
    return { sensor, secret };
  });
}

/** Revoke with a SERVER `now`. The row and every reading it pushed are kept. */
export async function revokeColdChainSensor(
  db: ScopedDb,
  scope: LedgerScope,
  sensorId: string,
  now: Date
): Promise<ColdChainSensorView> {
  return db.$transaction(async (transaction) => {
    const tx = transaction as ScopedDb;
    const current = await lockSensorInScope(tx, scope, sensorId);
    if (!isDeviceUsable(current)) {
      return tx.pharmacyColdChainSensor.findUniqueOrThrow({
        where: { organizationId_id: { organizationId: scope.organizationId, id: sensorId } },
        select: SENSOR_VIEW,
      });
    }
    return tx.pharmacyColdChainSensor.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: sensorId } },
      data: { status: 'REVOKED', revokedAt: now },
      select: SENSOR_VIEW,
    });
  });
}

export async function listColdChainSensors(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
): Promise<ColdChainSensorView[]> {
  return db.pharmacyColdChainSensor.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: SENSOR_VIEW,
  });
}

// ── Webhook push ────────────────────────────────────────────────────────────

export const sensorPushSchema = z
  .object({
    readings: z
      .array(
        z
          .object({
            recordedAt: z.iso.datetime({ offset: true }),
            temperatureC: z.number().finite().min(-100).max(100),
          })
          .strict()
      )
      .min(1)
      .max(MAX_SENSOR_READINGS_PER_PUSH),
  })
  .strict();

export type SensorPushReading = Readonly<{ recordedAt: Date; temperatureC: number }>;

/**
 * Parse and bound one push against a SERVER `now`. The whole batch is refused
 * if any reading is malformed, from the future, or older than the backfill
 * window, so an accepted prefix is never left behind. Duplicate timestamps in
 * one push collapse to the first occurrence.
 */
export function parseSensorPush(body: unknown, now: Date): SensorPushReading[] | null {
  const parsed = sensorPushSchema.safeParse(body);
  if (!parsed.success) return null;
  const seen = new Set<number>();
  const readings: SensorPushReading[] = [];
  for (const reading of parsed.data.readings) {
    const recordedAt = new Date(reading.recordedAt);
    const time = recordedAt.getTime();
    if (
      Number.isNaN(time) ||
      time > now.getTime() + MAX_SENSOR_CLOCK_SKEW_MS ||
      time < now.getTime() - MAX_SENSOR_BACKFILL_MS
    ) {
      return null;
    }
    if (seen.has(time)) continue;
    seen.add(time);
    readings.push({ recordedAt, temperatureC: reading.temperatureC });
  }
  return readings;
}

/** INV-05 source for an authenticated push; every reading carries the serial. */
export class SensorTemperatureReadingSource implements TemperatureReadingSource {
  readonly kind = 'SENSOR' as const;
  constructor(
    private readonly deviceIdentifier: string,
    private readonly readings: readonly SensorPushReading[]
  ) {}
  async read(): Promise<readonly TemperatureReading[]> {
    return this.readings.map((reading) => ({
      ...reading,
      deviceIdentifier: this.deviceIdentifier,
    }));
  }
}

export type SensorPushOutcome =
  | {
      ok: true;
      accepted: number;
      duplicates: number;
      zoneStatus: TemperatureZoneStatus;
      alertsRefreshed: boolean;
    }
  | {
      ok: false;
      error: 'unauthorized' | 'invalid_body' | 'module_disabled' | 'zone_unavailable';
    };

type LockedSensor = {
  id: string;
  organizationId: string;
  branchId: string;
  stockLocationId: string;
  deviceIdentifier: string;
  status: 'ACTIVE' | 'REVOKED';
  revokedAt: Date | null;
  lastReadingAt: Date | null;
  enrolledByActorId: string;
};

/**
 * Accept one authenticated push. `secret` is the raw bearer value; it is only
 * ever hashed. Unknown, malformed and revoked secrets are indistinguishable to
 * the caller. Re-sent readings (same sensor, same `recordedAt`) are skipped,
 * so a device may safely retry a push whose response it never saw.
 */
export async function receiveSensorPush(
  secret: string,
  body: unknown,
  now: Date
): Promise<SensorPushOutcome> {
  if (!isColdChainSensorSecret(secret)) return { ok: false, error: 'unauthorized' };
  const secretHash = hashDeviceSecret(secret);

  // The only pre-tenant read: which organization owns this hash.
  const discovery = await withPlatformDb((db) =>
    db.pharmacyColdChainSensor.findUnique({
      where: { secretHash },
      select: { organizationId: true },
    })
  );
  if (!discovery) return { ok: false, error: 'unauthorized' };

  const readings = parseSensorPush(body, now);

  return withTenantDb(discovery.organizationId, async (db): Promise<SensorPushOutcome> => {
    // Lock the row: a concurrent rotation or revocation either commits first
    // (and this push is refused) or waits for this push to finish.
    const rows = await db.$queryRaw<LockedSensor[]>(Prisma.sql`
      SELECT id, "organizationId", "branchId", "stockLocationId", "deviceIdentifier",
             status, "revokedAt", "lastReadingAt", "enrolledByActorId"
      FROM pharmacy_cold_chain_sensors
      WHERE "secretHash" = ${secretHash}
        AND "organizationId" = ${discovery.organizationId}
      FOR UPDATE`);
    const sensor = rows[0];
    if (!sensor || !isDeviceUsable(sensor)) return { ok: false, error: 'unauthorized' };
    if (!readings) return { ok: false, error: 'invalid_body' };
    if (
      !hasModule(
        await resolveOrganizationEntitlements(sensor.organizationId, db, now),
        'pharmacy-inventory'
      )
    ) {
      return { ok: false, error: 'module_disabled' };
    }
    const branch = await db.pharmacyBranch.findFirst({
      where: { id: sensor.branchId, organizationId: sensor.organizationId, active: true },
      select: { id: true },
    });
    if (!branch) return { ok: false, error: 'zone_unavailable' };

    const scope: LedgerScope = {
      organizationId: sensor.organizationId,
      branchId: sensor.branchId,
      // Readings and alert events are attributed to the person who enrolled
      // the sensor; the sensor serial on every reading names the device.
      actorId: sensor.enrolledByActorId,
    };

    const existing = await db.pharmacyTemperatureLog.findMany({
      where: {
        organizationId: sensor.organizationId,
        branchId: sensor.branchId,
        stockLocationId: sensor.stockLocationId,
        source: 'SENSOR',
        deviceIdentifier: sensor.deviceIdentifier,
        recordedAt: { in: readings.map((reading) => reading.recordedAt) },
      },
      select: { recordedAt: true },
    });
    const known = new Set(existing.map((row) => row.recordedAt.getTime()));
    const fresh = readings.filter((reading) => !known.has(reading.recordedAt.getTime()));

    const statusOf = async () =>
      (await loadTemperatureZoneStatuses(db, scope, now, [sensor.stockLocationId]))[0]?.status ??
      null;
    const before = await statusOf();
    if (before === null) return { ok: false, error: 'zone_unavailable' };

    if (fresh.length > 0) {
      try {
        await ingestTemperatureReadings(
          db,
          scope,
          sensor.stockLocationId,
          new SensorTemperatureReadingSource(sensor.deviceIdentifier, fresh)
        );
      } catch (error) {
        if (error instanceof PharmacyInventoryError) {
          return { ok: false, error: 'zone_unavailable' };
        }
        throw error;
      }
    }

    const newest = fresh.reduce<Date | null>(
      (latest, reading) =>
        latest === null || reading.recordedAt > latest ? reading.recordedAt : latest,
      sensor.lastReadingAt
    );
    await db.pharmacyColdChainSensor.update({
      where: { organizationId_id: { organizationId: sensor.organizationId, id: sensor.id } },
      data: { lastSeenAt: now, lastReadingAt: newest },
    });

    const after = (await statusOf()) ?? before;
    // PUR-07 COLD_CHAIN on a validated zone depends only on whether that zone
    // is in EXCURSION, so the branch is re-evaluated only when it matters:
    //  - entering EXCURSION raises the alert immediately;
    //  - a live alert is closed only on positive evidence (IN_RANGE), never
    //    because the sensor went quiet or a single reading broke the run.
    // A zone that stays in EXCURSION is not re-evaluated on every push, so a
    // dismissed alert is not re-raised by each reading.
    const entering = after === 'EXCURSION' && before !== 'EXCURSION';
    const recovered =
      after === 'IN_RANGE' &&
      (await db.pharmacyStockSignal.count({
        where: {
          organizationId: sensor.organizationId,
          branchId: sensor.branchId,
          stockLocationId: sensor.stockLocationId,
          kind: 'COLD_CHAIN',
          status: { in: [...LIVE_SIGNAL_STATUSES] },
        },
      })) > 0;
    const alertsRefreshed = entering || recovered;
    if (alertsRefreshed) await refreshStockSignals(db, scope, now);

    return {
      ok: true,
      accepted: fresh.length,
      duplicates: readings.length - fresh.length,
      zoneStatus: after,
      alertsRefreshed,
    };
  });
}
