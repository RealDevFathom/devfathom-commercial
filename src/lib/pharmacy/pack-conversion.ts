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
 * `unitsPerParent` counts how many of the next level down fit inside one pack at
 * this level, so a leaf level's value is already canonical base units per pack
 * and every level above it multiplies down the chain.
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
 * A malformed hierarchy — a cycle, or a level whose parent is not effective —
 * must not hang the console or silently invent a multiplier, so descent stops
 * at the first level it has already visited and a branch point is resolved
 * deterministically by (level, id) rather than by insertion order.
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
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.level.localeCompare(b.level) || a.id.localeCompare(b.id));
  }

  return effective.map((level) => {
    const chain: PackConversionStep[] = [];
    const seen = new Set<string>();
    let canonicalUnitsPerPack = 1;
    let cursor: PackLevelNode | undefined = level;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.push({
        packLevelId: cursor.id,
        level: cursor.level,
        unitsPerParent: cursor.unitsPerParent,
      });
      canonicalUnitsPerPack *= cursor.unitsPerParent;
      cursor = children.get(cursor.id)?.[0];
    }
    return {
      packLevelId: level.id,
      level: level.level,
      canonicalUnitsPerPack,
      chain,
    };
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
    .map((step, index) => {
      const multiplier = conversion.chain
        .slice(0, index + 1)
        .reduce((total, previous) => total * previous.unitsPerParent, packs);
      return `${multiplier} ${step.level}${multiplier === 1 ? '' : 's'}`;
    })
    .join(' = ');
  return `${label} = ${inner} = ${units} units`;
}

/** Outer packs rank above the packs they contain. */
export const PACK_LEVEL_RANK: Readonly<Record<string, number>> = {
  UNIT: 0,
  STRIP: 1,
  BOX: 2,
  CARTON: 3,
};

/**
 * The pack setup form asks for the individual units printed on each pack, but
 * the hierarchy stores per-level counts. Placing a pack of `innerTotal` units
 * inside an innermost pack of `outerTotal` units keeps the outer total: the
 * outer level then counts `outerTotal / innerTotal` inner packs and the new
 * inner (leaf) level counts `innerTotal` units.
 */
export function splitPackTotal(
  outer: { level: string; totalUnits: number },
  inner: { level: string; totalUnits: number }
): { outerUnitsPerParent: number; innerUnitsPerParent: number } | { error: string } {
  const { totalUnits: outerTotal } = outer;
  const { totalUnits: innerTotal } = inner;
  if (!Number.isSafeInteger(innerTotal) || innerTotal <= 0)
    return { error: 'Enter a positive whole number of individual units.' };
  if (inner.level === 'UNIT' && innerTotal !== 1)
    return { error: 'A single unit must contain exactly 1 individual unit.' };
  const outerRank = PACK_LEVEL_RANK[outer.level];
  const innerRank = PACK_LEVEL_RANK[inner.level];
  if (outerRank !== undefined && innerRank !== undefined && innerRank >= outerRank)
    return {
      error: `A ${inner.level} cannot be placed inside a ${outer.level}. Choose a smaller pack type.`,
    };
  if (
    !Number.isSafeInteger(outerTotal) ||
    outerTotal <= innerTotal ||
    outerTotal % innerTotal !== 0
  )
    return {
      error: `1 ${outer.level} holds ${outerTotal} units, which is not a whole number of packs of ${innerTotal}. Check the units printed on each pack.`,
    };
  return { outerUnitsPerParent: outerTotal / innerTotal, innerUnitsPerParent: innerTotal };
}

/**
 * Packs created without a parent are each counted directly in individual
 * units. They read as one chain, outermost first, when every pack total is a
 * whole multiple of the next smaller one (e.g. BOX 100, STRIP 10, UNIT 1).
 * Returns null when the effective levels are not all flat or their totals do
 * not divide evenly, because the packs then disagree about their contents.
 */
export function flatPackChain(
  levels: readonly PackLevelNode[],
  at: Date = new Date()
): PackLevelNode[] | null {
  const effective = levels.filter((level) => isEffective(level, at));
  if (
    effective.some(
      (level) =>
        level.parentPackLevelId !== null ||
        !Number.isSafeInteger(level.unitsPerParent) ||
        level.unitsPerParent <= 0
    )
  )
    return null;
  const ordered = [...effective].sort(
    (a, b) =>
      b.unitsPerParent - a.unitsPerParent ||
      (PACK_LEVEL_RANK[b.level] ?? 0) - (PACK_LEVEL_RANK[a.level] ?? 0) ||
      a.id.localeCompare(b.id)
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]!.unitsPerParent % ordered[index]!.unitsPerParent !== 0) return null;
  }
  return ordered;
}
