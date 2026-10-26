import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Real PostgreSQL regression coverage for reciprocal graph writes. */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const id = (label: string) => `${label}_${suffix}`;
const organizationId = id('recipe_graph_org');
const setup = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;

type Dependencies = {
  createTenantDb: typeof import('@/lib/tenancy/scoped-db').createTenantDb;
  createRecipeLine: typeof import('@/lib/restaurant/recipes').createRecipeLine;
  upsertConversion: typeof import('@/lib/restaurant/recipes').upsertConversion;
};

let dependencies: Dependencies;

describeIfDatabase('restaurant dependency graph concurrency (real PostgreSQL)', () => {
  beforeAll(async () => {
    await setup!.connect();
    dependencies = {
      ...(await import('@/lib/tenancy/scoped-db')),
      ...(await import('@/lib/restaurant/recipes')),
    };

    await setup!.query(
      `INSERT INTO "organizations" (
         "id", "slug", "legalName", "displayName", "status", "deploymentMode", "updatedAt"
       ) VALUES ($1, $2, 'Recipe graph race', 'Recipe graph race', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP)`,
      [organizationId, id('recipe-graph-race')]
    );
    await setup!.query(
      `INSERT INTO "restaurant_units" ("id", "organizationId", "name", "updatedAt") VALUES
         ($1, $3, 'unit A', CURRENT_TIMESTAMP), ($2, $3, 'unit B', CURRENT_TIMESTAMP)`,
      [id('unit_a'), id('unit_b'), organizationId]
    );
    await setup!.query(
      `INSERT INTO "restaurant_products" ("id", "organizationId", "name", "updatedAt") VALUES
         ($1, $3, 'product A', CURRENT_TIMESTAMP), ($2, $3, 'product B', CURRENT_TIMESTAMP)`,
      [id('product_a'), id('product_b'), organizationId]
    );
    await setup!.query(
      `INSERT INTO "restaurant_recipes" (
         "id", "organizationId", "productId", "name", "updatedAt"
       ) VALUES ($1, $5, $3, 'recipe A', CURRENT_TIMESTAMP),
                ($2, $5, $4, 'recipe B', CURRENT_TIMESTAMP)`,
      [id('recipe_a'), id('recipe_b'), id('product_a'), id('product_b'), organizationId]
    );
    await setup!.query(
      `INSERT INTO "restaurant_recipe_versions" (
         "id", "organizationId", "recipeId", "versionNumber", "updatedAt"
       ) VALUES ($1, $5, $3, 1, CURRENT_TIMESTAMP),
                ($2, $5, $4, 1, CURRENT_TIMESTAMP)`,
      [id('version_a'), id('version_b'), id('recipe_a'), id('recipe_b'), organizationId]
    );
  }, 60_000);

  afterAll(async () => {
    await setup?.query(`DELETE FROM "organizations" WHERE "id" = $1`, [organizationId]);
    await setup?.end();
  });

  it('commits exactly one of two reciprocal unit conversions', async () => {
    const first = dependencies.createTenantDb(organizationId);
    const second = dependencies.createTenantDb(organizationId);
    const results = await Promise.allSettled([
      dependencies.upsertConversion(first, id('unit_a'), id('unit_b'), '2'),
      dependencies.upsertConversion(second, id('unit_b'), id('unit_a'), '0.5'),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { reason: 'CONVERSION_CYCLE' },
    });
    const persisted = await setup!.query<{ fromUnitId: string; toUnitId: string }>(
      `SELECT "fromUnitId", "toUnitId" FROM "restaurant_unit_conversions"
       WHERE "organizationId" = $1`,
      [organizationId]
    );
    expect(persisted.rows).toHaveLength(1);
    expect([
      { fromUnitId: id('unit_a'), toUnitId: id('unit_b') },
      { fromUnitId: id('unit_b'), toUnitId: id('unit_a') },
    ]).toContainEqual(persisted.rows[0]);
  });

  it('commits exactly one of two reciprocal sub-recipe lines', async () => {
    const first = dependencies.createTenantDb(organizationId);
    const second = dependencies.createTenantDb(organizationId);
    const results = await Promise.allSettled([
      dependencies.createRecipeLine(first, {
        recipeVersionId: id('version_a'),
        subRecipeId: id('recipe_b'),
        quantity: '1',
        unitId: id('unit_a'),
      }),
      dependencies.createRecipeLine(second, {
        recipeVersionId: id('version_b'),
        subRecipeId: id('recipe_a'),
        quantity: '1',
        unitId: id('unit_a'),
      }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { reason: 'RECIPE_CYCLE' },
    });
    const persisted = await setup!.query<{ recipeId: string; subRecipeId: string }>(
      `SELECT version."recipeId", line."subRecipeId"
         FROM "restaurant_recipe_lines" line
         JOIN "restaurant_recipe_versions" version ON version."id" = line."recipeVersionId"
        WHERE line."organizationId" = $1`,
      [organizationId]
    );
    expect(persisted.rows).toHaveLength(1);
    expect([
      { recipeId: id('recipe_a'), subRecipeId: id('recipe_b') },
      { recipeId: id('recipe_b'), subRecipeId: id('recipe_a') },
    ]).toContainEqual(persisted.rows[0]);
  });
});
