/**
 * M4-L1 — pure kitchen-station routing resolution.
 *
 * Given an order item's product (and its category) plus a branch's routing rules
 * and default station, decide which kitchen station the item fires to. This is
 * the single source of the most-specific-wins precedence used by L2's ticket
 * generation and CRUDed by L3:
 *
 *   product-level rule  >  category-level rule  >  course-level rule  >  branch default station
 *
 * Within a level, the highest `priority` wins; ties are broken deterministically
 * by station id (ascending) so the result never depends on rule insertion order.
 * A rule targets exactly one of product, category or course (the DB enforces the XOR), so
 * a rule contributes to exactly one level.
 *
 * The module performs no I/O — the caller loads the rules (already tenant- and
 * branch-scoped) and the default station and passes them in.
 */

/** A routing rule as resolution needs it. `productId` XOR `categoryId` is set
 * (guaranteed by the DB CHECK). */
export type StationRoutingRule = {
  stationId: string;
  productId: string | null;
  categoryId: string | null;
  course: number | null;
  priority: number;
};

/** What we are routing: an item's product and the category it belongs to (null
 * when the product is uncategorised). */
export type RoutingTarget = {
  productId: string;
  categoryId: string | null;
  course: number;
};

/** How the station was chosen — useful for KOT/debug attribution. */
export type StationMatchLevel = 'product' | 'category' | 'course' | 'default';

export type StationResolution = {
  stationId: string;
  matchedBy: StationMatchLevel;
};

/** Pick the winning rule among a same-level candidate set: highest priority,
 * then smallest station id for determinism. Returns null for an empty set. */
function pickWinner(candidates: readonly StationRoutingRule[]): StationRoutingRule | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => {
    if (candidate.priority > best.priority) return candidate;
    if (candidate.priority === best.priority && candidate.stationId < best.stationId) {
      return candidate;
    }
    return best;
  });
}

/**
 * Resolve the station for `target`. Returns the winning station and the level it
 * matched on, or `null` when nothing matches and no default station is
 * configured (the caller then rejects/holds the item rather than misrouting it).
 */
export function resolveStation(
  target: RoutingTarget,
  rules: readonly StationRoutingRule[],
  defaultStationId: string | null
): StationResolution | null {
  const productWinner = pickWinner(
    rules.filter((rule) => rule.productId !== null && rule.productId === target.productId)
  );
  if (productWinner) return { stationId: productWinner.stationId, matchedBy: 'product' };

  if (target.categoryId !== null) {
    const categoryWinner = pickWinner(
      rules.filter((rule) => rule.categoryId !== null && rule.categoryId === target.categoryId)
    );
    if (categoryWinner) return { stationId: categoryWinner.stationId, matchedBy: 'category' };
  }

  const courseWinner = pickWinner(
    rules.filter((rule) => rule.course !== null && rule.course === target.course)
  );
  if (courseWinner) return { stationId: courseWinner.stationId, matchedBy: 'course' };

  if (defaultStationId !== null) {
    return { stationId: defaultStationId, matchedBy: 'default' };
  }
  return null;
}
