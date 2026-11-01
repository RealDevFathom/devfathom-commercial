import { describe, expect, it } from 'vitest';

import { procurementCapabilityGranted } from './procurement-access';

describe('procurementCapabilityGranted', () => {
  it('allows the procurement capability and refuses a cashier', () => {
    expect(
      procurementCapabilityGranted({
        overrides: [],
        role: [{ capability: 'pharmacy.procurement', effect: 'ALLOW' }],
      })
    ).toBe(true);
    expect(
      procurementCapabilityGranted({
        overrides: [],
        role: [
          { capability: 'pharmacy.counter', effect: 'ALLOW' },
          { capability: 'pharmacy:orders', effect: 'ALLOW' },
        ],
      })
    ).toBe(false);
  });

  it('lets a pharmacy wildcard through and lets DENY win', () => {
    expect(
      procurementCapabilityGranted({
        overrides: [],
        role: [{ capability: 'pharmacy.*', effect: 'ALLOW' }],
      })
    ).toBe(true);
    expect(
      procurementCapabilityGranted({
        overrides: [{ capability: 'pharmacy.procurement', effect: 'DENY' }],
        role: [{ capability: 'pharmacy.*', effect: 'ALLOW' }],
      })
    ).toBe(false);
  });

  it('does not let an override ALLOW bypass a role DENY', () => {
    expect(
      procurementCapabilityGranted({
        overrides: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
        role: [{ capability: 'pharmacy:*', effect: 'DENY' }],
      })
    ).toBe(false);
  });
});

it('never lets an override ALLOW outrun a role DENY on either procurement alias', () => {
  expect(
    procurementCapabilityGranted({
      overrides: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
      role: [{ capability: 'pharmacy.procurement', effect: 'DENY' }],
    })
  ).toBe(false);
});
