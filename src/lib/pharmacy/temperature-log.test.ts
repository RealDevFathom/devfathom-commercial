import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { ManualTemperatureSensorSource, appendTemperatureLog } from './temperature-log';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };
const recordedAt = new Date('2026-09-04T08:30:00.000Z');

function database(temperatureRange: { minimumTemperatureC: number; maximumTemperatureC: number }) {
  const create = vi.fn(async ({ data }) => ({ id: 'log_1', ...data }));
  return {
    db: {
      pharmacyStockLocation: {
        findFirst: vi.fn(async () => ({ id: 'fridge_1', coldChain: true, ...temperatureRange })),
      },
      pharmacyTemperatureLog: { create },
    } as unknown as ScopedDb,
    create,
  };
}

describe('INV-05 manual temperature log', () => {
  it('appends the actor, reading, timestamp and an in-range decision', async () => {
    const { db, create } = database({ minimumTemperatureC: 2, maximumTemperatureC: 8 });
    const result = await appendTemperatureLog(
      db,
      scope,
      'fridge_1',
      new ManualTemperatureSensorSource({ temperatureC: 5.2, recordedAt })
    );

    expect(result).toMatchObject({ temperatureC: 5.2, recordedAt, outOfRange: false });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_a',
        branchId: 'branch_a',
        stockLocationId: 'fridge_1',
        actorId: 'user_a',
        source: 'MANUAL',
      }),
    });
  });

  it('marks a boundary breach out of range', async () => {
    const { db } = database({ minimumTemperatureC: 2, maximumTemperatureC: 8 });
    await expect(
      appendTemperatureLog(
        db,
        scope,
        'fridge_1',
        new ManualTemperatureSensorSource({ temperatureC: 8.1, recordedAt })
      )
    ).resolves.toMatchObject({ outOfRange: true });
  });
});
