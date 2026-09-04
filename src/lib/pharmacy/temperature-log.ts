import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { PharmacyInventoryError } from './inventory';
import type { LedgerScope } from './stock-ledger';

export type TemperatureReading = Readonly<{ temperatureC: number; recordedAt: Date }>;

/** P1 sensor adapters implement this contract; P0 deliberately provides manual input only. */
export interface TemperatureSensorSource {
  readonly kind: string;
  read(): Promise<TemperatureReading>;
}

export class ManualTemperatureSensorSource implements TemperatureSensorSource {
  readonly kind = 'MANUAL';
  constructor(private readonly reading: TemperatureReading) {}
  async read(): Promise<TemperatureReading> {
    return this.reading;
  }
}

export async function appendTemperatureLog(
  db: ScopedDb,
  scope: LedgerScope,
  stockLocationId: string,
  source: TemperatureSensorSource
) {
  const location = await db.pharmacyStockLocation.findFirst({
    where: {
      id: stockLocationId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
    },
  });
  if (!location) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (
    !location.coldChain ||
    location.minimumTemperatureC === null ||
    location.maximumTemperatureC === null
  ) {
    throw new PharmacyInventoryError('COLD_CHAIN_STORAGE_REQUIRED');
  }
  const reading = await source.read();
  if (!Number.isFinite(reading.temperatureC) || Number.isNaN(reading.recordedAt.getTime())) {
    throw new PharmacyInventoryError('INVALID_STATE');
  }
  return db.pharmacyTemperatureLog.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      stockLocationId,
      actorId: scope.actorId,
      temperatureC: reading.temperatureC,
      recordedAt: reading.recordedAt,
      outOfRange:
        reading.temperatureC < location.minimumTemperatureC ||
        reading.temperatureC > location.maximumTemperatureC,
      source: source.kind,
    },
  });
}
