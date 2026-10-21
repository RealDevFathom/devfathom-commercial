/**
 * PUR-02 — the pack → canonical-unit conversion, derived rather than typed.
 *
 * Every purchasing and receiving write in `@/server/routers/pharmacy-purchasing`
 * takes `canonicalUnitsPerPack` as an input. That number is not the operator's
 * to know: it is already in the `PackLevel` hierarchy the pharmacy configured,
 * and asking a goods-in bench to retype it is both UX rule 1 and a route to
 * unsaleable stock — §8A invariant 2 makes the lot's pack conversion part of
 * what the batch is, so a mistyped multiplier is a costing error that survives
 * into the ledger.
 *
 * `unitsPerParent` counts this level inside its parent. A pack's canonical
 * conversion multiplies only descendants, ending at an explicit UNIT leaf.
 */

export type PackLevelNode = {
  id: string;
  level: string;
  unitsPerParent: number;
  parentPackLevelId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

export type PackConversionStep = {
  packLevelId: string;
  level: string;
  unitsPerParent: number;
};

export type PackConversion = {
  packLevelId: string;
  level: string;
  canonicalUnitsPerPack: number;
  /** Outermost to innermost, so a caller can print "1 CARTON = 5 BOX = 50 units". */
  chain: readonly PackConversionStep[];
};

/** A pack level is usable only while its version is the effective one. */
export function isEffective(level: PackLevelNode, at: Date): boolean {
  return (
    level.effectiveFrom.getTime() <= at.getTime() &&
    (level.effectiveTo === null || level.effectiveTo.getTime() > at.getTime())
  );
}

/**
 * A level can be superseded by a revision that has not started yet, so both
 * versions exist in the table at once; only the effective ones form the chain.
 *
 * Missing UNIT leaves, ambiguous branches, cycles and invalid descendant
 * multipliers yield no conversion rather than inventing receivable stock.
 */
export function packConversions(
  levels: readonly PackLevelNode[],
  at: Date = new Date()
): PackConversion[] {
  const effective = levels.filter((level) => isEffective(level, at));
  const children = new Map<string, PackLevelNode[]>();
  for (const level of effective) {
    if (!level.parentPackLevelId) continue;
    const siblings = children.get(level.parentPackLevelId) ?? [];
    siblings.push(level);
    children.set(level.parentPackLevelId, siblings);
  }
  return effective.flatMap((level): PackConversion[] => {
    const chain: PackConversionStep[] = [];
    const seen = new Set<string>();
    let canonicalUnitsPerPack = 1;
    let cursor = level;
    for (;;) {
      if (seen.has(cursor.id)) return [];
      seen.add(cursor.id);
      chain.push({
        packLevelId: cursor.id,
        level: cursor.level,
        unitsPerParent: cursor.unitsPerParent,
      });
      const descendants = children.get(cursor.id) ?? [];
      if (descendants.length === 0) {
        if (cursor.level !== 'UNIT') return [];
        break;
      }
      if (cursor.level === 'UNIT' || descendants.length !== 1) return [];
      const child = descendants[0]!;
      if (!Number.isSafeInteger(child.unitsPerParent) || child.unitsPerParent <= 0) return [];
      canonicalUnitsPerPack *= child.unitsPerParent;
      if (!Number.isSafeInteger(canonicalUnitsPerPack)) return [];
      cursor = child;
    }
    return [{ packLevelId: level.id, level: level.level, canonicalUnitsPerPack, chain }];
  });
}

/**
 * The sentence the receiving bench reads back after a pack level is chosen, so
 * the conversion being applied is visible before the quantity is committed.
 */
export function describePackConversion(conversion: PackConversion, packs = 1): string {
  const units = conversion.canonicalUnitsPerPack * packs;
  const label = `${packs} ${conversion.level}${packs === 1 ? '' : 's'}`;
  if (conversion.chain.length <= 1) return `${label} = ${units} units`;
  const inner = conversion.chain
    .slice(1)
    .filter((step) => step.level !== 'UNIT')
    .map((step, index) => {
      const multiplier = conversion.chain
        .slice(1, index + 2)
        .reduce((total, previous) => total * previous.unitsPerParent, packs);
      return `${multiplier} ${step.level}${multiplier === 1 ? '' : 's'}`;
    })
    .join(' = ');
  return `${label}${inner ? ` = ${inner}` : ''} = ${units} units`;
}
