import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activateRecipeVersion,
  addRecipeLineSubstitute,
  createRecipeLine,
  deleteRecipeLine,
  removeRecipeLineSubstitute,
  updateRecipeLine,
  updateRecipeVersion,
} from '@/lib/restaurant/recipes';
import { VersionImmutabilityError } from '@/lib/restaurant/effective-dating';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * Real PostgreSQL proof for C3's read/activate/write race. The URL must point at
 * a migrated, disposable database. Each writer is stopped after its scope read
 * but before its FOR UPDATE; activation then holds that same row lock while the
 * writer is released. This proves the writer actually waits and re-reads ACTIVE.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDatabase = DATABASE_URL ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const id = (label: string) => `${label}_${suffix}`;
const organizationId = id('recipe_race_org');
const unitId = id('recipe_race_unit');
const productId = id('recipe_race_product');
const ingredientId = id('recipe_race_ingredient');
const substituteIngredientId = id('recipe_race_substitute');
const alternateIngredientId = id('recipe_race_alternate');
const setup = DATABASE_URL ? new pg.Client({ connectionString: DATABASE_URL }) : null;

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function pausedWriter(db: ScopedDb, ready: Gate, release: Gate): ScopedDb {
  let rawQueries = 0;
  let proxy: ScopedDb;
  proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (run: (tx: ScopedDb) => Promise<unknown>) => run(proxy);
      }
      if (property === '$queryRaw') {
        return async (...args: unknown[]) => {
          rawQueries += 1;
          // The first raw query reads the tenant scope. The second is the
          // version-row lock, so stop immediately before PostgreSQL executes it.
          if (rawQueries === 2) {
            ready.open();
            await release.promise;
          }
          return (target.$queryRaw as (...values: unknown[]) => Promise<unknown>)(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return proxy;
}

function pausedActivation(db: ScopedDb, updated: Gate, release: Gate): ScopedDb {
  let proxy: ScopedDb;
  const versions = new Proxy(db.restaurantRecipeVersion, {
    get(target, property, receiver) {
      if (property !== 'update') return Reflect.get(target, property, receiver);
      return async (args: { data: { status?: string } }) => {
        const result = await target.update(args as never);
        if (args.data.status === 'ACTIVE') {
          updated.open();
          await release.promise;
        }
        return result;
      };
    },
  });
  proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return async (run: (tx: ScopedDb) => Promise<unknown>) => run(proxy);
      }
      if (property === 'restaurantRecipeVersion') return versions;
      return Reflect.get(target, property, receiver);
    },
  });
  return proxy;
}

