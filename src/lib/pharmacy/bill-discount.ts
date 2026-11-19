/**
 * DEV-956: the whole-bill discount at the pharmacy counter, as pure integer money.
 *
 * A bill discount is never a bill-level amount. It is shared onto the bill's lines, so every
 * receipt, return, refund, void, journal posting and report that already reads a line's
 * discount stays exact. The order of discounts on a bill is fixed:
 *
 * 1. Line discounts, priced when the line is added: a voucher, an automatic promotion, an item
 *    discount or a complimentary line. A line carries at most one of these.
 * 2. The whole-bill discount, on an open bill that has taken no payment. It goes only onto lines
 *    that have no line discount of their own; it never stacks with one.
 * 3. The prepaid tier discount, priced at payment on what is left after 1 and 2, within the same
 *    owner's maximum and minimum margin on each line and lot.
 * 4. Loyalty points, which are a payment of what is left after every discount, never a discount.
 *
 * The share of each line is its part of the bill by price (largest remainder, so the shares add
 * up to the paisa). No line goes past the owner's maximum discount on its own price, and no lot
 * goes below its cost or the branch's minimum margin: a line that reaches its limit keeps it and
 * the rest moves to the other lines. A discount the eligible lines cannot take in full is refused
 * with the most they can take, never cut down silently.
 */
import {
  BPS,
  isRegulatedForDiscount,
  lineDiscountRoomMinor,
  minimumPriceForMargin,
} from './smart-discount';

export type BillDiscountRequest =
  { kind: 'PERCENT'; bps: number } | { kind: 'AMOUNT'; minor: number };

/** Why a line takes no share. The counter tells the cashier each one in plain words. */
export type BillDiscountExclusion =
  /** Prescription-only, restricted or controlled: never discounted. */
  | 'REGULATED'
  /** Already priced by its own voucher, promotion, item discount or complimentary rule. */
  | 'OWN_DISCOUNT'
  /** Already priced by the customer's prepaid tier. */
  | 'TIER_PRICED'
  /** At its cost, minimum-margin floor or the owner's maximum already: no room left. */
  | 'AT_FLOOR'
  /** Sold before per-batch prices were kept, so its share cannot be checked per batch. */
  | 'UNPRICED';

export type BillDiscountLine = {
  id: string;
  createdAt: Date;
  grossMinor: number;
  discountMinor: number;
  discountKind?: string | null;
  voucherId?: string | null;
  promotionId?: string | null;
  tierDiscountMinor?: number;
  tierName?: string | null;
  /** The line's current bill share; it is replaced, never added to. */
  billDiscountMinor?: number;
  medicine: { rx: boolean; restricted: boolean; controlled: boolean };
  allocations: readonly {
    id: string;
    canonicalUnits: number;
    grossMinor?: number | null;
    discountMinor?: number | null;
    lot: { unitCostMinor: number };
  }[];
};

export type BillDiscountLimits = { minMarginBps: number; maxDiscountBps: number };

export type BillDiscountShare = {
  saleLineId: string;
  discountMinor: number;
  /** Allocation id -> minor units; sums to `discountMinor`. */
  allocations: Record<string, number>;
};

export type BillDiscountPlan = {
  /** The amount the discount asks for, in minor units. */
  requestedMinor: number;
  /** The total shared onto lines; equal to `requestedMinor` whenever the plan is `OK`. */
  totalMinor: number;
  /** The most the eligible lines can take under every limit. */
  capacityMinor: number;
  /** The price of the lines that can take a share (a percentage is a share of this). */
  eligibleGrossMinor: number;
  shares: BillDiscountShare[];
  excluded: { saleLineId: string; reason: BillDiscountExclusion }[];
};

export class BillDiscountRefused extends Error {
  constructor(
    readonly reason:
      'NOTHING_TO_DISCOUNT' | 'ABOVE_LIMIT' | 'DISCOUNT_ABOVE_MAXIMUM' | 'INVALID_REQUEST',
    readonly plan?: BillDiscountPlan
  ) {
    super(reason);
  }
}

/**
 * DEV-966: whether a line's whole-bill share is held by a prepaid tier share priced on top of it.
 * The tier priced the line after the bill share (a cash-on-delivery bill is priced when the rider
 * collects, before any tender), so the bill share can no longer be cleared, changed or removed:
 * the database refuses it, and the service refuses it first in words.
 */
