import { describe, expect, it } from 'vitest';

import { draftCapabilityGranted } from './stock-signals-operations';

describe('draftCapabilityGranted', () => {
  it('denies when an override ALLOW conflicts with a role DENY', () => {
    expect(
      draftCapabilityGranted(
        [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
        [{ capability: 'pharmacy:*', effect: 'DENY' }],
        'pharmacy:procurement'
      )
    ).toBe(false);
  });

  it('allows a sole matching rule and denies when no rule matches', () => {
    expect(
      draftCapabilityGranted(
        [],
        [{ capability: 'pharmacy:inventory', effect: 'ALLOW' }],
        'pharmacy:inventory'
      )
    ).toBe(true);
    expect(draftCapabilityGranted([], [], 'pharmacy:inventory')).toBe(false);
  });
});
