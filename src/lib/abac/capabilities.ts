/** Canonical grants are exact colon actions, `*`, or one namespace wildcard.
 * Legacy/malformed grants are ignored, never normalized at authorization time.
 */
const actionPattern = /^[a-z][a-z0-9-]*:[a-zA-Z][a-zA-Z0-9-]*(?![\s\S])/;
const wildcardPattern = /^[a-z][a-z0-9-]*:\*(?![\s\S])/;

export function capabilityMatches(rule: string, action: string): boolean {
  if (!actionPattern.test(action)) return false;
  if (rule === '*') return true;
  if (actionPattern.test(rule)) return rule === action;
  return wildcardPattern.test(rule) && action.startsWith(rule.slice(0, -1));
}
