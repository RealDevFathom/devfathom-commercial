// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  createCategory,
  createProduct,
  getProduct,
  listProducts,
  listCategories,
  updateProduct,
  ensureDefaultBrand,
  listBrands,
} from '@/lib/restaurant/catalog';
import { assertInOrganization } from '@/server/org-refs';

// A disposable schema and role; the supplied owner must be a superuser so the
// regression really exercises the connection that bypassed RLS in issue #142.
const url = process.env.CATALOG_TEST_DATABASE_URL;
const schema = `qa142_${process.pid}_${Date.now()}`;
const role = `${schema}_runtime`;
const suite = url ? describe : describe.skip;

suite('catalog tenant isolation on real PostgreSQL (#142)', () => {
  const owner = new pg.Client({ connectionString: url });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }, { schema }) });
  let productA: string;
  let categoryA: string;
  let productB: string;

  const tenant = <T>(
    organizationId: string,
    run: (tx: ScopedDb) => Promise<T>,
    restricted = false
  ) =>
    db.$transaction(async (tx) => {
      if (restricted) await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      await tx.$queryRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true),
        set_config('app.is_platform_admin', 'false', true)`;
      return run(tx as ScopedDb);
    });

  beforeAll(async () => {
    await owner.connect();
    const result = await owner.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    expect(result.rows[0].rolsuper).toBe(true);
    await owner.query(`CREATE SCHEMA "${schema}"`);
    await owner.query(`SET search_path TO "${schema}"`);
    await owner.query(`CREATE TABLE restaurant_branches (id text PRIMARY KEY, "organizationId" text,
      UNIQUE ("organizationId", id))`);
    // Use the shipped DDL, composite tenant FKs and FORCE RLS policies.
    await owner.query(
      await readFile(
        'prisma/migrations/20260818160000_restaurant_brands_catalog_menus/migration.sql',
        'utf8'
      )
    );
    await owner.query(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS NOLOGIN`);
    await owner.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`
    );
    await tenant('house', async (tx) => {
      categoryA = (await createCategory(tx, { name: 'House food' })).id;
      productA = (await createProduct(tx, { name: 'Chicken Karahi', categoryId: categoryA })).id;
      await createProduct(tx, { name: 'Garlic Naan' });
      await ensureDefaultBrand(tx, 'House');
    });
    await tenant('essentials', async (tx) => {
      productB = (await createProduct(tx, { name: 'Essentials product' })).id;
      await ensureDefaultBrand(tx, 'Essentials');
    });
  });

  afterAll(async () => {
    await db.$disconnect();
    await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner.query(`DROP ROLE IF EXISTS "${role}"`);
    await owner.end();
  });

  it('reproduces the original id-only and unfiltered leak under superuser', async () => {
    await tenant('essentials', async (tx) => {
      expect(
        (await tx.restaurantProduct.findUnique({ where: { id: productA } }))?.organizationId
      ).toBe('house');
      expect(await tx.restaurantProduct.count()).toBe(3);
    });
  });

  for (const restricted of [false, true]) {
    it(`restores row_security from off before catalog reads (${restricted ? 'restricted role' : 'superuser'})`, async () => {
      await tenant(
        'essentials',
        async (tx) => {
          const rowSecurity = async () => {
            const [setting] = await tx.$queryRaw<{ value: string }[]>`
              SELECT current_setting('row_security') AS value
            `;
            return setting.value;
          };
          await tx.$queryRaw`SELECT set_config('row_security', 'off', true)`;
          expect(await rowSecurity()).toBe('off');
          expect((await getProduct(tx, productB)).id).toBe(productB);
          expect(await rowSecurity()).toBe('on');

          await tx.$queryRaw`SELECT set_config('row_security', 'off', true)`;
          expect(await rowSecurity()).toBe('off');
          expect((await listProducts(tx)).map((product) => product.id)).toEqual([productB]);
          expect(await rowSecurity()).toBe('on');
          // The restricted role now applies the policy even to unfiltered reads.
          if (restricted) expect(await tx.restaurantProduct.count()).toBe(1);
        },
        restricted
      );
    });

    it(`blocks the reported getProduct/listProducts leak (${restricted ? 'restricted role' : 'superuser'})`, async () => {
      await tenant(
        'essentials',
        async (tx) => {
          await expect(getProduct(tx, productA)).rejects.toMatchObject({ reason: 'NOT_FOUND' });
          const products = await listProducts(tx);
          expect(products.map((p) => p.id)).toEqual([productB]);
          expect(products.every((p) => p.organizationId === 'essentials')).toBe(true);
          expect(await listProducts(tx, { categoryId: categoryA })).toEqual([]);
          expect(await listCategories(tx)).toEqual([]);
          expect((await listBrands(tx)).map((b) => b.name)).toEqual(['Essentials']);
          await expect(updateProduct(tx, productA, { name: 'Stolen' })).rejects.toMatchObject({
            reason: 'NOT_FOUND',
          });
          await expect(
            createProduct(tx, { name: 'Invalid', categoryId: categoryA })
          ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
          await expect(
            assertInOrganization(tx.restaurantCategory, 'essentials', [categoryA])
          ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        },
        restricted
      );
      await tenant(
        'house',
        async (tx) => {
          expect((await getProduct(tx, productA)).name).toBe('Chicken Karahi');
          expect(await listProducts(tx)).toHaveLength(2);
        },
        restricted
      );
    });
  }

  it('ships ENABLE and FORCE RLS on every catalog/recipe table', async () => {
    const { rows } = await owner.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname <> 'restaurant_branches'`,
      [schema]
    );
    expect(rows).toHaveLength(28);
    expect(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    await tenant(
      'essentials',
      async (tx) => {
        expect(await tx.restaurantProduct.findUnique({ where: { id: productA } })).toBeNull();
        expect(await tx.restaurantProduct.count()).toBe(1);
      },
      true
    );
  });

  it('fails closed with no organization scope even for a superuser', async () => {
    await expect(listProducts(db)).rejects.toThrow('Catalog requires an active organization');
  });
});
