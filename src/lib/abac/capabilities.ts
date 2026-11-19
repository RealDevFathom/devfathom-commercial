/** Canonical grants are exact colon actions, `*`, or one namespace wildcard.
 * Legacy/malformed grants are ignored, never normalized at authorization time.
 */
const actionPattern = /^[a-z][a-z0-9-]*:[a-zA-Z][a-zA-Z0-9-]*(?![\s\S])/;
const wildcardPattern = /^[a-z][a-z0-9-]*:\*(?![\s\S])/;

/** Sensitive pharmacy actions are granted only by their exact name: neither `*` nor
 * `pharmacy:*` matches them (prescription records, controlled drugs, pharmacist decisions,
 * regulated catalogue, and DEV-66's discount without a manager's approval). Static
 * tenant-admin policies are evaluated separately.
 */
export const EXACT_GRANT_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'pharmacy:dispense',
  'pharmacy:prescriptions',
  'pharmacy:safety',
  'pharmacy:catalogue-review',
  'pharmacy:discount',
]);

export function capabilityMatches(
  rule: string,
  action: string,
  effect: 'ALLOW' | 'DENY' = 'ALLOW'
): boolean {
  if (!actionPattern.test(action)) return false;
  if (actionPattern.test(rule)) return rule === action;
  // Only grants need the exact name; a wildcard DENY still revokes these actions.
  if (effect === 'ALLOW' && EXACT_GRANT_ONLY_ACTIONS.has(action)) return false;
  if (rule === '*') return true;
  return wildcardPattern.test(rule) && action.startsWith(rule.slice(0, -1));
}
