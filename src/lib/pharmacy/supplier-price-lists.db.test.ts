// @vitest-environment node
/**
 * DEV-893 — execute the importer's snapshot/draft SQL against migrated PostgreSQL.
 * DEV-681 — and the review, alert-count and approval SQL: trade-price and MRP
 * change flags, a CSV and an Excel import, and a person approving or rejecting.
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
let service: typeof import('./supplier-price-lists');
let importSupplierPriceList: typeof import('./supplier-price-lists').importSupplierPriceList;
let disconnect: (() => Promise<void>) | undefined;

const suffix = randomBytes(6).toString('hex');
const organizationId = `org_dev893_${suffix}`;
const actorId = `user_dev893_${suffix}`;
const ownerId = `owner_dev681_${suffix}`;
const branchId = `branch_dev681_${suffix}`;
let supplierId: string;
let stockLocationId: string;

const inTenant = <T>(work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(organizationId, work, { userId: actorId });

describe.skipIf(!databaseUrl)('DEV-893 supplier price-list detection SQL', () => {
  beforeAll(async () => {
    const [scoped, loaded, client, guard, departments] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./supplier-price-lists'),
      import('@/lib/db'),
      import('@/lib/testing/rls-role-guard'),
      import('@/lib/test-support/departments'),
    ]);
    withTenantDb = scoped.withTenantDb;
    service = loaded;
    importSupplierPriceList = loaded.importSupplierPriceList;
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
      // DEV-681: the owner (an administrator) who approves a draft did not import it.
      await db.user.create({
        data: {
          id: ownerId,
          organizationId,
          name: 'Pharmacy owner',
          email: `${ownerId}@example.test`,
          role: 'ADMIN',
          department: 'PHARMACY',
          title: 'Owner',
        },
      });
      // DEV-681: an authorized, licensed distributor, so its invoices can be
      // posted and supply the trade price a list is compared with.
      const supplier = await db.pharmacySupplier.create({
        data: {
          organizationId,
          name: `DEV-893 distributor ${suffix}`,
          authorized: true,
          licences: {
            create: {
              licenceType: 'DRUG_SALE',
              licenceNumber: `LIC-${suffix}`,
              issuingAuthority: 'Provincial Drug Control',
              issuedAt: new Date('2026-01-01T00:00:00Z'),
              expiresAt: new Date('2099-12-31T00:00:00Z'),
              verifiedAt: new Date('2026-01-05T00:00:00Z'),
              verifiedByUserId: actorId,
            },
          },
        },
      });
      supplierId = supplier.id;
      await db.pharmacyBranch.create({
        data: {
          id: branchId,
          organizationId,
          code: branchId,
          name: 'DEV-681 branch',
          addressLine: '1 Test Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId,
          code: `MAIN-${suffix}`,
          name: 'Main store',
          kind: 'STORE',
        },
      });
      stockLocationId = location.id;
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
  /** A medicine with one current BOX pack and an organization price policy. */
  const catalogue = (label: string, mrp: number, selling: number) =>
    inTenant(async (db) => {
      const medicine = await db.medicine.create({
        data: {
          organizationId,
          productName: `DEV-681 ${label} ${suffix}`,
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
      const price = await db.pharmacyPackPrice.create({
        data: {
          organizationId,
          presentationId: pack.presentationId,
          packLevelId: pack.id,
          mrpMinor: mrp,
          sellingPriceMinor: selling,
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          source: 'manual',
          createdById: actorId,
        },
      });
      return { medicine, pack, price };
    });

  /** This supplier's last posted invoice: the trade price a list is compared with. */
  const postedInvoice = (
    fixture: Awaited<ReturnType<typeof catalogue>>,
    label: string,
    tradePriceMinor: number
  ) =>
    inTenant(async (db) => {
      const receipt = await db.pharmacyGoodsReceipt.create({
        data: {
          organizationId,
          branchId,
          reference: `GRN-${label}-${suffix}`,
          supplierId,
          supplierInvoiceRef: `INV-${label}-${suffix}`,
          supplierInvoiceDate: new Date('2026-10-01T00:00:00Z'),
          warrantyEvidenceRef: `WARRANTY-${label}-${suffix}`,
          receivedByUserId: actorId,
          receivedAt: new Date('2026-10-01T00:00:00Z'),
          directPurchase: true,
          bypassReason: 'Emergency purchase without an order.',
          bypassApprovedByUserId: ownerId,
          bypassApprovedAt: new Date('2026-10-01T00:00:00Z'),
          lines: {
            create: {
              lineNumber: 1,
              medicineId: fixture.medicine.id,
              packLevelId: fixture.pack.id,
              batchNumber: `B-${label}-${suffix}`,
              printedExpiry: new Date('2028-12-31T00:00:00Z'),
              expiryPrecision: 'DAY',
              printedMrpMinor: fixture.price.mrpMinor,
              canonicalUnitsPerPack: 1,
              receivedPacks: 1,
              receivedCanonicalUnits: 1,
              acceptedCanonicalUnits: 1,
              invoicedPricePerPackMinor: tradePriceMinor,
              unitCostMinor: tradePriceMinor,
              stockLocationId,
            },
          },
        },
      });
      // Only the posted invoice is a trade-price record; the draft above is not.
      await db.pharmacyGoodsReceipt.updateMany({
        where: { organizationId, id: receipt.id },
        data: { status: 'POSTED', postedAt: new Date('2026-10-01T00:00:00Z') },
      });
    });

  it('flags trade-price and MRP changes in SQL, and a person approves or rejects every draft', async () => {
    const [risen, steady, unknown] = await Promise.all([
      catalogue('risen', 100_000, 95_000),
      catalogue('steady', 50_000, 50_000),
      catalogue('trade only', 40_000, 38_000),
    ]);
    await postedInvoice(risen, 'risen', 80_000);
    await postedInvoice(steady, 'steady', 42_000);
    await postedInvoice(unknown, 'trade-only', 30_000);

    const file = Buffer.from(
      [
        'Product,Pack,TP,MRP',
        `${risen.medicine.productName},BOX,850.00,1100.00`,
        `${steady.medicine.productName},BOX,420.00,500.00`,
        `${unknown.medicine.productName},BOX,320.00,`,
        'Not in this catalogue,BOX,10.00,12.00',
        '',
      ].join('\n')
    );
    const { priceListId } = await inTenant((db) =>
      importSupplierPriceList(
        db,
        { organizationId, actorId },
        { supplierId, fileName: 'flags.csv', bytes: file }
      )
    );

    const review = await inTenant((db) =>
      service.supplierPriceListReview(db, organizationId, priceListId)
    );
    const byRow = Object.fromEntries(review.lines.map((line) => [line.rowNumber, line]));
    expect(byRow[2]).toMatchObject({
      matchStatus: 'MATCHED',
      previousTradePriceMinor: 80_000,
      tradeChangeMinor: 5_000,
      tradeChangeBps: 625,
      currentMrpMinor: 100_000,
      mrpChangeMinor: 10_000,
      mrpChangeBps: 1_000,
      tradeChanged: true,
      mrpChanged: true,
      tradeAboveMrp: false,
      draftStatus: 'DRAFT',
      draftMrpMinor: 110_000,
      draftSellingPriceMinor: 95_000,
      stale: false,
    });
    expect(byRow[3]).toMatchObject({
      tradeChangeMinor: 0,
      mrpChangeMinor: 0,
      tradeChanged: false,
      mrpChanged: false,
      draftStatus: 'NONE',
    });
    expect(byRow[4]).toMatchObject({
      previousTradePriceMinor: 30_000,
      tradeChangeMinor: 2_000,
      tradeChangeBps: 667,
      listMrpMinor: null,
      tradeChanged: true,
      mrpChanged: false,
      draftStatus: 'NONE',
    });
    expect(byRow[5]).toMatchObject({
      matchStatus: 'NO_MATCH',
      tradeChanged: false,
      mrpChanged: false,
      draftStatus: 'NONE',
    });

    const listed = await inTenant((db) => service.listSupplierPriceLists(db, organizationId));
    expect(listed.find((list) => list.id === priceListId)).toMatchObject({
      rowCount: 4,
      matched: 3,
      alerts: 2,
      drafts: 1,
    });

    // The importer may not approve their own list while an owner could.
    await expect(
      inTenant((db) =>
        service.decideSupplierPriceDrafts(
          db,
          { organizationId, actorId },
          { lineIds: [byRow[2]!.id], decision: 'APPROVE' }
        )
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const owner = { organizationId, actorId: ownerId };
    const ownerTenant = <T>(work: (db: ScopedDb) => Promise<T>) =>
      withTenantDb(organizationId, work, { userId: ownerId });
    const [approved] = await ownerTenant((db) =>
      service.decideSupplierPriceDrafts(db, owner, { lineIds: [byRow[2]!.id], decision: 'APPROVE' })
    );
    const after = await ownerTenant(async (db) => ({
      line: await db.pharmacySupplierPriceListLine.findFirstOrThrow({
        where: { organizationId, id: byRow[2]!.id },
      }),
      prices: await db.pharmacyPackPrice.findMany({
        where: { organizationId, packLevelId: risen.pack.id },
        orderBy: { createdAt: 'asc' },
      }),
      audit: await db.auditLog.findFirst({
        where: {
          organizationId,
          action: 'pharmacySupplierPriceLists.approveDraft',
          targetId: byRow[2]!.id,
        },
      }),
    }));
    expect(after.line).toMatchObject({
      draftStatus: 'APPROVED',
      decidedById: ownerId,
      packPriceId: approved!.packPriceId,
    });
    expect(after.prices).toHaveLength(2);
    expect(after.prices[1]).toMatchObject({
      id: approved!.packPriceId,
      mrpMinor: 110_000,
      sellingPriceMinor: 95_000,
      source: 'supplier',
      createdById: ownerId,
    });
    expect(after.audit).toMatchObject({ actorId: ownerId });

    // A decided draft cannot be decided again.
    await expect(
      ownerTenant((db) =>
        service.decideSupplierPriceDrafts(db, owner, {
          lineIds: [byRow[2]!.id],
          decision: 'REJECT',
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  /** An Excel price list, as a distributor sends it. */
  const workbook = async (productName: string) => {
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Prices');
    sheet.addRow(['Product Name', 'Packing', 'Trade Price', 'M.R.P']);
    sheet.addRow([productName, 'BOX', '', '1200.00']);
    return Buffer.from(await book.xlsx.writeBuffer());
  };

  it('imports an Excel list and writes no price when a person rejects its draft', async () => {
    const fixture = await catalogue('rejected', 100_000, 95_000);
    const bytes = await workbook(fixture.medicine.productName);
    const { priceListId } = await inTenant((db) =>
      importSupplierPriceList(
        db,
        { organizationId, actorId },
        { supplierId, fileName: 'distributor-prices.xlsx', bytes }
      )
    );
    const review = await inTenant((db) =>
      service.supplierPriceListReview(db, organizationId, priceListId)
    );
    expect(review.lines[0]).toMatchObject({
      draftStatus: 'DRAFT',
      mrpChanged: true,
      tradeChanged: false,
    });
    await withTenantDb(
      organizationId,
      (db) =>
        service.decideSupplierPriceDrafts(
          db,
          { organizationId, actorId: ownerId },
          { lineIds: [review.lines[0]!.id], decision: 'REJECT' }
        ),
      { userId: ownerId }
    );
    const stored = await inTenant(async (db) => ({
      line: await db.pharmacySupplierPriceListLine.findFirstOrThrow({
        where: { organizationId, id: review.lines[0]!.id },
      }),
      prices: await db.pharmacyPackPrice.findMany({
        where: { organizationId, packLevelId: fixture.pack.id },
      }),
    }));
    expect(stored.line).toMatchObject({
      draftStatus: 'REJECTED',
      decidedById: ownerId,
      packPriceId: null,
    });
    expect(stored.prices).toEqual([fixture.price]);
  });
});
