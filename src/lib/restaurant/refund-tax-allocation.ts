import { allocate, Decimal } from './money-arithmetic';

/**
 * Split the tax cents owed by one more partial refund across a tender's frozen
 * tax buckets.
 *
 * Only the increment (`cumulativeTotalCents` minus the cents already refunded) is
 * allocated, and it is weighted by each bucket's REMAINING refundable cents. Re-
 * allocating the cumulative total and subtracting prior evidence is not safe:
 * largest-remainder allocation is not monotonic in the total, so a bucket that
 * received a cent earlier can lose it on the next pass and produce a negative
 * delta. Weighting by remaining cents keeps every delta non-negative, never
 * pushes a bucket past its frozen cents, and exhausts every bucket exactly once
 * the cumulative total reaches the tender's frozen tax.
 *
 * Returns `null` when the frozen evidence is inconsistent (prior refunds exceed
 * a bucket, or the requested cumulative total is below what was already
 * refunded or above what was captured).
 */
export function allocateIncrementalTaxRefundCents(
  originalCents: readonly number[],
  alreadyRefundedCents: readonly number[],
  cumulativeTotalCents: number
): number[] | null {
  if (originalCents.length !== alreadyRefundedCents.length) return null;
  const remaining = originalCents.map((cents, index) => cents - alreadyRefundedCents[index]!);
  if (remaining.some((cents) => !Number.isInteger(cents) || cents < 0)) return null;
  const refunded = alreadyRefundedCents.reduce((total, cents) => total + cents, 0);
  const remainingTotal = remaining.reduce((total, cents) => total + cents, 0);
  const incrementCents = cumulativeTotalCents - refunded;
  if (!Number.isInteger(incrementCents) || incrementCents < 0 || incrementCents > remainingTotal) {
    return null;
  }
  if (incrementCents === 0) return remaining.map(() => 0);
  return allocate(new Decimal(incrementCents).div(100), remaining).map((share) =>
    share.mul(100).toNumber()
  );
}
