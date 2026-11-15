/**
 * PH-POS / POS-03 surface — the pack/strip/unit toggle and its exact preview.
 *
 * Pure and database-free. The toggle is derived from the MED-02 pack hierarchy
 * the lot was received against, and every price comes from `priceFromLot` in
 * the pure MED-08 module, so
 * the number the cashier sees before pressing "add" is produced by the SAME
 * derivation the server applies when the line is written (MED-08). A second,
 * prettier client-side price formula is exactly how a counter starts quoting
 * totals it cannot honour.
 *
 * INTEGER CANONICAL UNITS ONLY. Quantities are counts of canonical base units
 * and prices are minor currency units; a non-integer is a programming error and
 * raises rather than rounding.
 */

import { PharmacyMedicineError, priceFromLot } from './medicine';

/** The three units a pharmacy counter sells in (POS-03). */
export type SaleUnitKind = 'PACK' | 'STRIP' | 'UNIT';

/** One node of the MED-02 pack hierarchy, as stored on `PackLevel`. */
export type PackLevelNode = {
  id: string;
  /** `CARTON`, `BOX`, `STRIP` or `UNIT` — the label the operator reads. */
  level: string;
  parentPackLevelId: string | null;
  /** How many of THIS level fit inside one of its parent. */
  unitsPerParent: number;
};

export type SaleUnitOption = {
  kind: SaleUnitKind;
  packLevelId: string;
  /** The stored pack-level label, so a CARTON is not relabelled "pack". */
  levelLabel: string;
  /** Canonical base units contained in one of this sale unit. */
  canonicalUnitsPerSaleUnit: number;
};

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PharmacyMedicineError('INVALID_CONVERSION');
  }
}

/**
 * The chain from the lot's own pack level down to the canonical base unit.
 *
 * Starts at `rootPackLevelId` — the level the lot was received against — rather
 * than at the deepest level in the table, because a lot of strips must not
 * offer a carton the branch never received.
 */
function chainFrom(packLevels: readonly PackLevelNode[], rootPackLevelId: string): PackLevelNode[] {
  const byId = new Map(packLevels.map((node) => [node.id, node]));
  const childrenOf = new Map<string, PackLevelNode[]>();
  for (const node of packLevels) {
    if (node.parentPackLevelId === null) continue;
    const siblings = childrenOf.get(node.parentPackLevelId) ?? [];
    siblings.push(node);
    childrenOf.set(node.parentPackLevelId, siblings);
  }

  const root = byId.get(rootPackLevelId);
  if (!root) throw new PharmacyMedicineError('NOT_FOUND');

  const chain: PackLevelNode[] = [root];
  const guard = new Set<string>([root.id]);
  for (;;) {
    const children = childrenOf.get(chain[chain.length - 1]!.id) ?? [];
    if (children.length === 0) break;
    // A level with two children is an ambiguous hierarchy, not a choice the
    // counter is allowed to make silently.
    if (children.length > 1) throw new PharmacyMedicineError('INVALID_CONVERSION');
    const next = children[0]!;
    if (guard.has(next.id)) throw new PharmacyMedicineError('INVALID_CONVERSION');
    guard.add(next.id);
    chain.push(next);
  }
  return chain;
}

/**
 * The sale units this lot can be sold in, largest first.
 *
 * The deepest level is always `UNIT` (the canonical base unit), the lot's own
 * level is always `PACK`, and anything between them is a `STRIP`. Mapping by
 * POSITION rather than by the stored label is what lets a CARTON → BOX → UNIT
 * medicine and a BOX → STRIP → UNIT medicine share one toggle without the
 * counter inventing a strip that does not exist.
 *
 * `unitsPerPack` is the lot's frozen canonical units per sealed pack; the
 * derived hierarchy must agree with it, otherwise the pack table and the
 * received lot disagree and no price is trustworthy.
 */
