/**
 * SEC (PR #195 follow-up): cap on a pharmacist's SELF-authorized Rx/restricted
 * overrides.
 *
 * The prescription gate (`rx-gate.ts`) lets a pharmacist who holds
 * `pharmacy:dispense` wave a regulated line through with just a typed reason —
 * a "self-override". On its own that authority is unbounded: one pharmacist can
 * self-approve any number of overrides, for any value, with no second pair of
 * eyes. This module bounds that authority with a server-enforced, configurable,
 * per-pharmacist rolling-window cap (count AND dispensed value). Beyond the cap
 * a second pharmacist must co-sign with their own PIN (dual control).
 *
 * The cap applies ONLY to self-overrides. An override co-signed by an
 * independent pharmacist (`verifyPharmacistPin`, which rejects the acting user's
 * own PIN) is the escape hatch and is never counted here.
 */
import type { LedgerScope } from './stock-ledger';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Rolling window the self-override cap is measured over: one day. */
export const RX_SELF_OVERRIDE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `OrganizationLimit` keys that override the defaults (server-side, per org). */
export const RX_SELF_OVERRIDE_MAX_COUNT_KEY = 'pharmacy_rx_self_override_max_per_day';
export const RX_SELF_OVERRIDE_MAX_VALUE_MINOR_KEY =
  'pharmacy_rx_self_override_max_value_minor_per_day';

/** Conservative defaults used when no org limit row is configured. */
export const DEFAULT_RX_SELF_OVERRIDE_MAX_COUNT = 10;
export const DEFAULT_RX_SELF_OVERRIDE_MAX_VALUE_MINOR = 5_000_000;

export type RxSelfOverrideLimits = { maxCount: number; maxValueMinor: number };

/** The net (post-discount) value a dispensed sale line carries, clamped to >= 0. */
export function saleLineNetMinor(line: {
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
}): number {
  return Math.max(0, line.quantity * line.unitPriceMinor - line.discountMinor);
}

/**
 * Thrown from inside the sale transaction when a self-override breaches the
 * value cap; the line has already been inserted, so throwing rolls the whole
 * transaction back. The router catches it and turns it into a `{ blocked }`
 * refusal rather than a 500.
 */
export class PharmacyRxOverrideCapError extends Error {
  readonly reason = 'RX_OVERRIDE_CAP' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PharmacyRxOverrideCapError';
  }
}

/**
 * Null when the self-override is within the pharmacist's cap. Otherwise the
 * sentence the counter shows, telling them a second pharmacist must co-sign.
 *
 * `priorCount` / `priorValueMinor` describe the pharmacist's OTHER self-overrides
 * in the window (excluding the line being dispensed); `thisValueMinor` is the
 * value of the line being dispensed now.
 */
export function rxSelfOverrideDecision(input: {
  priorCount: number;
  priorValueMinor: number;
  thisValueMinor: number;
  limits: RxSelfOverrideLimits;
}): string | null {
  const { maxCount, maxValueMinor } = input.limits;
  if (input.priorCount >= maxCount) {
    return `A pharmacist may self-authorize ${maxCount} prescription override${
      maxCount === 1 ? '' : 's'
    } per day. A second pharmacist must co-sign with their PIN to dispense more.`;
  }
  if (input.priorValueMinor + input.thisValueMinor > maxValueMinor) {
    return 'This pharmacist has reached the daily value limit for self-authorized overrides. A second pharmacist must co-sign with their PIN to dispense more.';
  }
  return null;
}

/**
 * Reads the configurable per-org self-override limits, falling back to the
 * conservative defaults (fails closed: a missing or RLS-hidden row still caps).
 */
export async function rxSelfOverrideLimits(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId'>,
  now: Date
): Promise<RxSelfOverrideLimits> {
  const rows = await db.organizationLimit.findMany({
    where: {
      organizationId: scope.organizationId,
      key: { in: [RX_SELF_OVERRIDE_MAX_COUNT_KEY, RX_SELF_OVERRIDE_MAX_VALUE_MINOR_KEY] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const configuredCount = byKey.get(RX_SELF_OVERRIDE_MAX_COUNT_KEY);
  const configuredValue = byKey.get(RX_SELF_OVERRIDE_MAX_VALUE_MINOR_KEY);
  return {
    maxCount:
      configuredCount !== undefined && configuredCount >= 0
        ? configuredCount
        : DEFAULT_RX_SELF_OVERRIDE_MAX_COUNT,
    maxValueMinor:
      configuredValue !== undefined && configuredValue >= 0
        ? configuredValue
        : DEFAULT_RX_SELF_OVERRIDE_MAX_VALUE_MINOR,
  };
}
