/** Canonical grants are exact colon actions, `*`, or one namespace wildcard.
 * Legacy/malformed grants are ignored, never normalized at authorization time.
 */
const actionPattern = /^[a-z][a-z0-9-]*:[a-zA-Z][a-zA-Z0-9-]*(?![\s\S])/;
const wildcardPattern = /^[a-z][a-z0-9-]*:\*(?![\s\S])/;

const EXACT_GRANT_ACTIONS = new Set([
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
  // Broad grants must never confer high-risk pharmacy actions. Broad denials still
  // match so that an administrator cannot bypass a namespace/user deny by adding an
  // exact allow elsewhere.
  if (effect === 'ALLOW' && EXACT_GRANT_ACTIONS.has(action)) return false;
  if (rule === '*') return true;
  return wildcardPattern.test(rule) && action.startsWith(rule.slice(0, -1));
}