export function billShareHeldByTier(
  line: Pick<BillDiscountLine, 'billDiscountMinor' | 'tierDiscountMinor'>
) {
  return (line.billDiscountMinor ?? 0) > 0 && (line.tierDiscountMinor ?? 0) !== 0;
}

/** The line's discount before any bill share: what its own rule gave it, plus any tier share. */
function ownDiscountMinor(line: BillDiscountLine) {
  return line.discountMinor - (line.billDiscountMinor ?? 0);
}

/**
 * Why `line` cannot take a share, or null when it can. A line that holds only a bill share
 * (its own discount is zero) is eligible: re-giving the discount replaces that share.
 */
export function billDiscountExclusion(line: BillDiscountLine): BillDiscountExclusion | null {
  if (isRegulatedForDiscount(line.medicine)) return 'REGULATED';
  if ((line.tierDiscountMinor ?? 0) > 0 || line.tierName) return 'TIER_PRICED';
  const bill = line.billDiscountMinor ?? 0;
  if (
    ownDiscountMinor(line) !== 0 ||
    line.voucherId ||
    line.promotionId ||
    (bill === 0 && line.discountKind)
  )
    return 'OWN_DISCOUNT';
  if (
    line.allocations.length === 0 ||
    line.allocations.some((a) => a.grossMinor == null || a.discountMinor == null)
  )
    return 'UNPRICED';
  return null;
}

/** Each allocation's room above its cost and minimum-margin floor. */
function allocationRoom(line: BillDiscountLine, limits: BillDiscountLimits) {
  return line.allocations.map((a) =>
    Math.max(
      0,
      a.grossMinor! -
        a.discountMinor! -
        minimumPriceForMargin(a.canonicalUnits * a.lot.unitCostMinor, limits.minMarginBps)
    )
  );
}

/**
 * Share `totalMinor` over `weights` by largest remainder: floor each exact share, then give
 * the remaining units one each to the largest remainders (ties to the earlier entry).
 * Exact for any integers: products are BigInt.
 */
