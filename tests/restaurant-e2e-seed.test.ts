import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const seed = readFileSync(resolve(process.cwd(), 'scripts/seed-restaurant-e2e.ts'), 'utf8');

describe('Restaurant E2E seed restoration guards', () => {
  test('never leaves a fixed fixture upsert with an empty update', () => {
    expect(seed).not.toMatch(/update:\s*\{\s*\}/);
  });

  test.each([
    'organization',
    'organizationDepartment',
    'restaurantBranch',
    'restaurantFloor',
    'restaurantTable',
    'organizationRole',
    'user',
    'restaurantBranchAssignment',
    'restaurantStaffProfile',
    'restaurantOperatorCredential',
    'restaurantKitchenStation',
    'restaurantRegisteredDevice',
    'restaurantDrawerSession',
    'restaurantBrand',
    'restaurantCategory',
    'restaurantProduct',
    'restaurantModifierGroup',
    'restaurantModifierOption',
    'restaurantProductModifierGroup',
    'restaurantUnit',
    'restaurantIngredient',
    'restaurantRecipe',
    'restaurantRecipeVersion',
    'restaurantRecipeLine',
    'restaurantPriceList',
    'restaurantPriceListVersion',
    'restaurantPriceListEntry',
    'restaurantMenu',
    'restaurantMenuSection',
    'restaurantMenuItem',
    'restaurantBranchMenuPublication',
    'restaurantMenuAvailabilityWindow',
    'restaurantStationRoutingRule',
    'restaurantCustomer',
    'loyaltyAccount',
    'restaurantSopTemplate',
    'restaurantSopTemplateVersion',
    'restaurantSopTemplateStep',
    'restaurantSopAssignment',
    'restaurantSopOccurrence',
  ])('restores mutable values when %s already exists', (model) => {
    const upsert = seed.match(
      new RegExp(`tx\\.${model}\\.upsert\\(\\{([\\s\\S]*?)\\n        \\}\\);`)
    );
    expect(upsert?.[1], `${model} upsert`).toMatch(/update: (?:\{|department)/);
    expect(upsert?.[1], `${model} update`).not.toMatch(/update:\s*\{\s*\}/);
  });

  test('does not update the immutable effective loyalty program on rerun', () => {
    expect(seed).toContain('tx.loyaltyProgramVersion.findUnique');
    expect(seed).toContain('tx.loyaltyProgramVersion.create');
    expect(seed).not.toContain('tx.loyaltyProgramVersion.upsert');
  });

  test('creates or verifies the append-only loyalty points entry without mutating it', () => {
    expect(seed).toContain('tx.loyaltyPointsEntry.findUnique');
    expect(seed).toContain('tx.loyaltyPointsEntry.create');
    expect(seed).not.toMatch(/tx\.loyaltyPointsEntry\.(?:upsert|update|delete)/);
  });

  test('retains the named menu, required modifier, and exact matrix total inputs', () => {
    expect(seed).toContain("name: 'Chicken Tikka Bun'");
    expect(seed).toContain("name: 'Spicy'");
    expect(seed).toContain("price: '12.50'");
    expect(seed).toContain("priceDelta: '1.50'");
  });
});
