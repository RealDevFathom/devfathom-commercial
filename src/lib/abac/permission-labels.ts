/**
 * Plain names for permissions shown to owners in the role editor. A permission without an
 * entry is shown by its action name. Labels are display text only and never grant anything.
 */
export const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  // DEV-66: a counter discount, up to the owner's maximum, without a manager's PIN.
  'pharmacy:discount': 'Give discounts without manager approval',
};

/** "Give discounts without manager approval (pharmacy:discount)", or the action itself. */
export function permissionDisplayName(capability: string): string {
  const label = PERMISSION_LABELS[capability];
  return label ? `${label} (${capability})` : capability;
}
