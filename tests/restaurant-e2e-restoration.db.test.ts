import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import pg from 'pg';

import { resolveRestaurantE2eDatabaseUrl } from '../scripts/restaurant-e2e-database';
import { RESTAURANT_E2E_OWNED_ROW_COUNT } from '../scripts/seed-restaurant-e2e';

const optedIn = process.env.RESTAURANT_E2E_RESTORATION_DB === '1';
if (optedIn && !process.env.RESTAURANT_E2E_DATABASE_URL) {
  throw new Error('RESTAURANT_E2E_DATABASE_URL is required when RESTAURANT_E2E_RESTORATION_DB=1.');
}

const describeIfOptedIn = optedIn ? describe : describe.skip;

describeIfOptedIn('Restaurant E2E seed canonical restoration (real disposable DB)', () => {
  let pool: pg.Pool;

  const runSeed = () => {
    const result = spawnSync('bunx', ['tsx', 'scripts/seed-restaurant-e2e.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, RESTAURANT_INTEGRATED_E2E: '1' },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(
      `exact owned fixture rows=${RESTAURANT_E2E_OWNED_ROW_COUNT}; leaked fixture rows=0`
    );
  };

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: resolveRestaurantE2eDatabaseUrl() });
  });

  afterAll(async () => {
    await pool?.end();
  });

  test('rerun repairs corruption and preserves the exact complete ownership manifest', async () => {
    runSeed();

    const role = await pool.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(role.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)`,
        ['org_chai_chowk']
      );
      await client.query(
        `UPDATE restaurant_branches SET "businessDayCutoff" = '04:30', "shiftSignInEnforced" = true, address = 'corrupt' WHERE id = 'branch_restaurant_e2e'`
      );
      await client.query(
        `UPDATE restaurant_brands SET status = 'ARCHIVED', "nameLocalized" = '{"ur":"corrupt"}' WHERE id = 'brand_restaurant_e2e'`
      );
      await client.query(
        `UPDATE restaurant_products SET type = 'COMBO', status = 'ARCHIVED', description = 'corrupt', "descriptionLocalized" = '{"ur":"corrupt"}', "sortOrder" = 99 WHERE id = 'product_restaurant_e2e_burger'`
      );
      await client.query(
        `UPDATE restaurant_branch_menu_publications SET "retiredAt" = now() WHERE id = 'menu_publication_restaurant_e2e'`
      );
      await client.query(
        `UPDATE restaurant_customers SET "displayName" = 'corrupt', notes = 'corrupt' WHERE id = 'customer_restaurant_e2e'`
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    runSeed();

    const restorationClient = await pool.connect();
    let restored: pg.QueryResult<{
      businessDayCutoff: string;
      shiftSignInEnforced: boolean;
      address: string | null;
      brandStatus: string;
      brandLocalized: unknown;
      productType: string;
      productStatus: string;
      description: string | null;
      descriptionLocalized: unknown;
      sortOrder: number;
      retiredAt: Date | null;
      customerName: string;
      customerNotes: string | null;
    }>;
    try {
      await restorationClient.query('BEGIN');
      await restorationClient.query(
        `SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)`,
        ['org_chai_chowk']
      );
      restored = await restorationClient.query(`
        SELECT b."businessDayCutoff", b."shiftSignInEnforced", b.address,
          brand.status AS "brandStatus", brand."nameLocalized" AS "brandLocalized",
          product.type AS "productType", product.status AS "productStatus",
          product.description, product."descriptionLocalized", product."sortOrder",
          publication."retiredAt", customer."displayName" AS "customerName",
          customer.notes AS "customerNotes"
        FROM restaurant_branches b
        JOIN restaurant_brands brand ON brand.id = 'brand_restaurant_e2e'
        JOIN restaurant_products product ON product.id = 'product_restaurant_e2e_burger'
        JOIN restaurant_branch_menu_publications publication ON publication.id = 'menu_publication_restaurant_e2e'
        JOIN restaurant_customers customer ON customer.id = 'customer_restaurant_e2e'
        WHERE b.id = 'branch_restaurant_e2e'
      `);
      await restorationClient.query('COMMIT');
    } catch (error) {
      await restorationClient.query('ROLLBACK');
      throw error;
    } finally {
      restorationClient.release();
    }
    expect(restored.rows).toEqual([
      {
        businessDayCutoff: '00:00',
        shiftSignInEnforced: false,
        address: null,
        brandStatus: 'ACTIVE',
        brandLocalized: null,
        productType: 'ITEM',
        productStatus: 'ACTIVE',
        description: null,
        descriptionLocalized: null,
        sortOrder: 0,
        retiredAt: null,
        customerName: 'E2E Guest',
        customerNotes: null,
      },
    ]);
  }, 60_000);
});
