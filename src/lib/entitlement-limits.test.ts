import { describe, expect, it } from 'vitest';

import {
  EntitlementLimitConfigurationError,
  packageEntitlementLimits,
  resolveRequiredEntitlementLimit,
} from './entitlement-limits';

const EXPLICIT = 'sop.templates.max';
const BOOTSTRAPPED = 'restaurant-core.sop.templates.max';

describe('resolveRequiredEntitlementLimit', () => {
  it('reports an absent limit as a configuration fault instead of zero', () => {
    expect(() => resolveRequiredEntitlementLimit({}, EXPLICIT, BOOTSTRAPPED)).toThrow(
      EntitlementLimitConfigurationError
    );
    expect(() => resolveRequiredEntitlementLimit({}, EXPLICIT, BOOTSTRAPPED)).toThrow(EXPLICIT);
  });

  it('preserves a deliberate explicit zero', () => {
    expect(resolveRequiredEntitlementLimit({ [EXPLICIT]: 0 }, EXPLICIT, BOOTSTRAPPED)).toEqual({
      key: EXPLICIT,
      source: 'explicit',
      value: 0,
    });
  });

  it('uses a positive explicit value before the bootstrapped fallback', () => {
    expect(
      resolveRequiredEntitlementLimit(
        { [EXPLICIT]: 25, [BOOTSTRAPPED]: 100 },
        EXPLICIT,
        BOOTSTRAPPED
      )
    ).toMatchObject({ source: 'explicit', value: 25 });
  });

  it('reports the bootstrapped key used for a package default', () => {
    expect(
      resolveRequiredEntitlementLimit({ [BOOTSTRAPPED]: 100 }, EXPLICIT, BOOTSTRAPPED)
    ).toEqual({ key: BOOTSTRAPPED, source: 'bootstrapped', value: 100 });
  });

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid configured value %s',
    (value) => {
      expect(() =>
        resolveRequiredEntitlementLimit({ [EXPLICIT]: value }, EXPLICIT, BOOTSTRAPPED)
      ).toThrow(EntitlementLimitConfigurationError);
    }
  );
});

describe('packageEntitlementLimits', () => {
  it('exposes the bootstrapped source key used by package configuration diagnostics', () => {
    expect(
      packageEntitlementLimits([
        {
          enabled: true,
          limits: { 'sop.templates.max': 25 },
          module: { key: 'restaurant-core' },
        },
      ])
    ).toEqual({ 'restaurant-core.sop.templates.max': 25 });
  });
});