export function saleUnitOptions(input: {
  packLevels: readonly PackLevelNode[];
  rootPackLevelId: string;
  unitsPerPack: number;
}): SaleUnitOption[] {
  assertPositiveInteger(input.unitsPerPack);
  const chain = chainFrom(input.packLevels, input.rootPackLevelId);
  // The receiving setup also supports a standalone pack counted directly in
  // canonical units. It offers only that sealed pack, with no invented strip.
  // A leaf received within an existing hierarchy is already one canonical
  // unit; its unitsPerParent describes its parent, not the received pack.
  if (chain.length === 1) {
    const pack = chain[0]!;
    assertPositiveInteger(pack.unitsPerParent);
    const canonicalUnits = pack.parentPackLevelId === null ? pack.unitsPerParent : 1;
    if (canonicalUnits !== input.unitsPerPack) {
      throw new PharmacyMedicineError('INVALID_CONVERSION');
    }
    return [
      {
        kind: 'PACK',
        packLevelId: pack.id,
        levelLabel: pack.level,
        canonicalUnitsPerSaleUnit: canonicalUnits,
      },
    ];
  }

  // Cumulative canonical units, computed from the base unit upwards.
  const canonical: number[] = new Array(chain.length).fill(1);
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    const child = chain[index + 1]!;
    assertPositiveInteger(child.unitsPerParent);
    const total = canonical[index + 1]! * child.unitsPerParent;
    if (!Number.isSafeInteger(total)) throw new PharmacyMedicineError('INVALID_CONVERSION');
    canonical[index] = total;
  }
  if (canonical[0] !== input.unitsPerPack) {
    throw new PharmacyMedicineError('INVALID_CONVERSION');
  }

  return chain.map((node, index) => ({
    kind: index === 0 ? 'PACK' : index === chain.length - 1 ? 'UNIT' : 'STRIP',
    packLevelId: node.id,
    levelLabel: node.level,
    canonicalUnitsPerSaleUnit: canonical[index]!,
  }));
}

/**
 * DEV-724 — the sale units the medicine's OWN pack setup offers, for a lot whose
 * recorded pack level or pack size disagrees with that setup.
 *
 * `saleUnitOptions` starts from the level the lot was received against and
 * refuses when the two disagree. That refusal used to leave the counter unable
 * to sell stock that is physically on the shelf. The medicine's pack setup is
 * still a priceable arrangement: every option is priced pro-rata from the lot's
 * printed MRP and frozen `unitsPerPack`, exactly as `addSaleLine` prices it on
 * the server. Only options that divide the received pack evenly are offered:
 * `priceFromLot` refuses a sale unit bigger than the pack it came in, and a
 * unit that does not divide the pack cannot be cut from it on the shelf.
 *
 * Returns `[]` when the setup itself is ambiguous (no single top level, a level
 * with two children, a cycle) or no level divides the received pack.
 */
export function setupSaleUnitOptions(input: {
  packLevels: readonly PackLevelNode[];
  lotUnitsPerPack: number;
}): SaleUnitOption[] {
  if (!Number.isSafeInteger(input.lotUnitsPerPack) || input.lotUnitsPerPack <= 0) return [];
  const ids = new Set(input.packLevels.map((node) => node.id));
  const roots = input.packLevels.filter(
    (node) => node.parentPackLevelId === null || !ids.has(node.parentPackLevelId)
  );
  if (roots.length !== 1) return [];
  const root = roots[0]!;
  let options: SaleUnitOption[];
  try {
    const detached = input.packLevels.map((node) =>
      node.id === root.id ? { ...node, parentPackLevelId: null } : node
    );
    options = saleUnitOptions({
      packLevels: detached,
      rootPackLevelId: root.id,
      unitsPerPack: setupCanonicalUnits(detached, root.id),
    });
  } catch {
    return [];
  }
  return options.filter((option) => input.lotUnitsPerPack % option.canonicalUnitsPerSaleUnit === 0);
}

/** A lot that cannot be sold in any unit of the medicine's setup, in shop words. */
export type CounterPackMismatch = {
  /** How the batch was received, e.g. `1 box = 100 tablets`. */
  received: string;
  /** How the medicine is set up, e.g. `1 box = 10 strips × 10 tablets`; null when unclear. */
  setup: string | null;
};

