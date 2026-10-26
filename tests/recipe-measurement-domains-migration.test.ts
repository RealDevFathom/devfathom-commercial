import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20261026000000_recipe_measurement_domains/migration.sql'
  ),
  'utf8'
);

describe('recipe measurement domain migration', () => {
  it.each([
    ['restaurant_unit_conversions_factor_positive_ck', 'CHECK ("factor" > 0)'],
    [
      'restaurant_recipe_versions_yield_quantity_positive_ck',
      'CHECK ("yieldQuantity" IS NULL OR "yieldQuantity" > 0)',
    ],
    ['restaurant_recipe_lines_quantity_positive_ck', 'CHECK ("quantity" > 0)'],
    [
      'restaurant_ingredients_reference_cost_nonnegative_ck',
      'CHECK ("referenceCost" IS NULL OR "referenceCost" >= 0)',
    ],
  ])('enforces %s', (constraint, check) => {
    expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    expect(migration).toContain(check);
  });
});
