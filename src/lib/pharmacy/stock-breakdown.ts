/**
 * DEV-727: stock as the shelf counts it.
 *
 * A raw canonical total such as "570 units" makes the counter do the pack
 * arithmetic in their head. This renders the same quantity in the received
 * pack hierarchy, largest level first, with the canonical total kept in
 * brackets so nothing is hidden: "5 boxes + 7 strips (570 tabs)".
 *
 * Display only — it never changes a quantity, and a hierarchy that cannot be
 * resolved simply falls back to the canonical total.
 */

import { saleUnitOptions, type PackLevelNode } from '@/lib/pharmacy/counter-pricing';

export type StockBreakdownLevel = {
  /** The pack level label, for example `BOX` or `STRIP`. */
  levelLabel: string;
  /** Canonical base units in one of this level. */
  canonicalUnitsPerSaleUnit: number;
};

const LEVEL_NOUN: Record<string, readonly [string, string]> = {
  CARTON: ['carton', 'cartons'],
  BOX: ['box', 'boxes'],
  PACK: ['pack', 'packs'],
  STRIP: ['strip', 'strips'],
  BLISTER: ['blister', 'blisters'],
};

function count(quantity: number, [one, many]: readonly [string, string]): string {
  return `${quantity.toLocaleString('en-PK')} ${quantity === 1 ? one : many}`;
}

function levelNoun(label: string): readonly [string, string] {
  const key = label.trim().toUpperCase();
  const known = LEVEL_NOUN[key];
  if (known) return known;
  const word = label.trim().toLowerCase() || 'pack';
  return [word, /(?:x|s|ch|sh)$/.test(word) ? `${word}es` : `${word}s`];
}

/** The base-unit noun the shelf uses for this dosage form. */
export function baseUnitNoun(dosageForm: string | null | undefined): readonly [string, string] {
  const form = (dosageForm ?? '').toLowerCase();
  if (/\btab(?:let)?s?\b|\bcaplets?\b/.test(form)) return ['tab', 'tabs'];
  if (/\bcap(?:sule)?s?\b/.test(form)) return ['cap', 'caps'];
  return ['unit', 'units'];
}

export function formatStockBreakdown(
  onHandUnits: number,
  levels: readonly StockBreakdownLevel[],
  dosageForm?: string | null
): string {
  const base = baseUnitNoun(dosageForm);
  const total = count(onHandUnits, base);
  if (!Number.isSafeInteger(onHandUnits) || onHandUnits <= 0) return total;

  const packs = [...levels]
    .filter(
      (level) =>
        Number.isSafeInteger(level.canonicalUnitsPerSaleUnit) && level.canonicalUnitsPerSaleUnit > 1
    )
    .sort((left, right) => right.canonicalUnitsPerSaleUnit - left.canonicalUnitsPerSaleUnit);
  if (packs.length === 0) return total;

  const parts: string[] = [];
  let remaining = onHandUnits;
  for (const level of packs) {
    const whole = Math.floor(remaining / level.canonicalUnitsPerSaleUnit);
    if (whole === 0) continue;
    parts.push(count(whole, levelNoun(level.levelLabel)));
    remaining -= whole * level.canonicalUnitsPerSaleUnit;
  }
  if (parts.length === 0) return total;
  if (remaining > 0) parts.push(count(remaining, base));
  return `${parts.join(' + ')} (${total})`;
}

/**
 * The breakdown for one received lot, resolved from its frozen pack hierarchy.
 * A hierarchy that disagrees with the lot falls back to the canonical total,
 * exactly as the counter refuses to quote a sale unit it cannot price.
 */
export function lotStockBreakdown(input: {
  onHandUnits: number;
  rootPackLevelId: string | null | undefined;
  unitsPerPack: number;
  packLevels: readonly PackLevelNode[] | null | undefined;
  dosageForm?: string | null;
}): string {
  let levels: StockBreakdownLevel[] = [];
  if (input.rootPackLevelId && input.packLevels?.length) {
    try {
      levels = saleUnitOptions({
        packLevels: input.packLevels,
        rootPackLevelId: input.rootPackLevelId,
        unitsPerPack: input.unitsPerPack,
      });
    } catch {
      levels = [];
    }
  }
  return formatStockBreakdown(input.onHandUnits, levels, input.dosageForm);
}

/**
 * DEV-638: the pack level a line was sold in. The stored level label wins for
 * a pack or strip (a standalone strip is sold as kind `PACK`), and a line with
 * no label falls back to a neutral word rather than inventing a box. A loose
 * `UNIT` sale shares the sealed pack's level id (see `lotSaleUnitOptions`), so
 * its stored label names the pack, not what was sold: it is always a unit.
 */
function soldUnitNouns(saleUnit: string, levelLabel?: string | null): readonly [string, string] {
  if (saleUnit === 'UNIT') return ['unit', 'units'];
  if (levelLabel?.trim()) return levelNoun(levelLabel);
  return levelNoun(saleUnit === 'STRIP' ? 'strip' : 'pack');
}

/** DEV-638: the singular noun for the pack level a line was sold in. */
export function soldUnitNoun(saleUnit: string, levelLabel?: string | null): string {
  return soldUnitNouns(saleUnit, levelLabel)[0];
}

/** DEV-501: the plural noun for the pack level a line was sold in, for quantity labels. */
export function soldUnitPluralNoun(saleUnit: string, levelLabel?: string | null): string {
  return soldUnitNouns(saleUnit, levelLabel)[1];
}

/** DEV-638: a sold line as it was sold, for example "1 strip of 10" or "3 units". */
export function formatSoldQuantity(input: {
  quantity: number;
  saleUnit: string;
  levelLabel?: string | null;
  canonicalUnitsPerSaleUnit: number;
}): string {
  const sold = count(input.quantity, soldUnitNouns(input.saleUnit, input.levelLabel));
  return input.canonicalUnitsPerSaleUnit > 1
    ? `${sold} of ${input.canonicalUnitsPerSaleUnit.toLocaleString('en-PK')}`
    : sold;
}