/**
 * The counter's sale units for one lot (DEV-724).
 *
 * The lot's own received pack level is preferred. When it disagrees with the
 * medicine's pack setup, the medicine's current setup is used instead, priced
 * from the same lot so the server's `addSaleLine` derives the same price. Only
 * when neither yields a sale unit is a plain-words mismatch reported.
 */
export function resolveCounterSaleUnits(input: {
  packLevels: readonly (PackLevelNode & { effectiveFrom?: Date; effectiveTo?: Date | null })[];
  lotPackLevelId: string;
  lotPackLevelLabel: string | null;
  lotUnitsPerPack: number;
  dosageForm: string | null;
  at: Date;
}): { saleUnits: SaleUnitOption[]; packMismatch: CounterPackMismatch | null } {
  try {
    return {
      saleUnits: saleUnitOptions({
        packLevels: input.packLevels,
        rootPackLevelId: input.lotPackLevelId,
        unitsPerPack: input.lotUnitsPerPack,
      }),
      packMismatch: null,
    };
  } catch {
    // Fall through to the medicine's own setup below.
  }
  const at = input.at.getTime();
  const effective = input.packLevels.filter(
    (node) =>
      (node.effectiveFrom === undefined || node.effectiveFrom.getTime() <= at) &&
      (node.effectiveTo === undefined ||
        node.effectiveTo === null ||
        node.effectiveTo.getTime() > at)
  );
  const saleUnits = setupSaleUnitOptions({
    packLevels: effective,
    lotUnitsPerPack: input.lotUnitsPerPack,
  });
  if (saleUnits.length > 0) return { saleUnits, packMismatch: null };
  const noun = counterUnitNoun(input.dosageForm);
  return {
    saleUnits: [],
    packMismatch: {
      received: `1 ${packWord(input.lotPackLevelLabel ?? 'pack')} = ${input.lotUnitsPerPack} ${plural(noun, input.lotUnitsPerPack)}`,
      setup: describePackSetup(effective, noun),
    },
  };
}

/** Canonical units in one top-level pack of the setup, or a throw when malformed. */
function setupCanonicalUnits(
  packLevels: readonly PackLevelNode[],
  rootPackLevelId: string
): number {
  const chain = chainFrom(packLevels, rootPackLevelId);
  if (chain.length === 1) {
    assertPositiveInteger(chain[0]!.unitsPerParent);
    return chain[0]!.unitsPerParent;
  }
  let total = 1;
  for (const node of chain.slice(1)) {
    assertPositiveInteger(node.unitsPerParent);
    total *= node.unitsPerParent;
    if (!Number.isSafeInteger(total)) throw new PharmacyMedicineError('INVALID_CONVERSION');
  }
  return total;
}

/**
 * The pack setup in shop words, outermost first: `1 box = 10 strips × 10 tablets`.
 * Null when the setup has no single, unambiguous chain to describe.
 */
export function describePackSetup(
  packLevels: readonly PackLevelNode[],
  unitNoun: string
): string | null {
  const ids = new Set(packLevels.map((node) => node.id));
  const roots = packLevels.filter(
    (node) => node.parentPackLevelId === null || !ids.has(node.parentPackLevelId)
  );
  if (roots.length !== 1) return null;
  let chain: PackLevelNode[];
  try {
    chain = chainFrom(packLevels, roots[0]!.id);
  } catch {
    return null;
  }
  const top = chain[0]!;
  if (chain.length === 1) {
    return `1 ${packWord(top.level)} = ${top.unitsPerParent} ${plural(unitNoun, top.unitsPerParent)}`;
  }
  const parts = chain
    .slice(1)
    .map((node, index, rest) =>
      index === rest.length - 1
        ? `${node.unitsPerParent} ${plural(unitNoun, node.unitsPerParent)}`
        : `${node.unitsPerParent} ${plural(packWord(node.level), node.unitsPerParent)}`
    );
  return `1 ${packWord(top.level)} = ${parts.join(' × ')}`;
}

