import { describe, expect, it } from 'vitest';
import { isPathModuleEnabled } from './app-shell';

describe('AppShell module guard', () => {
  it('uses restaurant route ownership for direct routes', () => {
    const entitlements = {
      vertical: 'RESTAURANT' as const,
      enabledModules: ['restaurant-core', 'restaurant-inventory'],
    };
    expect(isPathModuleEnabled('/dashboard', entitlements)).toBe(true);
    expect(isPathModuleEnabled('/restaurant/inventory/items', entitlements)).toBe(true);
    expect(isPathModuleEnabled('/restaurant/orders', entitlements)).toBe(false);
  });
});
