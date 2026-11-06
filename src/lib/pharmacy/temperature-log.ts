import { requestExcursionEvidence } from '@/lib/cameras/excursion-evidence';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { PharmacyInventoryError } from './inventory';
import type { LedgerScope } from './stock-ledger';

export type TemperatureReading = Readonly<{
  temperatureC: number;
  recordedAt: Date;
  deviceIdentifier?: string | null;
}>;

export type TemperatureReadingSourceKind = 'MANUAL' | 'IMPORT' | 'SENSOR';

/**
 * The ingestion boundary shared by staff entry, data-logger files and (#732)
 * enrolled live sensors. It stays pull-only: the sensor webhook authenticates
 * and parses the push first (`./cold-chain-sensors`), then hands this seam an
 * already-validated batch. Vendor SDKs and credentials never enter here.
 */
export interface TemperatureReadingSource {
  readonly kind: TemperatureReadingSourceKind;
  read(): Promise<readonly TemperatureReading[]>;
}

export class ManualTemperatureReadingSource implements TemperatureReadingSource {
  readonly kind = 'MANUAL' as const;
  constructor(private readonly reading: TemperatureReading) {}
  async read(): Promise<readonly TemperatureReading[]> {
    return [this.reading];
  }
}

function csvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value.trim().length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new PharmacyInventoryError('INVALID_STATE');
  row.push(field.replace(/\r$/, ''));
  if (row.some((value) => value.trim().length > 0)) rows.push(row);
  return rows;
}

/**
 * CSV contract: a header row with `recordedAt` and `temperatureC`, plus an
 * optional `deviceIdentifier`. Additional logger-export columns are ignored.
 * The whole file is parsed before persistence, so a malformed row cannot leave
 * an accepted prefix behind.
 */
export class CsvTemperatureReadingSource implements TemperatureReadingSource {
  readonly kind = 'IMPORT' as const;
  constructor(private readonly csv: string) {}

  async read(): Promise<readonly TemperatureReading[]> {
    const [header, ...rows] = csvRows(this.csv);
    if (!header) throw new PharmacyInventoryError('INVALID_STATE');
    const columns = new Map(
      header.map((name, index) => [name.trim().replace(/^\uFEFF/, ''), index])
    );
    const recordedAtColumn = columns.get('recordedAt');
    const temperatureColumn = columns.get('temperatureC');
    const deviceColumn = columns.get('deviceIdentifier');
    if (recordedAtColumn === undefined || temperatureColumn === undefined || rows.length === 0) {
      throw new PharmacyInventoryError('INVALID_STATE');
    }

    return rows.map((row) => {
      const recordedAtText = row[recordedAtColumn]?.trim() ?? '';
      const temperatureText = row[temperatureColumn]?.trim() ?? '';
      const recordedAt = new Date(recordedAtText);
      const temperatureC = Number(temperatureText);
      const deviceIdentifier =
        deviceColumn === undefined ? null : row[deviceColumn]?.trim() || null;
      const hasEveryRequiredColumn =
        recordedAtColumn < row.length && temperatureColumn < row.length;
      if (
        !hasEveryRequiredColumn ||
        recordedAtText.length === 0 ||
        temperatureText.length === 0 ||
        Number.isNaN(recordedAt.getTime()) ||
        !Number.isFinite(temperatureC) ||
        temperatureC < -100 ||
        temperatureC > 100
      ) {
        throw new PharmacyInventoryError('INVALID_STATE');
      }
      return { recordedAt, temperatureC, deviceIdentifier };
    });
  }
}

export type TemperatureZoneStatus =
  'IN_RANGE' | 'OUT_OF_RANGE_PENDING' | 'EXCURSION' | 'UNMONITORED' | 'MONITORED';

type TemperatureZoneConfiguration = Readonly<{
  coldChain: boolean;
  minimumTemperatureC: number | null;
  maximumTemperatureC: number | null;
  expectedTemperatureReadingIntervalMinutes: number;
  temperatureExcursionDurationMinutes: number;
}>;

const MINUTE_MS = 60_000;

/**
 * Derive a zone's current state. An excursion needs two or more contiguous
 * out-of-range readings spanning the configured duration; a gap longer than
 * the expected interval breaks that run. Stale or absent evidence is explicitly
 * UNMONITORED, never silently IN_RANGE.
 */
export function deriveTemperatureZoneStatus(
  configuration: TemperatureZoneConfiguration,
  readings: readonly Pick<TemperatureReading, 'recordedAt' | 'temperatureC'>[],
  at: Date
): TemperatureZoneStatus {
  const ordered = readings
    .filter((reading) => reading.recordedAt.getTime() <= at.getTime())
    .toSorted((left, right) => left.recordedAt.getTime() - right.recordedAt.getTime());
  const latest = ordered.at(-1);
  const expectedIntervalMs = configuration.expectedTemperatureReadingIntervalMinutes * MINUTE_MS;
  if (!latest || at.getTime() - latest.recordedAt.getTime() > expectedIntervalMs) {
    return 'UNMONITORED';
  }
  if (
    !configuration.coldChain ||
    configuration.minimumTemperatureC === null ||
    configuration.maximumTemperatureC === null
  ) {
    return 'MONITORED';
  }

  const outOfRange = (reading: Pick<TemperatureReading, 'temperatureC'>) =>
    reading.temperatureC < configuration.minimumTemperatureC! ||
    reading.temperatureC > configuration.maximumTemperatureC!;
  if (!outOfRange(latest)) return 'IN_RANGE';

  let runStart = ordered.length - 1;
  while (runStart > 0) {
    const current = ordered[runStart]!;
    const previous = ordered[runStart - 1]!;
    if (
      !outOfRange(previous) ||
      current.recordedAt.getTime() - previous.recordedAt.getTime() > expectedIntervalMs
    ) {
      break;
    }
    runStart -= 1;
  }

  const durationMs = latest.recordedAt.getTime() - ordered[runStart]!.recordedAt.getTime();
  return runStart < ordered.length - 1 &&
    durationMs >= configuration.temperatureExcursionDurationMinutes * MINUTE_MS
    ? 'EXCURSION'
    : 'OUT_OF_RANGE_PENDING';
}

