/**
 * DEV-853 — legacy opening stock may arrive with no batch number and/or no
 * expiry. Both are stored as null (never invented) and the stock stays
 * sellable. These helpers keep every screen, receipt and expiry rule on the
 * same plain-words wording and the same "known and passed" test.
 */

export const BATCH_NOT_RECORDED = 'Batch not recorded';
export const EXPIRY_NOT_RECORDED = 'Expiry not recorded';

/** The batch number, or the plain-words "Batch not recorded". */
export function batchNumberLabel(batchNumber: string | null | undefined): string {
  const trimmed = batchNumber?.trim();
  return trimmed ? trimmed : BATCH_NOT_RECORDED;
}

/**
 * True only when the expiry is KNOWN and has passed. An unrecorded expiry is
 * never treated as expired and never blocks a sale.
 */
export function hasKnownExpiryPassed(expiresAt: Date | null | undefined, at: Date): boolean {
  return expiresAt != null && expiresAt.getTime() <= at.getTime();
}

/** Known expiries first (earliest first), then unrecorded ones. */
export function compareKnownExpiryFirst(
  left: Date | null | undefined,
  right: Date | null | undefined
): number {
  if (left == null || right == null) return left == right ? 0 : left == null ? 1 : -1;
  return left.getTime() - right.getTime();
}

/**
 * A `YYYY-MM` value from a month picker as the printed month (UTC first day),
 * or null when it is not a real month. Used with MONTH expiry precision.
 */
export function readExpiryMonth(value: string): Date | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value.trim());
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}
