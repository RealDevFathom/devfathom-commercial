const DISPENSE_ACTIONS = ['pharmacy:dispense', 'pharmacy.dispense'] as const;

function grantCoversDispense(rule: string) {
  if (rule === '*') return true;
  return DISPENSE_ACTIONS.some((action) => {
    if (rule === action) return true;
    if (rule.endsWith(':*') && action.startsWith(rule.slice(0, -1))) return true;
    if (rule.endsWith('.*') && action.startsWith(rule.slice(0, -1))) return true;
    return false;
  });
}

type DispenseGrant = { capability: string; effect: string };

/** True when an override or role grant allows dispensing. A deny wins. */
export function holdsDispenseCapability(user: {
  organizationRole?: { permissions: readonly DispenseGrant[] } | null;
  permissionOverrides?: readonly DispenseGrant[] | null;
}) {
  const overrides = (user.permissionOverrides ?? []).filter((rule) =>
    grantCoversDispense(rule.capability)
  );
  if (overrides.some((rule) => rule.effect === 'DENY')) return false;
  if (overrides.some((rule) => rule.effect === 'ALLOW')) return true;
  const role = (user.organizationRole?.permissions ?? []).filter((rule) =>
    grantCoversDispense(rule.capability)
  );
  if (role.some((rule) => rule.effect === 'DENY')) return false;
  return role.some((rule) => rule.effect === 'ALLOW');
}
