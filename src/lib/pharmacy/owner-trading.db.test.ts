/** Run on the local migrated pharmacy test database as the restricted runtime role. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { dashboardPeriods, readOwnerTrading, type TradingSection } from './owner-trading';
import { aggregateTenderTotals } from './manual-payments';
import { readPharmacyOwnerCommandCentre } from './reports';
import { grossMargin } from './finance-reports';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const org = `dashboard_${randomUUID()}`;
const id = `${org}_branch`;
const at = new Date('2026-10-09T12:00:00Z');
const periods = dashboardPeriods([{ id, name: 'Main' }], 'Asia/Karachi', at);
let scoped: typeof import('@/lib/tenancy/scoped-db');
describe.skipIf(!url)('owner dashboard and reports on the same completed sale', () => {
  beforeAll(async () => {
    scoped = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(scoped.withPlatformDb);
    await scoped.withTenantDb(org, async (db) => {
      await db.organization.create({
        data: {
          id: org,
          slug: org,
          legalName: org,
          displayName: 'Synthetic Pharmacy',
          vertical: 'PHARMACY',
          status: 'ACTIVE',
        },
      });
      await db.pharmacyBranch.create({
        data: {
          id,
          organizationId: org,
          code: 'MAIN',
          name: 'Main',
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
      await db.$executeRaw`INSERT INTO pharmacy_medicines(id,"organizationId","productName","productFamily","updatedAt") VALUES (${org},${org},'Synthetic medicine','PHARMACEUTICAL',now())`;
      await db.$executeRaw`INSERT INTO pharmacy_presentations(id,"organizationId","medicineId",presentation,"updatedAt") VALUES (${org},${org},${org},'Unit',now())`;
      await db.$executeRaw`INSERT INTO pharmacy_pack_levels(id,"organizationId","presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom") VALUES (${org},${org},${org},${org},1,'UNIT',1,'2020-01-01')`;
      await db.$executeRaw`INSERT INTO pharmacy_sales(id,"organizationId","branchId",status,"createdByUserId","businessDate","completedAt","receiptNumber","createdAt","updatedAt") VALUES (${org},${org},${id},'COMPLETED','synthetic','2026-10-09',${at},1,${at},${at})`;
      await db.$executeRaw`INSERT INTO pharmacy_sale_lines(id,"organizationId","branchId","saleId","medicineId","presentationId","packLevelId","saleUnit",quantity,"canonicalUnitsPerSaleUnit","canonicalUnits","unitPriceMinor","grossMinor","proRataCeilingMinor","unitCostMinor","discountMinor","discountKind","approvalPolicy","approvedByUserId","idempotencyKey") VALUES (${org},${org},${id},${org},${org},${org},${org},'PACK',2,1,2,500,1000,500,100,75,'DISCOUNT','synthetic','synthetic',${org})`;
      await db.$executeRaw`INSERT INTO pharmacy_tenders(id,"organizationId","branchId","saleId",type,"amountMinor","businessDate","actorId","deviceId","createdAt") VALUES (${org},${org},${id},${org},'CARD',925,'2026-10-09','synthetic','synthetic',${at})`;
    });
  });
  const read = (section: TradingSection, financial = true) =>
    scoped.withTenantDb(org, (db) => readOwnerTrading(db, org, periods, section, financial));
  const report = () =>
    scoped.withTenantDb(org, (db) =>
      readPharmacyOwnerCommandCentre(db, {
        branchIds: [id],
        from: '2026-10-09',
        to: '2026-10-09',
        timeZone: 'Asia/Karachi',
      })
    );
  it('matches sales, bill count, mean receipt, posted margin and tender totals', async () => {
    const rows = await read('summary');
    const actual = Object.fromEntries(rows.map((p) => [p.label, p.value]));
    const ledger = await report();
    const close = await scoped.withTenantDb(org, async (db) => ({
      bills: await db.pharmacySale.count({
        where: {
          organizationId: org,
          branchId: id,
          status: 'COMPLETED',
          businessDate: new Date('2026-10-09'),
        },
      }),
      tenders: aggregateTenderTotals(
        await db.pharmacyTender.findMany({
          where: { organizationId: org, branchId: id, businessDate: new Date('2026-10-09') },
        }),
        []
      ),
    }));
    expect(actual.Sales).toBe(ledger.metrics.salesMinor);
    expect(actual.Bills).toBe(close.bills);
    expect(actual['Average bill']).toBe(Math.round(ledger.metrics.salesMinor! / close.bills));
    expect(actual['Gross profit']).toBe(ledger.metrics.marginMinor);
    expect(actual.Cash).toBe(ledger.metrics.cashMinor);
    expect(actual.Card).toBe(close.tenders.find((t) => t.type === 'CARD')!.amountMinor);
    expect(actual.Wallet).toBe(0);
    expect(rows.find((p) => p.label === 'Sales')?.previous).toBe(0);
  });
  it.each([
    ['days', 'Today'],
    ['hours', '17:00'],
    ['branches', 'Main'],
    ['medicines', 'Synthetic medicine'],
  ] as const)('matches the sales report for %s', async (section, label) => {
    const item = (await read(section)).find((p) => p.label === label);
    expect(item?.value).toBe(925);
    expect(item?.value).toBe((await report()).metrics.salesMinor);
  });
  it('matches day close applied card tenders and the finance product margin report', async () => {
    const [payment] = await read('payments');
    const tenders = await scoped.withTenantDb(org, (db) =>
      db.pharmacyTender.findMany({ where: { organizationId: org, branchId: id } })
    );
    expect(payment).toEqual({
      label: 'CARD',
      value: aggregateTenderTotals(tenders, [])[0]!.amountMinor,
    });
    const margin = await scoped.withTenantDb(org, (db) =>
      grossMargin(
        db,
        { organizationId: org, branchId: id },
        { by: 'product', from: new Date('2026-09-09T19:00Z'), to: new Date('2026-10-09T19:00Z') }
      )
    );
    expect((await read('profits')).map((p) => p.value)).toEqual(
      margin.map((r) => r.grossMarginMinor)
    );
  });
  it('returns bill counts alone for an operational dashboard', async () => {
    expect(await read('summary', false)).toEqual([
      { label: 'Bills', value: 1, previous: 0, count: true },
    ]);
    expect(await read('profits', false)).toEqual([]);
  });
});