export function largestRemainder(totalMinor: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + BigInt(weight), BigInt(0));
  if (sum <= BigInt(0) || totalMinor <= 0) return weights.map(() => 0);
  const total = BigInt(totalMinor);
  const exact = weights.map((weight) => total * BigInt(weight));
  const shares = exact.map((product) => product / sum);
  let left = Number(total - shares.reduce((acc, share) => acc + share, BigInt(0)));
  const order = exact
    .map((product, index) => ({ index, remainder: product % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1
    );
  for (const { index } of order) {
    if (left <= 0) break;
    shares[index]! += BigInt(1);
    left -= 1;
  }
  return shares.map(Number);
}

/**
 * Share `totalMinor` over lines in proportion to `weights`, never giving one more than its
 * `caps`. A line that reaches its cap keeps it and the rest is shared again over the others.
 * Requires `totalMinor <= sum(caps)`.
 */
export function cappedLargestRemainder(
  totalMinor: number,
  weights: readonly number[],
  caps: readonly number[]
): number[] {
  const shares = weights.map(() => 0);
  let left = totalMinor;
  for (let round = 0; left > 0 && round <= weights.length; round += 1) {
    const open = weights.map((_, i) => (shares[i]! < caps[i]! ? weights[i]! : 0));
    if (!open.some((weight) => weight > 0)) break;
    const offer = largestRemainder(left, open);
    let given = 0;
    offer.forEach((amount, i) => {
      const take = Math.min(amount, caps[i]! - shares[i]!);
      shares[i]! += take;
      given += take;
    });
    left -= given;
    if (given === 0) break;
  }
  // Only units no open line could take on its own weight are left; place them in line order.
  for (let i = 0; left > 0 && i < shares.length; i += 1) {
    const take = Math.min(left, caps[i]! - shares[i]!);
    shares[i]! += take;
    left -= take;
  }
  if (left !== 0) throw new RangeError('Bill discount exceeds capacity');
  return shares;
}

/** The amount, in minor units, a request asks for on `eligibleGrossMinor` of lines. */
export function billDiscountRequestedMinor(
  request: BillDiscountRequest,
  eligibleGrossMinor: number
): number {
  if (request.kind === 'PERCENT') {
    if (!Number.isInteger(request.bps) || request.bps < 0 || request.bps > BPS)
      throw new BillDiscountRefused('INVALID_REQUEST');
    // Rounded down, so a percentage never asks for more than the share the cashier gave.
    return Number((BigInt(eligibleGrossMinor) * BigInt(request.bps)) / BigInt(BPS));
  }
  if (!Number.isSafeInteger(request.minor) || request.minor < 0)
    throw new BillDiscountRefused('INVALID_REQUEST');
  return request.minor;
}

/**
 * Plan a whole-bill discount over `lines`. Throws `BillDiscountRefused` when it cannot be given
 * in full; a zero request plans the removal of every bill share.
 */
export function planBillDiscount(
  lines: readonly BillDiscountLine[],
  request: BillDiscountRequest,
  limits: BillDiscountLimits
): BillDiscountPlan {
  // The owner's maximum binds a percentage outright, as it binds an item discount.
  if (request.kind === 'PERCENT' && request.bps > Math.max(0, limits.maxDiscountBps))
    throw new BillDiscountRefused('DISCOUNT_ABOVE_MAXIMUM');
  const ordered = [...lines].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
  );
  const excluded: BillDiscountPlan['excluded'] = [];
  const candidates: { line: BillDiscountLine; room: number[]; capacity: number }[] = [];
  for (const line of ordered) {
    const reason = billDiscountExclusion(line);
    if (reason) {
      excluded.push({ saleLineId: line.id, reason });
      continue;
    }
    const room = allocationRoom(line, limits);
    // The line's own discount is zero here, so the whole line limit an item discount meets is
    // open to the bill share: the owner's maximum and the minimum margin on the line's total
    // cost. A lot already priced below its own floor takes no share but still counts against
    // the line's floor. Within that, each lot keeps its own floor.
    const capacity = Math.min(
      room.reduce((sum, n) => sum + n, 0),
      lineDiscountRoomMinor({
        grossMinor: line.grossMinor,
        costMinor: line.allocations.reduce(
          (sum, a) => sum + a.canonicalUnits * a.lot.unitCostMinor,
          0
        ),
        minMarginBps: limits.minMarginBps,
        maxDiscountBps: limits.maxDiscountBps,
      })
    );
    if (capacity <= 0) {
      excluded.push({ saleLineId: line.id, reason: 'AT_FLOOR' });
      continue;
    }
    candidates.push({ line, room, capacity });
  }
  const eligibleGrossMinor = candidates.reduce((sum, c) => sum + c.line.grossMinor, 0);
  const capacityMinor = candidates.reduce((sum, c) => sum + c.capacity, 0);
  const requestedMinor = billDiscountRequestedMinor(request, eligibleGrossMinor);
  const empty: BillDiscountPlan = {
    requestedMinor,
    totalMinor: 0,
    capacityMinor,
    eligibleGrossMinor,
    shares: [],
    excluded,
  };
  const removal = request.kind === 'PERCENT' ? request.bps === 0 : request.minor === 0;
  if (removal) return empty;
  // A discount that comes to nothing on what can be discounted is refused, never a silent no-op.
  if (candidates.length === 0 || requestedMinor === 0)
    throw new BillDiscountRefused('NOTHING_TO_DISCOUNT', empty);
  if (requestedMinor > capacityMinor) throw new BillDiscountRefused('ABOVE_LIMIT', empty);
  const lineShares = cappedLargestRemainder(
    requestedMinor,
    candidates.map((c) => c.line.grossMinor),
    candidates.map((c) => c.capacity)
  );
  const shares: BillDiscountShare[] = [];
  candidates.forEach((candidate, index) => {
    const amount = lineShares[index]!;
    if (amount === 0) return;
    // Within the line, each lot takes its part by its own room, so none goes below its floor.
    const parts = cappedLargestRemainder(amount, candidate.room, candidate.room);
    shares.push({
      saleLineId: candidate.line.id,
      discountMinor: amount,
      allocations: Object.fromEntries(candidate.line.allocations.map((a, i) => [a.id, parts[i]!])),
    });
  });
  return { ...empty, totalMinor: requestedMinor, shares };
}

/** A lot's share of a line's whole-bill discount (0 when none or malformed). */
export function billAllocationDiscount(snapshot: unknown, allocationId: string): number {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 0;
  const value = (snapshot as Record<string, unknown>)[allocationId];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
