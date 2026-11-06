import { saleUnitOptions, type PackLevelNode } from './counter-pricing';

/** Describe recorded custody first; a loose-unit equivalent is not a sealed count. */
export function inventoryBalanceDisplay(input: {
  onHandUnits: number;
  sealedPacks: number;
  looseUnits: number;
  unitsPerPack: number;
  packLevelId: string;
  packLevels: readonly PackLevelNode[];
}): string {
  const fallback = `${input.onHandUnits} units · ${input.sealedPacks} sealed + ${input.looseUnits} loose`;
  if (
    ![input.onHandUnits, input.sealedPacks, input.looseUnits].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) ||
    input.onHandUnits !== input.sealedPacks * input.unitsPerPack + input.looseUnits
  )
    return fallback;

  try {
    const options = saleUnitOptions({
      packLevels: input.packLevels,
      rootPackLevelId: input.packLevelId,
      unitsPerPack: input.unitsPerPack,
    });
    const root = options[0];
    if (!root || !['BOX', 'STRIP'].includes(root.levelLabel.toUpperCase())) return fallback;
    const name = root.levelLabel.toLowerCase();
    const sealed = `${input.sealedPacks} sealed ${name}${input.sealedPacks === 1 ? '' : name === 'box' ? 'es' : 's'}`;
    const strip = options.find((option) => option.levelLabel.toUpperCase() === 'STRIP');
    const loose = `${input.looseUnits} loose units`;
    if (!strip || strip === root || strip.canonicalUnitsPerSaleUnit <= 1) {
      return `${sealed} + ${loose} (${input.onHandUnits} units)`;
    }
    const strips = Math.floor(input.looseUnits / strip.canonicalUnitsPerSaleUnit);
    const units = input.looseUnits % strip.canonicalUnitsPerSaleUnit;
    return `${sealed} + ${loose} (${strips} strip equivalents + ${units} units; ${input.onHandUnits} units total)`;
  } catch {
    return fallback;
  }
}
