import { describe, expect, it } from 'vitest';
import { holdsDispenseCapability } from './dispense-capability';

const grant = (capability: string, effect = 'ALLOW') => ({
  organizationRole: { permissions: [{ capability, effect }] },
});

describe('holdsDispenseCapability', () => {
  it('accepts a pharmacist grant in either spelling and a wildcard', () => {
    expect(holdsDispenseCapability(grant('pharmacy.dispense'))).toBe(true);
    expect(holdsDispenseCapability(grant('pharmacy:dispense'))).toBe(true);
    expect(holdsDispenseCapability(grant('pharmacy.*'))).toBe(true);
    expect(holdsDispenseCapability(grant('pharmacy:*'))).toBe(true);
    expect(holdsDispenseCapability(grant('*'))).toBe(true);
  });

  it('denies a cashier and lets a deny override win', () => {
    expect(
      holdsDispenseCapability({
        organizationRole: {
          permissions: [
            { capability: 'pharmacy.counter', effect: 'ALLOW' },
            { capability: 'pharmacy:orders', effect: 'ALLOW' },
          ],
        },
      })
    ).toBe(false);
    expect(
      holdsDispenseCapability({
        organizationRole: { permissions: [{ capability: 'pharmacy.*', effect: 'ALLOW' }] },
        permissionOverrides: [{ capability: 'pharmacy.dispense', effect: 'DENY' }],
      })
    ).toBe(false);
  });
});
