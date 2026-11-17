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
  // canonical units. It offers that sealed pack and, when it holds more than
  // one, the loose canonical unit — never an invented strip.
  // A leaf received within an existing hierarchy is already one canonical
  // unit; its unitsPerParent describes its parent, not the received pack.
  if (chain.length === 1) {
    const pack = chain[0]!;
    assertPositiveInteger(pack.unitsPerParent);
    const canonicalUnits = pack.parentPackLevelId === null ? pack.unitsPerParent : 1;
    if (canonicalUnits !== input.unitsPerPack) {
      throw new PharmacyMedicineError('INVALID_CONVERSION');
    }
    return lotSaleUnitOptions({
      packLevelId: pack.id,
      levelLabel: pack.level,
      unitsPerPack: canonicalUnits,
    });
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
 * the server. Only units that divide the received pack evenly are offered:
 * `priceFromLot` refuses a sale unit bigger than the pack it came in, and a
 * unit that does not divide the pack cannot be cut from it on the shelf.
 *
 * The toggle is anchored at the OUTERMOST setup level that divides every pack
 * size, not at the setup's top: kinds are positional, so anchoring there keeps
 * exactly one PACK and one UNIT (a 100-tablet box lot under a carton setup
 * sells as box / strip / unit, never as two strips).
 *
 * Returns `[]` when the setup itself is ambiguous (no single top level, a level
 * with two children, a cycle) or no level divides the received pack.
 */
export function setupSaleUnitOptions(input: {
  packLevels: readonly PackLevelNode[];
  lotUnitsPerPack: number;
  /**
   * Pack sizes of the other sellable lots the server's FEFO allocation may
   * draw from for the same line; every one of them must price the unit too.
   */
  otherLotUnitsPerPack?: readonly number[];
}): SaleUnitOption[] {
  const packSizes = [input.lotUnitsPerPack, ...(input.otherLotUnitsPerPack ?? [])];
  if (packSizes.some((size) => !Number.isSafeInteger(size) || size <= 0)) return [];
  const ids = new Set(input.packLevels.map((node) => node.id));
  const roots = input.packLevels.filter(
    (node) => node.parentPackLevelId === null || !ids.has(node.parentPackLevelId)
  );
  if (roots.length !== 1) return [];
  const root = roots[0]!;
  try {
    const detached = input.packLevels.map((node) =>
      node.id === root.id ? { ...node, parentPackLevelId: null } : node
    );
    const chain = chainFrom(detached, root.id);
    const cumulative = setupCumulativeUnits(chain);
    const anchor = cumulative.findIndex((units) => packSizes.every((size) => size % units === 0));
    if (anchor === -1) return [];
    return saleUnitOptions({
      packLevels: detached,
      rootPackLevelId: chain[anchor]!.id,
      unitsPerPack: cumulative[anchor]!,
    });
  } catch {
    return [];
  }
}

/** A lot that cannot be sold in any unit of the medicine's setup, in shop words. */
export type CounterPackMismatch = {
  /** How the batch was received, e.g. `1 box = 100 tablets`. */
  received: string;
  /** How the medicine is set up, e.g. `1 box = 10 strips × 10 tablets`; null when unclear. */
  setup: string | null;
};

/** A pack level as stored, with the version window the counter reads. */
type DatedPackLevelNode = PackLevelNode & {
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  versionGroupId?: string;
};

/**
 * The levels in effect at `at`. Revising a pack level closes it and creates its
 * successor in the same version group without reparenting its children, so a
 * child may still point at the closed version. It is re-linked to the effective
 * version of that parent.
 */
function effectivePackLevels<T extends DatedPackLevelNode>(
  packLevels: readonly T[],
  at: Date
): T[] {
  const time = at.getTime();
  const isEffective = (node: T) =>
    (node.effectiveFrom === undefined || node.effectiveFrom.getTime() <= time) &&
    (node.effectiveTo === undefined ||
      node.effectiveTo === null ||
      node.effectiveTo.getTime() > time);
  const byId = new Map(packLevels.map((node) => [node.id, node]));
  const effectiveByGroup = new Map<string, string>();
  for (const node of packLevels) {
    if (node.versionGroupId !== undefined && isEffective(node)) {
      effectiveByGroup.set(node.versionGroupId, node.id);
    }
  }
  return packLevels.filter(isEffective).map((node) => {
    const parent = node.parentPackLevelId === null ? undefined : byId.get(node.parentPackLevelId);
    if (!parent || isEffective(parent) || parent.versionGroupId === undefined) return node;
    const current = effectiveByGroup.get(parent.versionGroupId);
    return current ? { ...node, parentPackLevelId: current } : node;
  });
}

/**
 * DEV-830 (F05): the canonical base units one sale unit at `packLevelId` holds,
 * derived from the stored pack setup alone. Both arrangements the counter can
 * offer are read: the full hierarchy (`saleUnitOptions`) and the setup in effect
 * at `at` (`setupSaleUnitOptions`). A broken or ambiguous chain offers nothing.
 * The server compares a requested multiplier with these counts, so a request
 * cannot sell a pack while charging and debiting a single unit.
 */
export function packLevelCanonicalUnits(input: {
  packLevels: readonly DatedPackLevelNode[];
  packLevelId: string;
  at: Date;
}): number[] {
  const counts = new Set<number>();
  const read = (levels: readonly PackLevelNode[]) => {
    try {
      const chain = chainFrom(levels, input.packLevelId);
      if (chain.length > 1) {
        counts.add(setupCumulativeUnits(chain)[0]!);
        return;
      }
      // A lone top level counts its own units; a leaf under a parent is one unit.
      const units = chain[0]!.parentPackLevelId === null ? chain[0]!.unitsPerParent : 1;
      assertPositiveInteger(units);
      counts.add(units);
    } catch {
      // Not derivable from this arrangement.
    }
  };
  read(input.packLevels);
  const effective = effectivePackLevels(input.packLevels, input.at);
  const ids = new Set(effective.map((node) => node.id));
  const roots = effective.filter(
    (node) => node.parentPackLevelId === null || !ids.has(node.parentPackLevelId)
  );
  read(
    roots.length === 1
      ? effective.map((node) =>
          node.id === roots[0]!.id ? { ...node, parentPackLevelId: null } : node
        )
      : effective
  );
  return [...counts];
}

/**
 * The counter's sale units for one lot (DEV-724).
 *
 * The lot's own received pack level is preferred. When it disagrees with the
 * medicine's pack setup, the medicine's current setup is used instead (pack,
 * strip and loose), priced from the same lot so the server's `addSaleLine`
 * derives the same price. When the setup cannot price the lot either, the lot's
 * own sealed pack and loose unit are offered (`lotSaleUnitOptions`, DEV-717).
 * Only when nothing is sellable is a plain-words mismatch reported.
 */
export function resolveCounterSaleUnits(input: {
  packLevels: readonly (PackLevelNode & {
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    versionGroupId?: string;
  })[];
  lotPackLevelId: string;
  lotPackLevelLabel: string | null;
  lotUnitsPerPack: number;
  /** Pack sizes of the other sellable lots FEFO may also allocate this line from. */
  otherLotUnitsPerPack?: readonly number[];
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
  const effective = effectivePackLevels(input.packLevels, input.at);
  const saleUnits = setupSaleUnitOptions({
    packLevels: effective,
    lotUnitsPerPack: input.lotUnitsPerPack,
    otherLotUnitsPerPack: input.otherLotUnitsPerPack,
  });
  if (saleUnits.length > 0) return { saleUnits, packMismatch: null };
  try {
    // FEFO may also draw on the other lots, so the sealed pack is offered only
    // when every one of them can price it; the loose unit always divides.
    const otherSizes = input.otherLotUnitsPerPack ?? [];
    const lotUnits = lotSaleUnitOptions({
      packLevelId: input.lotPackLevelId,
      levelLabel: input.lotPackLevelLabel ?? 'PACK',
      unitsPerPack: input.lotUnitsPerPack,
    }).filter((option) =>
      otherSizes.every((size) => size % option.canonicalUnitsPerSaleUnit === 0)
    );
    if (lotUnits.length > 0) return { saleUnits: lotUnits, packMismatch: null };
  } catch {
    // An unusable lot conversion is reported below.
  }
  const noun = counterUnitNoun(input.dosageForm);
  return {
    saleUnits: [],
    packMismatch: {
      received: `1 ${packWord(input.lotPackLevelLabel ?? 'pack')} = ${input.lotUnitsPerPack} ${plural(noun, input.lotUnitsPerPack)}`,
      setup: describePackSetup(effective, noun),
    },
  };
}

/**
 * Canonical units in one pack at each level of a setup chain, outermost first.
 * A lone top level counts its own `unitsPerParent`; otherwise the leaf is one
 * canonical unit and each level above multiplies its child's count.
 */
function setupCumulativeUnits(chain: readonly PackLevelNode[]): number[] {
  if (chain.length === 1) {
    assertPositiveInteger(chain[0]!.unitsPerParent);
    return [chain[0]!.unitsPerParent];
  }
  const cumulative: number[] = new Array(chain.length).fill(1);
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    const child = chain[index + 1]!;
    assertPositiveInteger(child.unitsPerParent);
    const total = cumulative[index + 1]! * child.unitsPerParent;
    if (!Number.isSafeInteger(total)) throw new PharmacyMedicineError('INVALID_CONVERSION');
    cumulative[index] = total;
  }
  return cumulative;
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
  if (count === 1) return noun;
  return /(s|x|z|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`;
}

function packWord(level: string): string {
  return level.toLowerCase().replace(/_/g, ' ');
}

/**
 * The sale units a lot can always be sold in from its own frozen conversion:
 * the sealed pack and, when the pack holds more than one, the loose canonical
 * unit. No strip is offered because a strip only exists in a pack hierarchy.
 *
 * Used for a standalone pack, and as the fallback when the pack table no
 * longer agrees with the received lot: `unitsPerPack` is what the server
 * prices from (MED-08), so both options remain prices the server will honour.
 */
export function lotSaleUnitOptions(input: {
  packLevelId: string;
  levelLabel: string;
  unitsPerPack: number;
}): SaleUnitOption[] {
  assertPositiveInteger(input.unitsPerPack);
  const pack: SaleUnitOption = {
    kind: 'PACK',
    packLevelId: input.packLevelId,
    levelLabel: input.levelLabel,
    canonicalUnitsPerSaleUnit: input.unitsPerPack,
  };
  if (input.unitsPerPack === 1) return [pack];
  return [
    pack,
    {
      kind: 'UNIT',
      packLevelId: input.packLevelId,
      levelLabel: 'UNIT',
      canonicalUnitsPerSaleUnit: 1,
    },
  ];
}

/**
 * The option the loose-unit chord (F5) selects: the `UNIT` option, or, for a
 * lot received at the base level, the option that already sells exactly one
 * canonical unit. `null` means no loose unit is sellable for this lot.
 */
export function looseSaleUnitOption<
  T extends Pick<SaleUnitOption, 'kind' | 'canonicalUnitsPerSaleUnit'>,
>(options: readonly T[]): T | null {
  return (
    options.find((option) => option.kind === 'UNIT') ??
    options.find((option) => option.canonicalUnitsPerSaleUnit === 1) ??
    null
  );
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

/** Safe on-hand stock in the cashier's chosen sale unit, e.g. "236 strips". */
export function onHandInSaleUnitLabel(
  preview: Pick<SaleLinePreview, 'option' | 'availableUnits'>
): string {
  const perUnit = Math.max(1, preview.option.canonicalUnitsPerSaleUnit);
  const count = Math.floor(preview.availableUnits / perUnit);
  const name = preview.option.levelLabel.trim().toLowerCase() || 'unit';
  return `${count} ${plural(name, count)}`;
}
