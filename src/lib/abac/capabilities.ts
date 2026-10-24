/** Canonical grants are exact colon actions, `*`, or one namespace wildcard.
 * Legacy/malformed grants are ignored, never normalized at authorization time.
 */
const actionPattern = /^[a-z][a-z0-9-]*:[a-zA-Z][a-zA-Z0-9-]*(?![\s\S])/;
const wildcardPattern = /^[a-z][a-z0-9-]*:\*(?![\s\S])/;

/** Sensitive pharmacy actions are granted only by their exact name: neither `*` nor
 * `pharmacy:*` matches them (controlled drugs, pharmacist decisions, regulated catalogue).
 */
export const EXACT_GRANT_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'pharmacy:dispense',
  'pharmacy:safety',
  'pharmacy:catalogue-review',
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
