/**
 * Pure planning kernel for growth #746. All thresholds are supplied by the
 * tenant: research figures are not product defaults.
 */
export type TransferSuggestionPolicy = {
  shortageCoverDays: number;
  targetCoverDays: number;
  surplusReserveDays: number;
  minimumShelfLifeDays: number;
};

export type TransferSuggestionLot = {
  lotId: string;
  stockLocationId: string;
  availableUnits: number;
  expiresAt: Date;
};

export type TransferSuggestionPosition = {
  branchId: string;
  medicineId: string;
  destinationStockLocationId: string;
  forecastDailyUnits: number;
  lots: ReadonlyArray<TransferSuggestionLot>;
};

export type InterbranchTransferSuggestion = {
  medicineId: string;
  fromBranchId: string;
  toBranchId: string;
  sourceCoverDays: number | null;
  destinationCoverDays: number;
  quantityUnits: number;
  lines: Array<{
    sourceLotId: string;
    sourceStockLocationId: string;
    destinationStockLocationId: string;
    quantityUnits: number;
    expiresAt: Date;
  }>;
};

const DAY_MS = 86_400_000;

function assertPolicy(policy: TransferSuggestionPolicy) {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`INVALID_POLICY:${name}`);
  }
  if (policy.targetCoverDays < policy.shortageCoverDays)
    throw new Error('INVALID_POLICY:targetCoverDays');
}

function assertPlanningInput(positions: ReadonlyArray<TransferSuggestionPosition>, asOf: Date) {
  if (!(asOf instanceof Date) || !Number.isFinite(asOf.getTime()))
    throw new Error('INVALID_PLANNING_INPUT:asOf');
  for (const position of positions) {
    if (!Number.isFinite(position.forecastDailyUnits) || position.forecastDailyUnits < 0)
      throw new Error('INVALID_PLANNING_INPUT:forecastDailyUnits');
    for (const lot of position.lots) {
      if (!Number.isSafeInteger(lot.availableUnits) || lot.availableUnits < 0)
        throw new Error('INVALID_PLANNING_INPUT:availableUnits');
      if (!(lot.expiresAt instanceof Date) || !Number.isFinite(lot.expiresAt.getTime()))
        throw new Error('INVALID_PLANNING_INPUT:expiresAt');
    }
  }
}

/**
 * Matches a short branch with a surplus branch for the same catalogue item.
 * Lots are proposed FEFO, but only up to the quantity the destination is
 * forecast to consume before the configured shelf-life buffer.
 */
export function suggestInterbranchTransfers(
  positions: ReadonlyArray<TransferSuggestionPosition>,
  policy: TransferSuggestionPolicy,
  asOf: Date
): InterbranchTransferSuggestion[] {
  assertPolicy(policy);
  assertPlanningInput(positions, asOf);
  const suggestions: InterbranchTransferSuggestion[] = [];
  const remaining = new Map<string, number>();
  for (const position of positions)
    for (const lot of position.lots)
      remaining.set(`${position.branchId}:${lot.lotId}:${lot.stockLocationId}`, lot.availableUnits);

  const medicines = [...new Set(positions.map((position) => position.medicineId))].sort();
  for (const medicineId of medicines) {
    const matching = positions.filter((position) => position.medicineId === medicineId);
    const shorts = matching
      .filter((position) => position.forecastDailyUnits > 0)
      .filter(
        (position) =>
          position.lots.reduce((sum, lot) => sum + lot.availableUnits, 0) /
            position.forecastDailyUnits <
          policy.shortageCoverDays
      )
      .sort((a, b) => a.branchId.localeCompare(b.branchId));

    for (const destination of shorts) {
      const destinationUnits = destination.lots.reduce((sum, lot) => sum + lot.availableUnits, 0);
      let needed = Math.max(
        0,
        Math.ceil(policy.targetCoverDays * destination.forecastDailyUnits - destinationUnits)
      );
      const sources = matching
        .filter((candidate) => candidate.branchId !== destination.branchId)
        .filter((candidate) => {
          const units = candidate.lots.reduce(
            (sum, lot) =>
              sum +
              (remaining.get(`${candidate.branchId}:${lot.lotId}:${lot.stockLocationId}`) ?? 0),
            0
          );
          return units > candidate.forecastDailyUnits * policy.surplusReserveDays;
        })
        .sort((a, b) => a.branchId.localeCompare(b.branchId));

      // One transfer has one source branch. Skip an unusable source (for
      // example, one whose entire surplus is inside the expiry buffer) rather
      // than suppressing a valid suggestion from a later source.
      for (const source of sources) {
        if (needed === 0) break;
        const lines: InterbranchTransferSuggestion['lines'] = [];
        const sourceUnits = source.lots.reduce(
          (sum, lot) =>
            sum + (remaining.get(`${source.branchId}:${lot.lotId}:${lot.stockLocationId}`) ?? 0),
          0
        );
        let sourceSurplus = Math.max(
          0,
          Math.floor(sourceUnits - source.forecastDailyUnits * policy.surplusReserveDays)
        );

        for (const lot of [...source.lots].sort(
          (a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.lotId.localeCompare(b.lotId)
        )) {
          const key = `${source.branchId}:${lot.lotId}:${lot.stockLocationId}`;
          const available = remaining.get(key) ?? 0;
          const saleDays = Math.max(
            0,
            (lot.expiresAt.getTime() - asOf.getTime()) / DAY_MS - policy.minimumShelfLifeDays
          );
          const consumableBeforeExpiry = Math.floor(saleDays * destination.forecastDailyUnits);
          const quantity = Math.min(available, sourceSurplus, needed, consumableBeforeExpiry);
          if (quantity <= 0) continue;
          lines.push({
            sourceLotId: lot.lotId,
            sourceStockLocationId: lot.stockLocationId,
            destinationStockLocationId: destination.destinationStockLocationId,
            quantityUnits: quantity,
            expiresAt: lot.expiresAt,
          });
          remaining.set(key, available - quantity);
          sourceSurplus -= quantity;
          needed -= quantity;
          if (needed === 0 || sourceSurplus === 0) break;
        }
        const quantityUnits = lines.reduce((sum, line) => sum + line.quantityUnits, 0);
        if (quantityUnits === 0) continue;
        suggestions.push({
          medicineId,
          fromBranchId: source.branchId,
          toBranchId: destination.branchId,
          sourceCoverDays:
            source.forecastDailyUnits > 0 ? sourceUnits / source.forecastDailyUnits : null,
          destinationCoverDays: destinationUnits / destination.forecastDailyUnits,
          quantityUnits,
          lines,
        });
        break;
      }
    }
  }
  return suggestions;
}
