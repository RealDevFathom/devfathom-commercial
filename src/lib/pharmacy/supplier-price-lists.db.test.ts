// @vitest-environment node
/**
 * DEV-893 — execute the importer's snapshot/draft SQL against migrated PostgreSQL.
 * No database calls are mocked. Set TEST_DATABASE_URL to a disposable database
 * using a NOSUPERUSER/NOBYPASSRLS runtime role; without it this suite is skipped.
 * Fixtures use unique IDs and remain in that database; teardown only disconnects.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!/(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i.test(name)) {
    throw new Error('TEST_DATABASE_URL must name a dedicated disposable database.');
  }
  process.env.DATABASE_URL = databaseUrl;
}

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let importSupplierPriceList: typeof import('./supplier-price-lists').importSupplierPriceList;
let disconnect: (() => Promise<void>) | undefined;

const suffix = randomBytes(6).toString('hex');
const organizationId = `org_dev893_${suffix}`;
const actorId = `user_dev893_${suffix}`;
let supplierId: string;

const inTenant = <T>(work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(organizationId, work, { userId: actorId });

describe.skipIf(!databaseUrl)('DEV-893 supplier price-list detection SQL', () => {
  beforeAll(async () => {
    const [scoped, service, client, guard, departments] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./supplier-price-lists'),
      import('@/lib/db'),
      import('@/lib/testing/rls-role-guard'),
      import('@/lib/test-support/departments'),
    ]);
    withTenantDb = scoped.withTenantDb;
    importSupplierPriceList = service.importSupplierPriceList;
    disconnect = () => client.db.$disconnect();
    await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
    await scoped.withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          legalName: 'DEV-893 test pharmacy',
          displayName: 'DEV-893 test pharmacy',
          vertical: 'PHARMACY',
          status: 'ACTIVE',
        },
      })
    );
    await inTenant(async (db) => {
      await departments.seedDepartments(db, [organizationId], ['PHARMACY']);
      await db.user.create({
        data: {
          id: actorId,
          organizationId,
          name: 'Price-list importer',
          email: `${actorId}@example.test`,
          department: 'PHARMACY',
          title: 'Buyer',
        },
      });
      const supplier = await db.pharmacySupplier.create({
        data: { organizationId, name: `DEV-893 distributor ${suffix}` },
      });
      supplierId = supplier.id;
    });
  }, 30_000);

  afterAll(async () => disconnect?.());

  it.each([
    {
      label: 'increased MRP',
      current: 100_000,
      selling: 95_000,
      listed: 110_000,
      draft: 95_000,
      status: 'DRAFT',
    },
    {
      label: 'decreased MRP caps selling price',
      current: 100_000,
      selling: 95_000,
      listed: 90_000,
      draft: 90_000,
      status: 'DRAFT',
    },
    {
      label: 'unchanged MRP',
      current: 100_000,
      selling: 95_000,
      listed: 100_000,
      draft: null,
      status: 'NONE',
    },
    {
      label: 'trade price only',
      current: 100_000,
      selling: 95_000,
      listed: null,
      draft: null,
      status: 'NONE',
    },
    {
      label: 'no current price policy',
      current: null,
      selling: null,
      listed: 100_000,
      draft: null,
      status: 'DRAFT',
    },
    {
      label: 'no current selling price',
      current: 100_000,
      selling: null,
      listed: 90_000,
      draft: null,
      status: 'DRAFT',
    },
    { label: 'zero MRP', current: 100_000, selling: 95_000, listed: 0, draft: 0, status: 'DRAFT' },
  ])('$label', async ({ label, current, selling, listed, draft, status }) => {
    const fixture = await inTenant(async (db) => {
      const medicine = await db.medicine.create({
        data: {
          organizationId,
          productName: `DEV-893 ${label} ${suffix}`,
          productFamily: 'PHARMACEUTICAL',
          presentations: { create: { organizationId, presentation: 'Tablet box' } },
        },
        include: { presentations: true },
      });
      const pack = await db.packLevel.create({
        data: {
          organizationId,
          presentationId: medicine.presentations[0]!.id,
          versionGroupId: medicine.id,
          version: 1,
          level: 'BOX',
          unitsPerParent: 1,
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
        },
      });
      const price =
        current === null
          ? null
          : await db.pharmacyPackPrice.create({
              data: {
                organizationId,
                presentationId: pack.presentationId,
                packLevelId: pack.id,
                mrpMinor: current,
                sellingPriceMinor: selling,
                effectiveFrom: new Date('2020-01-01T00:00:00Z'),
                source: 'manual',
                createdById: actorId,
              },
            });
      return { medicine, pack, price };
    });

    const result = await inTenant((db) =>
      importSupplierPriceList(
        db,
        { organizationId, actorId },
        {
          supplierId,
          fileName: 'prices.csv',
          bytes: Buffer.from(
            `Product,Pack,TP,MRP\n${fixture.medicine.productName},BOX,850,${listed === null ? '' : (listed / 100).toFixed(2)}\n`
          ),
        }
      )
    );
    expect(result.replayed).toBe(false);

    // Read committed rows in a fresh transaction, rather than inspecting SQL text
    // or returning expected values from a mock of $executeRaw.
    const stored = await inTenant(async (db) => ({
      lines: await db.pharmacySupplierPriceListLine.findMany({
        where: { organizationId, priceListId: result.priceListId },
      }),
      prices: await db.pharmacyPackPrice.findMany({
        where: { organizationId, packLevelId: fixture.pack.id },
      }),
    }));
    expect(stored.lines).toHaveLength(1);
    expect(stored.lines[0]).toMatchObject({
      rowNumber: 2,
      matchStatus: 'MATCHED',
      medicineId: fixture.medicine.id,
      packLevelId: fixture.pack.id,
      listTradePriceMinor: 85_000,
      listMrpMinor: listed,
      previousTradePriceMinor: null,
      currentPackPriceId: fixture.price?.id ?? null,
      currentMrpMinor: current,
      currentSellingPriceMinor: selling,
      draftStatus: status,
      draftMrpMinor: status === 'DRAFT' ? listed : null,
      draftSellingPriceMinor: draft,
      packPriceId: null,
      decidedById: null,
      decidedAt: null,
    });
    expect(stored.prices).toEqual(fixture.price ? [fixture.price] : []);
  });
});