function assertReading(reading: TemperatureReading): void {
  if (
    !Number.isFinite(reading.temperatureC) ||
    reading.temperatureC < -100 ||
    reading.temperatureC > 100 ||
    Number.isNaN(reading.recordedAt.getTime()) ||
    (reading.deviceIdentifier !== undefined &&
      reading.deviceIdentifier !== null &&
      reading.deviceIdentifier.trim().length === 0)
  ) {
    throw new PharmacyInventoryError('INVALID_STATE');
  }
}

export async function ingestTemperatureReadings(
  db: ScopedDb,
  scope: LedgerScope,
  stockLocationId: string,
  source: TemperatureReadingSource
): Promise<{ count: number }> {
  const readings = await source.read();
  if (readings.length === 0) throw new PharmacyInventoryError('INVALID_STATE');
  readings.forEach(assertReading);

  return db.$transaction(async (transaction) => {
    const tx = transaction as ScopedDb;
    const location = await tx.pharmacyStockLocation.findFirst({
      where: {
        id: stockLocationId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        active: true,
      },
    });
    if (!location) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');

    const result = await tx.pharmacyTemperatureLog.createMany({
      data: readings.map((reading) => ({
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        stockLocationId,
        actorId: scope.actorId,
        temperatureC: reading.temperatureC,
        recordedAt: reading.recordedAt,
        outOfRange:
          location.coldChain &&
          location.minimumTemperatureC !== null &&
          location.maximumTemperatureC !== null
            ? reading.temperatureC < location.minimumTemperatureC ||
              reading.temperatureC > location.maximumTemperatureC
            : false,
        source: source.kind,
        deviceIdentifier:
          source.kind === 'IMPORT' || source.kind === 'SENSOR'
            ? (reading.deviceIdentifier?.trim() ?? null)
            : null,
      })),
    });
    // CAM-3: an excursion in a zone a cold-chain camera watches requests a
    // still in this same transaction, so rolled-back readings request nothing.
    await requestExcursionEvidence(tx, scope, stockLocationId, new Date());
    return { count: result.count };
  });
}

export type TemperatureZoneStatusResult = TemperatureZoneConfiguration & {
  stockLocationId: string;
  status: TemperatureZoneStatus;
  latestRecordedAt: Date | null;
};

/** Load branch/tenant-scoped evidence and derive current zone states. */
export async function loadTemperatureZoneStatuses(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  at: Date,
  stockLocationIds?: readonly string[]
): Promise<TemperatureZoneStatusResult[]> {
  if (stockLocationIds?.length === 0) return [];
  const locations = await db.pharmacyStockLocation.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
      ...(stockLocationIds ? { id: { in: [...stockLocationIds] } } : {}),
    },
    select: {
      id: true,
      coldChain: true,
      minimumTemperatureC: true,
      maximumTemperatureC: true,
      expectedTemperatureReadingIntervalMinutes: true,
      temperatureExcursionDurationMinutes: true,
    },
  });
  if (locations.length === 0) return [];

  const lookbackMinutes = Math.max(
    ...locations.map(
      (location) =>
        location.expectedTemperatureReadingIntervalMinutes +
        location.temperatureExcursionDurationMinutes
    )
  );
  const readings = await db.pharmacyTemperatureLog.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      stockLocationId: { in: locations.map((location) => location.id) },
      recordedAt: {
        gte: new Date(at.getTime() - lookbackMinutes * MINUTE_MS),
        lte: at,
      },
    },
    orderBy: [{ stockLocationId: 'asc' }, { recordedAt: 'asc' }],
    select: { stockLocationId: true, recordedAt: true, temperatureC: true },
  });
  const readingsByLocation = new Map<string, TemperatureReading[]>();
  for (const reading of readings) {
    const locationReadings = readingsByLocation.get(reading.stockLocationId) ?? [];
    locationReadings.push(reading);
    readingsByLocation.set(reading.stockLocationId, locationReadings);
  }

  return locations.map((location) => {
    const locationReadings = readingsByLocation.get(location.id) ?? [];
    const configuration = {
      coldChain: location.coldChain,
      minimumTemperatureC: location.minimumTemperatureC,
      maximumTemperatureC: location.maximumTemperatureC,
      expectedTemperatureReadingIntervalMinutes: location.expectedTemperatureReadingIntervalMinutes,
      temperatureExcursionDurationMinutes: location.temperatureExcursionDurationMinutes,
    };
    return {
      stockLocationId: location.id,
      ...configuration,
      status: deriveTemperatureZoneStatus(configuration, locationReadings, at),
      latestRecordedAt: locationReadings.at(-1)?.recordedAt ?? null,
    };
  });
}
