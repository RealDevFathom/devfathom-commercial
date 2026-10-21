import { describe, expect, it } from 'vitest';

import {
  resolveEntitlementLimit,
  RESTAURANT_COMMERCIAL_LIMITS,
  SOP_TEMPLATES_LIMIT,
} from './entitlement-limits';

describe('resolveEntitlementLimit', () => {
  it('resolves a direct explicit value', () => {
    expect(resolveEntitlementLimit({ 'sop.templates.max': 25 }, SOP_TEMPLATES_LIMIT)).toMatchObject(
      { status: 'configured', source: 'explicit', value: 25 }
    );
  });

  it('resolves a bootstrapped package value', () => {
    expect(
      resolveEntitlementLimit({ 'restaurant-core.sop.templates.max': 10 }, SOP_TEMPLATES_LIMIT)
    ).toMatchObject({ status: 'configured', source: 'bootstrapped', value: 10 });
  });

  it('preserves an explicit zero', () => {
    expect(resolveEntitlementLimit({ 'sop.templates.max': 0 }, SOP_TEMPLATES_LIMIT)).toMatchObject({
      status: 'configured',
      source: 'explicit',
      value: 0,
    });
  });

  it('prefers a positive explicit value over the bootstrapped value', () => {
    expect(
      resolveEntitlementLimit(
        { 'sop.templates.max': 25, 'restaurant-core.sop.templates.max': 10 },
        SOP_TEMPLATES_LIMIT
      )
    ).toMatchObject({ status: 'configured', source: 'explicit', value: 25 });
  });

  it.each(RESTAURANT_COMMERCIAL_LIMITS)(
    'resolves explicit and restaurant-core alias forms for $explicitKey',
    (definition) => {
      expect(resolveEntitlementLimit({ [definition.explicitKey]: 7 }, definition)).toEqual({
        status: 'configured',
        key: definition.explicitKey,
        source: 'explicit',
        value: 7,
      });
      expect(resolveEntitlementLimit({ [definition.bootstrappedKey]: 6 }, definition)).toEqual({
        status: 'configured',
        key: definition.bootstrappedKey,
        source: 'bootstrapped',
        value: 6,
      });
      expect(
        resolveEntitlementLimit(
          { [definition.explicitKey]: 0, [definition.bootstrappedKey]: 6 },
          definition
        )
      ).toMatchObject({ status: 'configured', source: 'explicit', value: 0 });
    }
  );

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['non-finite', Number.NaN],
    ['non-finite', Number.POSITIVE_INFINITY],
  ] as const)('fails closed with a stable %s diagnostic', (invalidReason, value) => {
    expect(
      resolveEntitlementLimit(
        {
          [SOP_TEMPLATES_LIMIT.explicitKey]: value,
          [SOP_TEMPLATES_LIMIT.bootstrappedKey]: 10,
        },
        SOP_TEMPLATES_LIMIT
      )
    ).toEqual({
      status: 'missing',
      explicitKey: SOP_TEMPLATES_LIMIT.explicitKey,
      bootstrappedKey: SOP_TEMPLATES_LIMIT.bootstrappedKey,
      invalidKey: SOP_TEMPLATES_LIMIT.explicitKey,
      invalidReason,
    });
  });

  it('reports a truly missing limit', () => {
    expect(resolveEntitlementLimit({}, SOP_TEMPLATES_LIMIT)).toEqual({
      status: 'missing',
      explicitKey: 'sop.templates.max',
      bootstrappedKey: 'restaurant-core.sop.templates.max',
    });
  });
});
