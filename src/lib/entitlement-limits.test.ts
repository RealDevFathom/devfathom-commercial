import { describe, expect, it } from 'vitest';

import { resolveEntitlementLimit, SOP_TEMPLATES_LIMIT } from './entitlement-limits';

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

  it('reports a truly missing limit', () => {
    expect(resolveEntitlementLimit({}, SOP_TEMPLATES_LIMIT)).toEqual({
      status: 'missing',
      explicitKey: 'sop.templates.max',
      bootstrappedKey: 'restaurant-core.sop.templates.max',
    });
  });
});
