import type { Action } from '@/lib/abac/policies';

/**
 * DEV-961 — the approver rights of the shared approval path.
 *
 * Every approval that takes a person's PIN or authenticator code goes through
 * `verifyApprovalSecret` and names, as `approverRight`, the right its own permission check
 * required of the approver (the same constant it passes to `can()` or to the restaurant
 * capability check). The shared path refuses any right that is not listed here, so a new
 * approval route cannot work until its approver right is added, and the forced
 * authenticator set-up (`approvalAuthenticatorGate`) asks exactly the members who hold one
 * of these rights. Nothing here names a role.
 *
 *  - pharmacy: `pharmacy:manage` (refunds, discounts, Khata over-limit, tender discard,
 *    scanned-pack FEFO), `pharmacy:dispense` (FEFO override, pharmacist checks, witnesses,
 *    goods receipt, controlled restoration, refill cycles), `pharmacy:procurement-approve`
 *    (purchase approval) and `OWNER`, the owner-only PIN checks (owner data export, the
 *    sole-owner report and marketing self-approvals);
 *  - restaurant: `coauth:approve` (terminal and back-office co-authorization, voids,
 *    cancellations, refunds, bills, day corrections, device and camera revocation) and
 *    `sop:verify` (SOP waivers).
 */
export const PHARMACY_APPROVER_RIGHTS = [
  'pharmacy:manage',
  'pharmacy:dispense',
  'pharmacy:procurement-approve',
  'OWNER',
] as const satisfies readonly (Action | 'OWNER')[];

/** Restaurant staff capabilities (resolved by `operatorHasCapability`), not ABAC actions. */
export const RESTAURANT_APPROVER_RIGHTS = ['coauth:approve', 'sop:verify'] as const;

export type PharmacyApproverRight = (typeof PHARMACY_APPROVER_RIGHTS)[number];
export type RestaurantApproverRight = (typeof RESTAURANT_APPROVER_RIGHTS)[number];
export type ApprovalApproverRight = PharmacyApproverRight | RestaurantApproverRight;

// Which rights apply in which vertical lives in src/lib/vertical-catalog.ts
// (APPROVAL_APPROVER_RIGHTS_BY_VERTICAL), the one place verticals are named.

const ALL_RIGHTS: ReadonlySet<string> = new Set([
  ...PHARMACY_APPROVER_RIGHTS,
  ...RESTAURANT_APPROVER_RIGHTS,
]);

export function isApprovalApproverRight(value: unknown): value is ApprovalApproverRight {
  return typeof value === 'string' && ALL_RIGHTS.has(value);
}

export function isRestaurantApproverRight(value: unknown): value is RestaurantApproverRight {
  return (
    typeof value === 'string' && (RESTAURANT_APPROVER_RIGHTS as readonly string[]).includes(value)
  );
}
