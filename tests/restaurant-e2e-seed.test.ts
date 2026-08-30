import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const seed = readFileSync(resolve(process.cwd(), 'scripts/seed-restaurant-e2e.ts'), 'utf8');

describe('Restaurant E2E seed restoration guards', () => {
  test('never leaves a fixed fixture upsert with an empty update', () => {
    expect(seed).not.toMatch(/update:\s*\{\s*\}/);
  });

  test.each([
    'restaurantStaffProfile',
    'restaurantOperatorCredential',
    'restaurantRegisteredDevice',
    'restaurantPriceListVersion',
    'restaurantPriceListEntry',
    'restaurantMenuSection',
    'restaurantMenuItem',
    'restaurantBranchMenuPublication',
    'restaurantMenuAvailabilityWindow',
    'restaurantStationRoutingRule',
    'restaurantCustomer',
    'loyaltyProgramVersion',
    'loyaltyAccount',
    'loyaltyPointsEntry',
  ])('restores mutable values when %s already exists', (model) => {
    const upsert = seed.match(
      new RegExp(`tx\\.${model}\\.upsert\\(\\{([\\s\\S]*?)\\n        \\}\\);`)
    );
    expect(upsert?.[1], `${model} upsert`).toContain('update: {');
    expect(upsert?.[1], `${model} update`).not.toMatch(/update:\s*\{\s*\}/);
  });

  test('retains the named menu, required modifier, and exact matrix total inputs', () => {
    expect(seed).toContain("name: 'Chicken Tikka Bun'");
    expect(seed).toContain("name: 'Spicy'");
    expect(seed).toContain("price: '12.50'");
    expect(seed).toContain("priceDelta: '1.50'");
  });
});
