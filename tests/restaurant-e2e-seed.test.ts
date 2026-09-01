import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const seed = readFileSync(resolve(process.cwd(), 'scripts/seed-restaurant-e2e.ts'), 'utf8');
const runner = readFileSync(resolve(process.cwd(), 'scripts/run-restaurant-e2e.ts'), 'utf8');
const demoSeed = readFileSync(resolve(process.cwd(), 'scripts/seed-restaurant-demo.ts'), 'utf8');

describe('Restaurant E2E seed restoration guards', () => {
  test('never leaves a fixed fixture upsert with an empty update', () => {
    expect(seed).not.toMatch(/update:\s*\{\s*\}/);
  });

  test.each([
    'organization',
    'organizationLimit',
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

  test('derives the immutable Delivery tax fixture date from the fixed fixture instant', () => {
    expect(seed).toMatch(
      /const FIXED_DELIVERY_TAX_BUSINESS_DATE = businessDateToUtcDate\(\s*resolveBusinessDate\(FIXED_AT, 'Asia\/Karachi', '00:00'\)\s*\)/
    );

    const taxFixture = seed.slice(
      seed.indexOf('async function seedDeliveryTaxProfile'),
      seed.indexOf('async function main()')
    );
    expect(taxFixture).toContain('FIXED_DELIVERY_TAX_BUSINESS_DATE');
    expect(taxFixture).not.toContain('CURRENT_BUSINESS_DATE');
    expect(taxFixture).not.toMatch(/new Date\s*\(/);
  });

  test('retains the named menu, required modifier, and exact matrix total inputs', () => {
    expect(seed).toContain("name: 'Chicken Tikka Bun'");
    expect(seed).toContain("name: 'Spicy'");
    expect(seed).toContain("price: '12.50'");
    expect(seed).toContain("priceDelta: '1.50'");
  });

  test('seeds the restricted operator app password only from the explicit E2E credential', () => {
    expect(seed).toContain(
      'const operatorPassword = process.env.RESTAURANT_ACTOR_OPERATOR_PASSWORD;'
    );
    expect(seed).toContain('hashSync(operatorPassword, PIN_BCRYPT_SALT)');
    expect(seed).toMatch(/const operatorPasswordHash = operatorPassword[\s\S]*?: null;/);
    expect(seed).toContain('password: operatorPasswordHash');
    expect(seed).toContain("key: 'restaurant-e2e-operator'");
    expect(seed).toContain(
      'verification.operator.restaurantBranchAssignments[0]?.branchId !== RESTAURANT_E2E.branchId'
    );
    expect(seed).not.toContain('console.log(operatorPassword');
  });

  test('two consecutive standard seeds keep restaurant-pos enabled', () => {
    const organization = seed.indexOf('await tx.organization.upsert({');
    const controlPlane = seed.indexOf('await seedRestaurantDemoControlPlane(tx);');
    const tenantTransaction = seed.indexOf("set_config('app.current_organization_id', $1");
    const showcaseGuard = seed.indexOf("process.env.RESTAURANT_DEMO_SEED === '1'");

    expect(organization).toBeGreaterThan(-1);
    expect(controlPlane).toBeGreaterThan(organization);
    expect(controlPlane).toBeLessThan(tenantTransaction);
    expect(controlPlane).toBeLessThan(showcaseGuard);
    expect(seed.match(/seedRestaurantDemoControlPlane\(tx\)/g)).toHaveLength(1);
    expect(runner.match(/'scripts\/seed-restaurant-e2e\.ts'/g)).toHaveLength(2);
    expect(demoSeed).toMatch(
      /for \(const module of RESTAURANT_MODULE_ROWS\)[\s\S]*?platformPackageModule\.upsert\([\s\S]*?update: \{ enabled: true \}/
    );
    expect(demoSeed).toContain("key: 'restaurant-pos'");
  });

  test('keeps the two seeded branches at the restaurant location limit', () => {
    expect(seed).toContain("locationsLimit: 'limit_restaurant_e2e_locations'");
    expect(seed).toContain("['organization_limits', [IDS.locationsLimit]]");
    expect(seed).toContain("key: 'restaurant.locations.max'");
    expect(seed).toMatch(
      /tx\.organizationLimit\.upsert\([\s\S]*?update: \{[\s\S]*?value: 2,[\s\S]*?source: 'E2E_FIXTURE',[\s\S]*?createdAt: FIXED_AT,[\s\S]*?updatedAt: FIXED_AT,[\s\S]*?create: \{[\s\S]*?id: IDS\.locationsLimit,[\s\S]*?value: 2,[\s\S]*?source: 'E2E_FIXTURE'/
    );
  });
});
