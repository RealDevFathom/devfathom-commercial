import {
  compare,
  type Decimal,
  type MoneyInput,
  multiply,
  roundMoney,
  sum,
} from './money-arithmetic';

/**
 * The gross merchandise basis a service charge multiplies: Σ (unit charge) ×
 * quantity, BEFORE comps and discounts. A unit charge is the item's unit price
 * plus its snapshotted modifier deltas. This matches the bill subtotal the
 * snapshot pins at cut time, so the draft-check preview and the stored bill agree.
 */
export function serviceChargeBasis(
  lines: readonly { unitCharge: MoneyInput; quantity: number }[]
): Decimal {
  return sum(lines.map((line) => multiply(line.unitCharge, line.quantity)));
}

/**
 * The service charge for a gross merchandise basis at a branch rate, rounded to
 * money (ROUND_HALF_UP, 2dp). THE SINGLE service-charge computation, shared by
 * the draft-check preview (`draft-check-total`) and the stored bill snapshot
 * (`bills.planBills`), so the amount quoted equals the amount later charged.
 *
 * Tender settlement never recomputes this from the current policy; it reuses the
 * frozen `bill.serviceChargeTotal`, so a mid-bill policy change cannot reprice an
 * open bill.
 */
export function serviceChargeFor(basis: MoneyInput, rate: MoneyInput): Decimal {
  if (compare(basis, 0) < 0) throw new RangeError('Service-charge basis cannot be negative.');
  if (compare(rate, 0) < 0 || compare(rate, 1) > 0) {
    throw new RangeError('Service-charge rate must be between zero and one.');
  }
  return roundMoney(multiply(basis, rate));
}