/** `TABLET` dosage forms count in tablets, capsules in capsules, anything else in units. */
export function counterUnitNoun(dosageForm: string | null | undefined): string {
  const form = (dosageForm ?? '').toLowerCase();
  if (form.includes('tablet')) return 'tablet';
  if (form.includes('capsule')) return 'capsule';
  return 'unit';
}

export function plural(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function packWord(level: string): string {
  return level.toLowerCase().replace(/_/g, ' ');
}

export type SaleLinePreview = {
  option: SaleUnitOption;
  quantity: number;
  /** Canonical base units this line consumes — what FEFO will allocate. */
  canonicalUnits: number;
  /** Price of one sale unit, derived per MED-08 and never above the ceiling. */
  unitPriceMinor: number;
  /** The pro-rata ceiling for one sale unit, shown so the derivation is legible. */
  proRataCeilingMinor: number;
  grossMinor: number;
  /** Safe stock the branch can actually cover this line from. */
  availableUnits: number;
  sufficient: boolean;
  shortfallUnits: number;
};

/**
 * The exact quantity and price for a candidate line, before anything is sent.
 *
 * `availableUnits` is the SAFE on-hand total (blocked lots already excluded), so
 * `sufficient` answers the only question the cashier has: can this bill be
 * filled now, or is this a POS-10 unfulfilled-demand event.
 */
export function previewSaleLine(input: {
  option: SaleUnitOption;
  quantity: number;
  printedMrpMinor: number;
  unitsPerPack: number;
  roundingIncrementMinor?: number;
  availableUnits: number;
}): SaleLinePreview {
  assertPositiveInteger(input.quantity);
  assertPositiveInteger(input.option.canonicalUnitsPerSaleUnit);
  if (!Number.isSafeInteger(input.availableUnits) || input.availableUnits < 0) {
    throw new PharmacyMedicineError('INVALID_CONVERSION');
  }

  const canonicalUnits = input.quantity * input.option.canonicalUnitsPerSaleUnit;
  if (!Number.isSafeInteger(canonicalUnits)) {
    throw new PharmacyMedicineError('INVALID_CONVERSION');
  }

  const price = priceFromLot({
    printedMrpMinor: input.printedMrpMinor,
    canonicalUnitsInPack: input.unitsPerPack,
    canonicalUnitsPerSaleUnit: input.option.canonicalUnitsPerSaleUnit,
    roundingIncrementMinor: input.roundingIncrementMinor,
  });
  const grossMinor = price.unitPriceMinor * input.quantity;
  if (!Number.isSafeInteger(grossMinor)) {
    throw new PharmacyMedicineError('INVALID_CONVERSION');
  }

  return {
    option: input.option,
    quantity: input.quantity,
    canonicalUnits,
    unitPriceMinor: price.unitPriceMinor,
    proRataCeilingMinor: price.proRataCeilingMinor,
    grossMinor,
    availableUnits: input.availableUnits,
    sufficient: canonicalUnits <= input.availableUnits,
    shortfallUnits: Math.max(0, canonicalUnits - input.availableUnits),
  };
}

/**
 * POS-03 acceptance: "repeat scan increments the same unit".
 *
 * A rescan of a medicine already staged in the same sale unit raises that
 * line's quantity instead of stacking a second line, which is what makes a
 * barcode gun usable at counter speed.
 */
export function incrementRepeatScan<
  T extends { medicineId: string; packLevelId: string; saleUnit: SaleUnitKind; quantity: number },
>(lines: readonly T[], scan: Omit<T, 'quantity'> & { quantity?: number }): T[] {
  const step = scan.quantity ?? 1;
  assertPositiveInteger(step);
  const index = lines.findIndex(
    (line) =>
      line.medicineId === scan.medicineId &&
      line.packLevelId === scan.packLevelId &&
      line.saleUnit === scan.saleUnit
  );
  if (index === -1) return [...lines, { ...(scan as T), quantity: step }];
  return lines.map((line, position) =>
    position === index ? { ...line, quantity: line.quantity + step } : line
  );
}
