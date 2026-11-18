/** DEV-881: the audit policy for a manager's PIN-approved points adjustment. */
export const LOYALTY_ADJUST_PIN_POLICY = 'PHARMACY_LOYALTY_ADJUST_MANAGER_PIN';
export const LOYALTY_ADJUST_PIN_BLOCKED = 'Adjustment not recorded. Enter your manager PIN.';
export const loyaltyAdjustLimitMessage = (limit: number) =>
  `Adjustments above ${limit.toLocaleString('en-PK')} points need the owner.`;
export const loyaltyAdjustDailyLimitMessage = (limit: number) =>
  `A manager can adjust up to ${limit.toLocaleString('en-PK')} points for a customer in one day. Larger totals need the owner.`;

/** Refusals the adjustment form shows as written, instead of the generic access message. */
export function isExplainedAdjustRefusal(message: string): boolean {
  return (
    message === LOYALTY_ADJUST_PIN_BLOCKED ||
    /^(Adjustments above|A manager can adjust up to) [\d,]+ points/.test(message)
  );
}
