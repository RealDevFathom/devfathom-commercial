export type EntitlementLimitResolution = {
  key: string;
  source: 'explicit' | 'bootstrapped';
  value: number;
};

export class EntitlementLimitConfigurationError extends Error {
  constructor(
    readonly explicitKey: string,
    readonly bootstrappedKey: string
  ) {
    super(
      `Entitlement limit is not configured: expected a non-negative safe integer at "${explicitKey}" or bootstrapped key "${bootstrappedKey}".`
    );
    this.name = 'EntitlementLimitConfigurationError';
  }
}

/**
 * Resolve a required limit without collapsing an absent key into a deliberate zero.
 * Organization-level explicit limits win over package/bootstrap defaults.
 */
export function resolveRequiredEntitlementLimit(
  limits: Readonly<Record<string, number>>,
  explicitKey: string,
  bootstrappedKey: string
): EntitlementLimitResolution {
  const candidates = [
    { key: explicitKey, source: 'explicit' as const },
    { key: bootstrappedKey, source: 'bootstrapped' as const },
  ];

  for (const candidate of candidates) {
    if (!Object.prototype.hasOwnProperty.call(limits, candidate.key)) continue;
    const value = limits[candidate.key];
    if (Number.isSafeInteger(value) && value >= 0) return { ...candidate, value };
    throw new EntitlementLimitConfigurationError(explicitKey, bootstrappedKey);
  }

  throw new EntitlementLimitConfigurationError(explicitKey, bootstrappedKey);
}

/** Build the same module-prefixed package limit view used by entitlement resolution. */
export function packageEntitlementLimits(
  moduleLinks: ReadonlyArray<{
    enabled: boolean;
    limits: unknown;
    module: { key: string };
  }>
): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const link of moduleLinks) {
    if (
      !link.enabled ||
      !link.limits ||
      typeof link.limits !== 'object' ||
      Array.isArray(link.limits)
    ) {
      continue;
    }
    for (const [key, value] of Object.entries(link.limits)) {
      if (typeof value === 'number') limits[`${link.module.key}.${key}`] = value;
    }
  }
  return limits;
}