async function fixture(caseName: string) {
  const recipeId = id(`recipe_${caseName}`);
  const versionId = id(`version_${caseName}`);
  const lineId = id(`line_${caseName}`);
  const substituteId = id(`line_substitute_${caseName}`);
  await setup!.query(
    `INSERT INTO restaurant_recipes (id, "organizationId", "productId", name, "updatedAt")
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
    [recipeId, organizationId, productId, caseName]
  );
  await setup!.query(
    `INSERT INTO restaurant_recipe_versions
       (id, "organizationId", "recipeId", "versionNumber", status, notes, "updatedAt")
       VALUES ($1, $2, $3, 1, 'DRAFT', 'before', CURRENT_TIMESTAMP)`,
    [versionId, organizationId, recipeId]
  );
  await setup!.query(
    `INSERT INTO restaurant_recipe_lines
       (id, "organizationId", "recipeVersionId", "ingredientId", quantity, "unitId", "sortOrder", "updatedAt")
       VALUES ($1, $2, $3, $4, 1, $5, 0, CURRENT_TIMESTAMP)`,
    [lineId, organizationId, versionId, ingredientId, unitId]
  );
  await setup!.query(
    `INSERT INTO restaurant_recipe_line_substitutes
       (id, "organizationId", "recipeLineId", "substituteIngredientId")
       VALUES ($1, $2, $3, $4)`,
    [substituteId, organizationId, lineId, substituteIngredientId]
  );
  return { recipeId, versionId, lineId, substituteId };
}

describeIfDatabase('recipe activation versus edits (real PostgreSQL)', () => {
  beforeAll(async () => {
    await setup!.connect();
    await setup!.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await setup!.query(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $2, 'Recipe race', 'Recipe race', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [organizationId, id('recipe-race')]
    );
    await setup!.query(
      `INSERT INTO restaurant_units (id, "organizationId", name, "updatedAt")
         VALUES ($1, $2, 'each', CURRENT_TIMESTAMP)`,
      [unitId, organizationId]
    );
    await setup!.query(
      `INSERT INTO restaurant_products (id, "organizationId", name, "updatedAt")
         VALUES ($1, $2, 'Race product', CURRENT_TIMESTAMP)`,
      [productId, organizationId]
    );
    await setup!.query(
      `INSERT INTO restaurant_ingredients (id, "organizationId", name, "baseUnitId", "updatedAt")
         VALUES ($1, $2, 'Primary', $3, CURRENT_TIMESTAMP),
                ($4, $2, 'Substitute', $3, CURRENT_TIMESTAMP),
                ($5, $2, 'Alternate', $3, CURRENT_TIMESTAMP)`,
      [ingredientId, organizationId, unitId, substituteIngredientId, alternateIngredientId]
    );
  }, 30_000);

  afterAll(async () => {
    if (setup) {
      await setup.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
      await setup.end();
    }
  });

  const cases: Array<{
    name: string;
    write: (db: ScopedDb, ids: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>;
  }> = [
    {
      name: 'version update',
      write: (db, ids) => updateRecipeVersion(db, ids.versionId, { notes: 'after' }),
    },
    {
      name: 'line create',
      write: (db, ids) =>
        createRecipeLine(db, {
          recipeVersionId: ids.versionId,
          ingredientId: substituteIngredientId,
          quantity: '2',
          unitId,
        }),
    },
    {
      name: 'line update',
      write: (db, ids) => updateRecipeLine(db, ids.lineId, { quantity: '2' }),
    },
    { name: 'line delete', write: (db, ids) => deleteRecipeLine(db, ids.lineId) },
    {
      name: 'substitute add',
      write: (db, ids) =>
        addRecipeLineSubstitute(db, {
          recipeLineId: ids.lineId,
          substituteIngredientId: alternateIngredientId,
        }),
    },
    { name: 'substitute remove', write: (db, ids) => removeRecipeLineSubstitute(db, ids.substituteId) },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name} queued behind activation without changing the aggregate`, async () => {
      const ids = await fixture(testCase.name.replaceAll(' ', '_'));
      const before = await setup!.query(
        `SELECT v.notes, l.id AS "lineId", l.quantity::text, s.id AS "substituteId"
           FROM restaurant_recipe_versions v
           LEFT JOIN restaurant_recipe_lines l ON l."recipeVersionId" = v.id
           LEFT JOIN restaurant_recipe_line_substitutes s ON s."recipeLineId" = l.id
          WHERE v.id = $1 ORDER BY l.id, s.id`,
        [ids.versionId]
      );
      const writerReady = gate();
      const releaseWriter = gate();
      const activationUpdated = gate();
      const releaseActivation = gate();

      const writer = withTenantDb(
        organizationId,
        (db) => testCase.write(pausedWriter(db, writerReady, releaseWriter), ids),
        { skipDrain: true }
      );
      await writerReady.promise;
      const activation = withTenantDb(
        organizationId,
        (db) =>
          activateRecipeVersion(
            pausedActivation(db, activationUpdated, releaseActivation),
            ids.recipeId,
            ids.versionId
          ),
        { skipDrain: true }
      );
      await activationUpdated.promise;

      let writerSettled = false;
      void writer.then(
        () => {
          writerSettled = true;
        },
        () => {
          writerSettled = true;
        }
      );
      releaseWriter.open();
      await setup!.query('SELECT pg_sleep(0.05)');
      expect(writerSettled).toBe(false);
      releaseActivation.open();
      await activation;
      await expect(writer).rejects.toBeInstanceOf(VersionImmutabilityError);

      const after = await setup!.query(
        `SELECT v.notes, l.id AS "lineId", l.quantity::text, s.id AS "substituteId"
           FROM restaurant_recipe_versions v
           LEFT JOIN restaurant_recipe_lines l ON l."recipeVersionId" = v.id
           LEFT JOIN restaurant_recipe_line_substitutes s ON s."recipeLineId" = l.id
          WHERE v.id = $1 ORDER BY l.id, s.id`,
        [ids.versionId]
      );
      expect(after.rows).toEqual(before.rows);
      expect(
        (
          await setup!.query(`SELECT status FROM restaurant_recipe_versions WHERE id = $1`, [
            ids.versionId,
          ])
        ).rows
      ).toEqual([{ status: 'ACTIVE' }]);
    });
  }
});
