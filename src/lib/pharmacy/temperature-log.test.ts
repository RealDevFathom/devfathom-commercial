import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  CsvTemperatureReadingSource,
  deriveTemperatureZoneStatus,
  ingestTemperatureReadings,
  ManualTemperatureReadingSource,
} from './temperature-log';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };
const recordedAt = new Date('2026-09-04T08:30:00.000Z');

function database(
  temperatureRange: {
    coldChain?: boolean;
    minimumTemperatureC: number | null;
    maximumTemperatureC: number | null;
  } = { minimumTemperatureC: 2, maximumTemperatureC: 8 }
) {
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db));
  const db = {
    pharmacyStockLocation: {
      findFirst: vi.fn(async () => ({
        id: 'fridge_1',
        coldChain: true,
        ...temperatureRange,
      })),
    },
    pharmacyTemperatureLog: { createMany },
    // CAM-3 excursion hook: no cold-chain camera watches this zone.
    camera: { findFirst: vi.fn(async () => null) },
  } as unknown as ScopedDb;
  return {
    db: { ...db, $transaction: transaction } as unknown as ScopedDb,
    createMany,
    transaction,
  };
}

describe('INV-05 temperature reading sources', () => {
  it('appends a staff reading with immutable source attribution', async () => {
    const { db, createMany } = database();
    const result = await ingestTemperatureReadings(
      db,
      scope,
      'fridge_1',
      new ManualTemperatureReadingSource({ temperatureC: 5.2, recordedAt })
    );

    expect(result).toEqual({ count: 1 });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          organizationId: 'org_a',
          branchId: 'branch_a',
          stockLocationId: 'fridge_1',
          actorId: 'user_a',
          temperatureC: 5.2,
          recordedAt,
          outOfRange: false,
          source: 'MANUAL',
          deviceIdentifier: null,
        }),
      ],
    });
  });

  it('imports every row together and retains the logger identifier where supplied', async () => {
    const { db, createMany } = database();
    await expect(
      ingestTemperatureReadings(
        db,
        scope,
        'fridge_1',
        new CsvTemperatureReadingSource(
          'recordedAt,temperatureC,deviceIdentifier,ignored\n' +
            '2026-09-04T08:00:00.000Z,5.1,LOGGER-7,x\n' +
            '2026-09-04T08:15:00.000Z,8.2,,y\n'
        )
      )
    ).resolves.toEqual({ count: 2 });
    expect(createMany).toHaveBeenCalledOnce();
    expect(createMany.mock.calls[0]![0]).toEqual({
      data: [
        expect.objectContaining({
          source: 'IMPORT',
          deviceIdentifier: 'LOGGER-7',
          outOfRange: false,
        }),
        expect.objectContaining({ source: 'IMPORT', deviceIdentifier: null, outOfRange: true }),
      ],
    });
  });

  it('keeps the device serial on a live SENSOR reading (DEV-82)', async () => {
    const { db, createMany } = database();
    await ingestTemperatureReadings(db, scope, 'fridge_1', {
      kind: 'SENSOR',
      read: async () => [{ temperatureC: 9.4, recordedAt, deviceIdentifier: ' SN-001 ' }],
    });
    expect(createMany.mock.calls[0]![0]).toEqual({
      data: [
        expect.objectContaining({
          source: 'SENSOR',
          deviceIdentifier: 'SN-001',
          outOfRange: true,
        }),
      ],
    });
  });

  it('parses the complete import before opening a transaction, so a bad later row writes nothing', async () => {
    const { db, createMany, transaction } = database();
    await expect(
      ingestTemperatureReadings(
        db,
        scope,
        'fridge_1',
        new CsvTemperatureReadingSource(
          'recordedAt,temperatureC\n' + '2026-09-04T08:00:00.000Z,5.1\n' + 'not-a-timestamp,7.2\n'
        )
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(transaction).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('accepts ambient-zone readings without classifying them out of range', async () => {
    const { db, createMany } = database({
      coldChain: false,
      minimumTemperatureC: null,
      maximumTemperatureC: null,
    });
    await ingestTemperatureReadings(
      db,
      scope,
      'ambient_1',
      new ManualTemperatureReadingSource({ temperatureC: 25, recordedAt })
    );
    expect(createMany.mock.calls[0]![0]).toEqual({
      data: [expect.objectContaining({ outOfRange: false })],
    });
  });
});

const coldZone = {
  coldChain: true,
  minimumTemperatureC: 2,
  maximumTemperatureC: 8,
  expectedTemperatureReadingIntervalMinutes: 15,
  temperatureExcursionDurationMinutes: 30,
};

describe('INV-05 temperature status and excursions', () => {
  const at = new Date('2026-09-04T09:00:00.000Z');

  it('does not turn one spurious reading into an excursion', () => {
    expect(
      deriveTemperatureZoneStatus(
        coldZone,
        [{ temperatureC: 8.1, recordedAt: new Date('2026-09-04T09:00:00.000Z') }],
        at
      )
    ).toBe('OUT_OF_RANGE_PENDING');
  });

  it('derives an excursion only after a contiguous out-of-range run spans the zone threshold', () => {
    expect(
      deriveTemperatureZoneStatus(
        coldZone,
        [
          { temperatureC: 8.1, recordedAt: new Date('2026-09-04T08:30:00.000Z') },
          { temperatureC: 8.2, recordedAt: new Date('2026-09-04T08:45:00.000Z') },
          { temperatureC: 8.3, recordedAt: new Date('2026-09-04T09:00:00.000Z') },
        ],
        at
      )
    ).toBe('EXCURSION');
  });

  it('breaks the excursion run at a monitoring gap', () => {
    expect(
      deriveTemperatureZoneStatus(
        coldZone,
        [
          { temperatureC: 8.1, recordedAt: new Date('2026-09-04T08:20:00.000Z') },
          { temperatureC: 8.3, recordedAt: new Date('2026-09-04T09:00:00.000Z') },
        ],
        at
      )
    ).toBe('OUT_OF_RANGE_PENDING');
  });

  it('surfaces stale evidence as unmonitored instead of in range', () => {
    expect(
      deriveTemperatureZoneStatus(
        coldZone,
        [{ temperatureC: 5, recordedAt: new Date('2026-09-04T08:44:59.999Z') }],
        at
      )
    ).toBe('UNMONITORED');
  });

  it('reports a recently read ambient zone as monitored without creating an excursion state', () => {
    expect(
      deriveTemperatureZoneStatus(
        { ...coldZone, coldChain: false, minimumTemperatureC: null, maximumTemperatureC: null },
        [{ temperatureC: 25, recordedAt: at }],
        at
      )
    ).toBe('MONITORED');
  });
});
