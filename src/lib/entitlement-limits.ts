export type EntitlementLimitDefinition = {
  label: string;
  explicitKey: string;
  bootstrappedKey: string;
};

export type EntitlementLimitResolution =
  | { status: 'configured'; key: string; source: 'explicit' | 'bootstrapped'; value: number }
  | { status: 'missing'; explicitKey: string; bootstrappedKey: string };

export const SOP_TEMPLATES_LIMIT = {
  label: 'SOP template limit',
  explicitKey: 'sop.templates.max',
  bootstrappedKey: 'restaurant-core.sop.templates.max',
} as const satisfies EntitlementLimitDefinition;

export function resolveEntitlementLimit(
  limits: Readonly<Record<string, number>>,
  definition: EntitlementLimitDefinition
): EntitlementLimitResolution {
  const explicit = limits[definition.explicitKey];
  if (Number.isSafeInteger(explicit) && explicit! >= 0) {
    return {
      status: 'configured',
      key: definition.explicitKey,
      source: 'explicit',
      value: explicit!,
    };
  }

  const bootstrapped = limits[definition.bootstrappedKey];
  if (Number.isSafeInteger(bootstrapped) && bootstrapped! >= 0) {
    return {
      status: 'configured',
      key: definition.bootstrappedKey,
      source: 'bootstrapped',
      value: bootstrapped!,
    };
  }

  return {
    status: 'missing',
    explicitKey: definition.explicitKey,
    bootstrappedKey: definition.bootstrappedKey,
  };
}
