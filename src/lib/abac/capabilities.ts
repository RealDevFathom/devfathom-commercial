/** Canonical grants are exact colon actions, `*`, or one namespace wildcard.
 * Malformed grants are ignored, never normalized at authorization time. The only
 * legacy names honored are the exact aliases in `LEGACY_CAPABILITIES` below, which
 * map 1:1 to their canonical colon action (mirroring the canonical-pharmacy
 * migration). Dotted wildcards such as `pharmacy.*` are never expanded here.
 */
const actionPattern = /^[a-z][a-z0-9-]*:[a-zA-Z][a-zA-Z0-9-]*(?![\s\S])/;
const wildcardPattern = /^[a-z][a-z0-9-]*:\*(?![\s\S])/;

/** Legacy dotted capabilities map to a canonical colon action by exact match only. */
const LEGACY_CAPABILITIES: Record<string, string> = {
  'pharmacy.procurement': 'pharmacy:procurement',
  'pharmacy.dispense': 'pharmacy:dispense',
};

/** Clinical actions are opt-in (Security): granted only by an exact grant, never by
 * `*` or a `pharmacy:*` wildcard. Broad denials still restrict them, so the opt-in
 * guard applies only when a grant is being evaluated as an ALLOW. */
const CLINICAL_ACTIONS = new Set(['pharmacy:dispense', 'pharmacy:safety', 'pharmacy:catalogue-review']);

export function capabilityMatches(
  rule: string,
  action: string,
  effect?: 'ALLOW' | 'DENY'
): boolean {
  if (!actionPattern.test(action)) return false;
  rule = LEGACY_CAPABILITIES[rule] ?? rule;
  if (rule === action) return true;
  // Clinical access is opt-in: an ALLOW wildcard never grants it, but a broad DENY
  // still restricts it (so a `*` or `pharmacy:*` DENY continues to match).
  if (effect === 'ALLOW' && CLINICAL_ACTIONS.has(action)) return false;
  if (rule === '*') return true;
  return wildcardPattern.test(rule) && action.startsWith(rule.slice(0, -1));
}
