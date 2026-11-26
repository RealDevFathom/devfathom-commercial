import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacyBusinessDayRange } from './business-day';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { grossMargin, ledgerCurrencies } from './finance-reports';
import { readPharmacyOwnerCommandCentre } from './reports';
import { readVisualChart } from './visual-report-query';
import { seedVisualReport } from './visual-report.fixture';
import { REPORT_CHARTS } from './visual-chart';
import { computeCashShiftFigures } from './cash-shift-report';
import { reportRatePercent } from './report-kpi-flags';
vi.mock('server-only', () => ({}));
const org = 'visual_' + randomUUID();
const branch = org + '_main';
const day = '2026-11-24';
const custom = { from: day, to: day };
const branches = [{ id: branch, businessDayEndsAtHistory: 5 }];
let scoped: typeof import('@/lib/tenancy/scoped-db');
let medicine: string;
const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)('chart parity on the same PostgreSQL transaction evidence', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testUrl!;
    scoped = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(scoped.withPlatformDb);
    await scoped.withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: org,
          slug: org,
          legalName: 'Synthetic',
          displayName: 'Synthetic',
          vertical: 'PHARMACY',
          status: 'ACTIVE',
          deploymentMode: 'SHARED',
        },
      })
    );
    await scoped.withTenantDb(org, async (db) => {
      for (const id of [branch, org + '_other']) {
        await db.pharmacyBranch.create({
          data: { id, name: id, code: id, addressLine: 'Test', city: 'Lahore', provinceCode: 'PB' },
        });
        const seeded = await seedVisualReport(db, id, id, day);
        if (id === branch) medicine = seeded.medicine;
      }
    });
  });
  async function expectPostedMargin(
    db: ScopedDb,
    id: string,
    date: string,
    expected: number,
    excluded: number
  ) {
    const period = { from: date, to: date };
    const source = await grossMargin(
      db,
      { organizationId: org, branchId: id },
      {
        ...pharmacyBusinessDayRange(date, date, { timeZone: 'Asia/Karachi', dayEnd: 5 }),
        by: 'product',
      }
    );
    const command = await readPharmacyOwnerCommandCentre(db, {
      ...period,
      branchIds: [id],
      dayEnds: { [id]: 5 },
      timeZone: 'Asia/Karachi',
    });
    const report = await readVisualChart(
      db,
      [{ id, businessDayEndsAtHistory: 5 }],
      'Asia/Karachi',
      { chart: 'profitDay', preset: 'custom', custom: period }
    );
    expect(source.map((row) => row.grossMarginMinor)).toEqual([expected]);
    expect(command.metrics.marginMinor).toBe(expected);
    expect(report.rows).toMatchObject([
      {
        value: command.metrics.marginMinor,
        amount: source[0]!.grossMarginMinor,
        base: source[0]!.revenueMinor - source[0]!.discountMinor,
        excluded,
      },
    ]);
  }
  it('counts zero-cost stock at its posted margin in both ledger reports', async () => {
    await scoped.withTenantDb(org, async (db) => {
      const id = org + '_free';
      await db.pharmacyBranch.create({
        data: { id, code: id, name: id, addressLine: 'Test', city: 'Lahore', provinceCode: 'PB' },
      });
      await seedVisualReport(db, id, id, day, 0);
      await expectPostedMargin(db, id, day, 810, 1);
    });
  });
  it('counts a posted unidentified return without a lot in both ledger reports', async () => {
    await scoped.withTenantDb(org, async (db) => {
      const date = '2026-11-30',
        at = new Date(date + 'T12:00:00Z');
      const ret = await db.pharmacySaleReturn.create({
        data: {
          branchId: branch,
          originalSaleId: branch + '_sale',
          actorId: 'sample',
          reason: 'Unidentified box',
          createdAt: at,
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: { branchId: branch, code: 'UNIDENTIFIED', name: 'Hold', kind: 'QUARANTINE' },
      });
      const hold = await db.pharmacyUnidentifiedReturnHold.create({
        data: {
          branchId: branch,
          returnId: ret.id,
          saleLineId: branch + '_line',
          quarantineLocationId: location.id,
          canonicalUnits: 1,
          actorId: 'sample',
          integrityDecision: 'QUARANTINE',
          createdAt: at,
        },
      });
      await db.financeJournalEntry.create({
        data: {
          branchId: branch,
          sourceKind: 'PHARMACY_UNIDENTIFIED_RETURN_HOLD',
          sourceId: hold.id,
          occurredAt: at,
          idempotencyKey: hold.id,
          actorId: 'sample',
          description: 'Unidentified return',
          lines: {
            create: (
              [
                { accountCode: 'SALES_REVENUE', side: 'DEBIT' },
                { accountCode: 'CASH', side: 'CREDIT' },
              ] as const
            ).map((leg) => ({
              ...leg,
              amountMinor: 90,
              branchId: branch,
              productId: medicine,
              sourceLineId: branch + '_line',
            })),
          },
        },
      });
      await expectPostedMargin(db, branch, date, -90, 0);
    });
  });
  it('provides tenant, branch and date indexes for the bounded chart reads', async () => {
    await scoped.withTenantDb(org, async (db) => {
      const indexes = await db.$queryRaw<
        { indexname: string; indexdef: string }[]
      >`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND indexname IN ('pharmacy_visual_sale_dates_idx','pharmacy_visual_return_dates_idx','pharmacy_visual_return_lines_idx')`;
      expect(Object.fromEntries(indexes.map((row) => [row.indexname, row.indexdef]))).toEqual({
        pharmacy_visual_sale_dates_idx: expect.stringContaining(
          '("organizationId", "branchId", status, "businessDate")'
        ),
        pharmacy_visual_return_dates_idx: expect.stringContaining(
          '("organizationId", "branchId", "createdAt")'
        ),
        pharmacy_visual_return_lines_idx: expect.stringContaining(
          '("organizationId", "branchId", "returnId")'
        ),
      });
    });
  });
  it('counts a physical return with no refund and discloses its missing cost at the branch cutoff', async () => {
    await scoped.withTenantDb(org, async (db) => {
      const at = new Date('2026-11-27T23:30:00Z'); // 04:30 on the 28th in Karachi, still the 27th at this branch.
      const ret = await db.pharmacySaleReturn.create({
        data: {
          originalSaleId: branch + '_sale',
          branchId: branch,
          actorId: 'sample',
          reason: 'Damaged pack',
          createdAt: at,
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: { branchId: branch, code: 'QUAR', name: 'Quarantine', kind: 'QUARANTINE' },
      });
      await db.pharmacyUnidentifiedReturnHold.create({
        data: {
          returnId: ret.id,
          branchId: branch,
          saleLineId: branch + '_line',
          quarantineLocationId: location.id,
          canonicalUnits: 2,
          actorId: 'sample',
          integrityDecision: 'QUARANTINE',
          createdAt: at,
        },
      });
      const input = { preset: 'custom' as const, custom: { from: '2026-11-27', to: '2026-11-27' } };
      const units = await readVisualChart(db, branches, 'Asia/Karachi', {
        ...input,
        chart: 'returnMedicine',
      });
      expect(units.rows).toMatchObject([{ key: medicine, value: 2 }]);
      const reasons = await readVisualChart(db, branches, 'Asia/Karachi', {
        ...input,
        chart: 'physicalReason',
      });
      expect(reasons.rows).toMatchObject([{ label: 'Damaged pack', value: 2 }]);
      const profit = await readVisualChart(db, branches, 'Asia/Karachi', {
        ...input,
        chart: 'profitDay',
      });
      expect(profit.rows).toMatchObject([{ key: '2026-11-27', excluded: 1, value: null }]);
    });
  });
  it.each([...REPORT_CHARTS.Sales, ...REPORT_CHARTS.Returns, ...REPORT_CHARTS.Profit])(
    '%s reconciles and drills into only its branch and business day',
    async (chart) => {
      await scoped.withTenantDb(org, async (db) => {
        const report = await readVisualChart(db, branches, 'Asia/Karachi', {
          chart,
          preset: 'custom',
          custom,
        });
        const command = await readPharmacyOwnerCommandCentre(db, {
          ...custom,
          branchIds: [branch],
          dayEnds: { [branch]: 5 },
          timeZone: 'Asia/Karachi',
        });
        const { salesMinor, refundsMinor, marginMinor } = command.metrics;
        const ledger = await grossMargin(
          db,
          { organizationId: org, branchId: branch },
          {
            from: new Date(day + 'T00:00:00Z'),
            to: new Date('2026-11-25T00:00:00Z'),
            by: 'product',
          }
        );
        const expected = ledger[0]!;
        expect(marginMinor).toBe(360);
        expect(report.rows).toHaveLength(1);
        const row = report.rows[0]!;
        const profit = REPORT_CHARTS.Profit.some((id) => id === chart);
        if (profit) {
          const posted = await ledgerCurrencies(
            db,
            { organizationId: org, branchId: branch },
            {
              from: new Date(day),
              to: new Date('2026-11-25'),
              accountCodes: ['SALES_REVENUE', 'SALES_DISCOUNT', 'COST_OF_GOODS_SOLD'],
            }
          );
          expect(report.postedCurrencies).toEqual(posted);
          expect(row.amount).toBe(expected.grossMarginMinor);
          expect(row.base).toBe(expected.revenueMinor - expected.discountMinor);
          expect(row.excluded).toBe(1);
          if (chart === 'topMargin' || chart === 'bottomMargin') expect(row.key).toBe(medicine);
        } else if (chart === 'returnMedicine') {
          const returned = await db.pharmacySaleReturnLine.aggregate({
            where: { branchId: branch },
            _sum: { canonicalUnits: true },
          });
          expect(row).toMatchObject({ key: medicine, value: returned._sum.canonicalUnits });
        } else if (chart === 'physicalReason') {
          const units = await db.pharmacySaleReturnLine.aggregate({
            where: { branchId: branch, saleReturn: { reason: 'Wrong pack' } },
            _sum: { canonicalUnits: true },
          });
          expect(row).toMatchObject({ key: 'Wrong pack', value: units._sum.canonicalUnits });
        } else if (chart === 'salesPayment') {
          const tenders = await db.pharmacyTender.findMany({
            where: { branchId: branch, businessDate: new Date(day) },
          });
          const shift = computeCashShiftFigures({
            openingFloatMinor: 0,
            tenders,
            refunds: [],
            movements: [],
          });
          expect(row).toMatchObject({
            key: shift.tenders[0]!.type,
            value: shift.tenders[0]!.amountMinor,
          });
        } else if (chart === 'returnRate') {
          expect(row.value).toBe(reportRatePercent(refundsMinor!, salesMinor!));
        } else if (chart === 'returnReason' || chart === 'returnsDay') {
          expect(row.value).toBe(refundsMinor);
          if (chart === 'returnsDay') expect(row.base).toBe(salesMinor);
        } else {
          expect(row.value).toBe(salesMinor);
          const keys = {
            salesDay: day,
            salesHour: '17:00',
            salesWeekday: '2',
            salesCategory: 'Pharmaceutical',
            salesCashier: 'sample-cashier',
          };
          expect(row.key).toBe(keys[chart as keyof typeof keys]);
        }
        const details = await readVisualChart(db, branches, 'Asia/Karachi', {
          chart,
          preset: 'custom',
          custom,
          bucket: row.key,
        });
        expect(details.rows.reduce((sum, line) => sum + line.amount, 0)).toBe(row.amount);
        expect(details.rows.reduce((sum, line) => sum + line.base, 0)).toBe(row.base);
        const prior = await readVisualChart(db, branches, 'Asia/Karachi', {
          chart,
          preset: 'custom',
          custom,
          previous: true,
        });
        expect(prior.rows).toEqual([]);
      });
    }
  );
});
