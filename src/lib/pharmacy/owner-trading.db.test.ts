/** Run on the local migrated pharmacy test database as the restricted runtime role. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { dashboardPeriods, readOwnerTrading, type TradingSection } from './owner-trading';
import { aggregateTenderTotals } from './manual-payments';
import { readKhataAgingMinor, readPharmacyOwnerCommandCentre } from './reports';
import { receiveLot } from './stock-ledger';
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
      const expiresAt = new Date(Date.now() + 10 * 86400000);
      await db.pharmacyManufacturingBatch.create({
        data: {
          id: org,
          organizationId: org,
          medicineId: org,
          batchNumber: 'Synthetic',
          expiresAt,
        },
      });
      await db.pharmacyStockLocation.create({
        data: {
          id: org,
          organizationId: org,
          branchId: id,
          code: 'Main',
          name: 'Store',
          kind: 'STORE',
        },
      });
      await receiveLot(
        db,
        { organizationId: org, branchId: id, actorId: 'fixture' },
        {
          manufacturingBatchId: org,
          packLevelId: org,
          stockLocationId: org,
          unitsPerPack: 1,
          supplierName: 'Synthetic',
          supplierInvoiceRef: org,
          unitCostMinor: 100,
          printedMrpMinor: 500,
          receivedExpiresAt: expiresAt,
          receivedExpiryPrecision: 'DAY',
          quantityUnits: 12,
          idempotencyKey: org,
          receivedAt: at,
        }
      );
      const { postJournalEntry } = await import('@/lib/finance/journal');
      await postJournalEntry(
        db,
        { organizationId: org, actorId: 'synthetic' },
        {
          sourceKind: 'PHARMACY_SALE_LINE',
          sourceId: org,
          description: 'Synthetic sale',
          occurredAt: at,
          idempotencyKey: org,
          branchId: id,
          lines: [
            { accountCode: 'CASH', side: 'DEBIT', amountMinor: 925, branchId: id, productId: org },
            {
              accountCode: 'SALES_REVENUE',
              side: 'CREDIT',
              amountMinor: 925,
              branchId: id,
              productId: org,
            },
          ],
        }
      );
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
  it('reads the cumulative 30-, 60- and 90-day expiry chart directly from the report balances', async () => {
    const [rows, result] = await Promise.all([read('expiry'), report()]);
    expect(rows).toEqual([
      { label: '30 days', value: result.metrics.expiryValueMinor30 },
      { label: '60 days', value: result.metrics.expiryValueMinor60 },
      { label: '90 days', value: result.metrics.expiryValueMinor90 },
    ]);
    expect(rows[0]!.value).toBeGreaterThan(0);
  });
  it('keeps a late-closing branch on its own day in the dashboard report widgets', async () => {
    const clock = new Date('2026-10-09T21:00:00Z');
    const current = await scoped.withTenantDb(org, (db) =>
      readPharmacyOwnerCommandCentre(
        db,
        {
          branchIds: [id],
          from: '2026-10-10',
          to: '2026-10-10',
          timeZone: 'Asia/Karachi',
          dayEnds: { [id]: [{ from: '2020-01-01', hour: 4 }] },
        },
        clock
      )
    );
    expect(current.metrics.salesMinor).toBe((await report()).metrics.salesMinor);
    expect(current.metrics.salesMinor).toBe(925);
  });
  it('starts hourly sales at the day-end in force for the branch and aligns mixed schedules by opening hour', async () => {
    const late = { id, name: 'Main', businessDayEndsAtHistory: [{ from: '2020-01-01', hour: 4 }] };
    const forBranches = (branches: Parameters<typeof dashboardPeriods>[0]) =>
      scoped.withTenantDb(org, (db) =>
        readOwnerTrading(db, org, dashboardPeriods(branches, 'Asia/Karachi', at), 'hours', true)
      );
    const one = await forBranches([late]);
    expect(one[0]!.label).toBe('04:00');
    expect(one[23]!.label).toBe('03:00');
    expect(one[13]).toEqual({ label: '17:00', value: 925 });
    const mixed = await forBranches([late, { id: id + '_second', name: 'Second' }]);
    expect(mixed[0]!.label).toBe('Opening hour');
    expect(mixed[13]).toEqual({ label: '+13 h', value: 925 });
  });
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
  it('keeps the report lot and balance in the same branch across a two-branch stock valuation', async () => {
    const { onHandValueQuery, branchStockValueMinor } = await import('./migration/parallel-run');
    const second = id + '_second';
    await scoped.withTenantDb(org, async (db) => {
      await db.pharmacyBranch.create({
        data: {
          id: second,
          organizationId: org,
          code: 'SECOND',
          name: 'Second',
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: { organizationId: org, branchId: second, code: 'Main', name: 'Store', kind: 'STORE' },
      });
      const batch = await db.pharmacyManufacturingBatch.findUniqueOrThrow({ where: { id: org } });
      await receiveLot(
        db,
        { organizationId: org, branchId: second, actorId: 'fixture' },
        {
          manufacturingBatchId: org,
          packLevelId: org,
          stockLocationId: location.id,
          unitsPerPack: 1,
          supplierName: 'Synthetic',
          supplierInvoiceRef: second,
          unitCostMinor: 50,
          printedMrpMinor: 500,
          receivedExpiresAt: batch.expiresAt!,
          receivedExpiryPrecision: 'DAY',
          quantityUnits: 2,
          idempotencyKey: second,
          receivedAt: at,
        }
      );
      expect(await branchStockValueMinor(db, { organizationId: org, branchId: second })).toBe(
        BigInt(100)
      );
      expect(await branchStockValueMinor(db, { organizationId: org, branchId: id })).toBe(
        BigInt(1200)
      );
      const combined = onHandValueQuery(org, [id, second]);
      expect(combined.sql).toMatch(/lot\."branchId"\s*=\s*b\."branchId"/);
      expect(await db.$queryRaw(combined)).toEqual([{ value: BigInt(1300) }]);
    });
  });
  it('returns bill counts alone for an operational dashboard', async () => {
    expect(await read('summary', false)).toEqual([
      { label: 'Bills', value: 1, previous: 0, count: true },
    ]);
    expect(await read('profits', false)).toEqual([]);
  });

  it('finishes at the current on-hand valuation report and includes all 30 business days', async () => {
    const { branchStockValueMinor } = await import('./migration/parallel-run');
    const [report, points] = await scoped.withTenantDb(org, async (db) =>
      Promise.all([
        branchStockValueMinor(db, { organizationId: org, branchId: id }),
        readOwnerTrading(db, org, periods, 'stock', true),
      ])
    );
    expect(points).toHaveLength(30);
    expect(report).toBe(BigInt(1200));
    expect(points.at(-2)?.value).toBe(0);
    expect(points.at(-1)?.value).toBe(Number(report));
  });
  it('indexes the business-date and movement-time ranges used on each load', async () => {
    const indexes = await scoped.withTenantDb(
      org,
      (db) =>
        db.$queryRaw<
          { indexname: string }[]
        >`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('pharmacy_dashboard_sale_days','pharmacy_dashboard_stock_days')`
    );
    expect(indexes.map((i) => i.indexname).sort()).toEqual([
      'pharmacy_dashboard_sale_days',
      'pharmacy_dashboard_stock_days',
    ]);
  });

  it('matches supplier report amounts, overdue portion and bills due before Sunday', async () => {
    const { readSupplierPosition } = await import('./owner-watch');
    const { readApAging } = await import('./accounts/ap-aging');
    const { recordApInvoice } = await import('./accounts/ap-invoices');
    const { computeDueBillReminders } = await import('./accounts/ap-payables-drafts');
    await scoped.withTenantDb(org, async (db) => {
      const scope = { organizationId: org, branchId: id, actorId: 'synthetic' };
      for (const [dueDate, amountMinor] of [
        ['2026-10-05', 1250],
        ['2026-10-11', 3400],
        ['2026-10-12', 1000],
      ] as const) {
        await recordApInvoice(
          db,
          scope,
          {
            branchId: id,
            createKey: randomUUID(),
            reference: dueDate,
            payeeName: 'Synthetic supplier',
            supplierInvoiceRef: dueDate,
            invoiceDate: '2026-10-01',
            dueDate,
            amountMinor,
            currency: 'PKR',
            description: 'Synthetic invoice',
            evidenceReference: 'Fixture',
          },
          at
        );
      }
      const report = await readApAging(db, scope, periods[0]!.today, at, 'Asia/Karachi');
      const result = await readSupplierPosition(db, org, periods, at);
      expect(result.balances).toEqual([{ currency: 'PKR', total: 5650, overdue: 1250 }]);
      expect(result.balances[0]!.total).toBe(report.totals[0]!.TOTAL);
      expect(result.balances[0]!.overdue).toBe(report.totals[0]!.DAYS_1_30);
      expect(result.due).toBe(computeDueBillReminders(report, 2)[0]!.dueSoonCount);
    });
  });

  it('matches the customer ledger and its overdue report, restoring the branch', async () => {
    const { readCustomerPosition } = await import('./owner-watch');
    const { listKhataLedger } = await import('./family-khata');
    await scoped.withTenantDb(org, async (db) => {
      const scope = { organizationId: org, branchId: id, actorId: 'synthetic' };
      await db.$queryRaw`SELECT set_config('app.current_branch_id',${id},true)`;
      const patient = await db.pharmacyPatient.create({
        data: { organizationId: org, displayName: 'Synthetic patient' },
      });
      const customer = await db.pharmacyCustomer.create({
        data: { organizationId: org, patientId: patient.id, displayName: 'Synthetic customer' },
      });
      const family = await db.pharmacyFamilyAccount.create({
        data: {
          organizationId: org,
          branchId: id,
          payerCustomerId: customer.id,
          displayName: 'Synthetic family',
          creditLimitMinor: 5000,
        },
      });
      const member = await db.pharmacyFamilyMember.create({
        data: {
          organizationId: org,
          branchId: id,
          familyAccountId: family.id,
          customerId: customer.id,
        },
      });
      await db.pharmacyKhataEvent.create({
        data: {
          ...scope,
          kind: 'CHARGE',
          familyAccountId: family.id,
          memberId: member.id,
          amountMinor: 1200,
          dueAt: new Date('2026-09-01'),
        },
      });
      expect(await readKhataAgingMinor(db, [id], 0)).toBeNull();
      expect(await readKhataAgingMinor(db, [id], 1)).toBe(1200);
      const ledger = await listKhataLedger(db, scope, at);
      const command = await readPharmacyOwnerCommandCentre(db, {
        branchIds: [id],
        from: '2026-10-09',
        to: '2026-10-09',
      });
      await db.$queryRaw`SELECT set_config('app.current_branch_id','',true)`;
      const result = await readCustomerPosition(db, org, periods, scope.actorId, at);
      expect(result?.total).toBe(ledger.accounts[0]!.balanceMinor);
      expect(result?.overdue).toBe(command.metrics.khataAgingMinor);
      expect(result?.count).toBe(
        ledger.accounts.filter((a) => a.balanceMinor > 0 && a.oldestOverdueAt).length
      );
      expect(result).toEqual({ total: 1200, overdue: 1200, count: 1 });
      expect(
        await db.$queryRaw`SELECT current_setting('app.current_branch_id',true) AS id`
      ).toEqual([{ id: '' }]);
    });
  });
  it('matches the unresolved queues and stock role dashboard for the same active branch', async () => {
    const { readOpenWork } = await import('./owner-watch');
    const { roleDashboard } = await import('./stock-signals-operations');
    const { countOpenCardTerminalAttempts } = await import('./card-terminal/open-attempts');
    const { listPurchaseOrders } = await import('./purchasing-console');
    await scoped.withTenantDb(org, async (db) => {
      const scope = { organizationId: org, branchId: id, actorId: 'synthetic' };
      for (const kind of ['LOW_STOCK', 'NEAR_EXPIRY'] as const)
        await db.pharmacyStockSignal.create({
          data: {
            organizationId: org,
            branchId: id,
            kind,
            dedupKey: kind,
            medicineId: org,
            cause: 'synthetic',
            ownerUserId: 'fixture',
            dueAt: at,
            explanation: 'Synthetic alert',
            dataWindowStart: at,
            dataWindowEnd: at,
            sourceObservedAt: at,
            freshnessSeconds: 3600,
            confidence: 'EXACT',
            neededUnits: 1,
            onHandUnits: 1,
            inboundUnits: 0,
            computedAt: at,
          },
        });
      const result = await readOpenWork(
        db,
        scope,
        periods,
        {
          inventory: true,
          counter: true,
          purchasing: true,
          controlled: false,
          includeUnscoped: false,
        },
        at
      );
      const values = Object.fromEntries(result.map((row) => [row.label, row.value]));
      const signals = await roleDashboard(db, scope, at);
      expect(values['Low stock']).toBe(signals.find((s) => s.kind === 'LOW_STOCK')!.open);
      expect(values['Expiring soon']).toBe(signals.find((s) => s.kind === 'NEAR_EXPIRY')!.open);
      expect(values['Approvals waiting']).toBe(
        (
          await listPurchaseOrders(db, {
            organizationId: org,
            branchIds: [id],
            includeUnscoped: false,
          })
        ).filter((r) => r.status === 'SUBMITTED').length
      );
      expect(values['Card payments unresolved']).toBe(
        await countOpenCardTerminalAttempts(db, scope, new Date(periods[0]!.today))
      );
      expect(values['Drawers or shifts still open']).toBe(
        await db.pharmacyDrawerSession.count({
          where: { organizationId: org, branchId: id, status: 'OPEN' },
        })
      );
    });
  });
  it('counts the same waiting controlled entries as the owner’s supplier return register', async () => {
    const { countLegacySupplierDispatches, legacySupplierDispatches } =
      await import('./supplier-returns-operations');
    await scoped.withTenantDb(org, async (db) => {
      await db.organizationDepartment.create({
        data: { organizationId: org, key: 'Pharmacy', name: 'Pharmacy' },
      });
      const role = await db.organizationRole.create({
        data: { organizationId: org, key: 'owner', name: 'Owner', isSystem: true },
      });
      const owner = await db.user.create({
        data: {
          organizationId: org,
          organizationRoleId: role.id,
          email: 'owner@example.test',
          name: 'Synthetic owner',
          department: 'Pharmacy',
          title: 'Owner',
          role: 'ADMIN',
          status: 'ACTIVE',
        },
      });
      const scope = { organizationId: org, branchId: id, actorId: owner.id };
      const page = await legacySupplierDispatches(db, scope);
      expect(page).not.toBeNull();
      expect(await countLegacySupplierDispatches(db, scope)).toBe(page!.rows.length);
      expect(
        await countLegacySupplierDispatches(db, { ...scope, actorId: 'unassigned' })
      ).toBeNull();
    });
  });
  it('preserves outstanding card attempts across a business-day boundary', async () => {
    const { readOpenWork } = await import('./owner-watch');
    const { countOpenCardTerminalAttempts } = await import('./card-terminal/open-attempts');
    await scoped.withTenantDb(org, async (db) => {
      const scope = { organizationId: org, branchId: id, actorId: 'synthetic' };
      const yesterday = new Date('2026-10-08');
      const sale = await db.pharmacySale.create({
        data: {
          organizationId: org,
          branchId: id,
          businessDate: yesterday,
          createdByUserId: 'synthetic',
        },
      });
      await db.pharmacyCardTerminalAttempt.create({
        data: {
          organizationId: org,
          branchId: id,
          saleId: sale.id,
          deviceId: 'synthetic',
          terminalId: 'desk',
          provider: 'QA_DEVICE',
          attemptKey: randomUUID(),
          amountMinor: 100,
          currency: 'PKR',
          businessDate: yesterday,
          actorId: 'synthetic',
        },
      });
      const rows = await readOpenWork(
        db,
        scope,
        periods,
        {
          inventory: false,
          counter: true,
          purchasing: false,
          controlled: false,
          includeUnscoped: false,
        },
        at
      );
      const oldDay = await countOpenCardTerminalAttempts(db, scope, yesterday);
      expect(oldDay).toBe(1);
      expect(rows.find((r) => r.label === 'Card payments unresolved')?.value).toBe(oldDay);
    });
  });
  it('reconciles a second branch bill discount and partial refund with the same single- and whole-business reports', async () => {
    const second = id + '_discount';
    await scoped.withTenantDb(org, async (db) => {
      await db.pharmacyBranch.create({
        data: {
          id: second,
          organizationId: org,
          code: 'DISC',
          name: 'Discount',
          addressLine: 'Synthetic',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
      const day = new Date(periods[0]!.today);
      const sale = await db.pharmacySale.create({
        data: {
          organizationId: org,
          branchId: second,
          status: 'COMPLETED',
          createdByUserId: 'synthetic',
          businessDate: day,
          completedAt: at,
          receiptNumber: 2,
        },
      });
      await db.pharmacySaleLine.create({
        data: {
          organizationId: org,
          branchId: second,
          saleId: sale.id,
          medicineId: org,
          presentationId: org,
          packLevelId: org,
          saleUnit: 'PACK',
          quantity: 2,
          canonicalUnitsPerSaleUnit: 1,
          canonicalUnits: 2,
          unitPriceMinor: 500,
          grossMinor: 1000,
          proRataCeilingMinor: 500,
          unitCostMinor: 100,
          discountMinor: 120,
          billDiscountMinor: 100,
          discountKind: 'DISCOUNT',
          approvalPolicy: 'synthetic',
          approvedByUserId: 'synthetic',
          idempotencyKey: second,
        },
      });
      const tender = await db.pharmacyTender.create({
        data: {
          organizationId: org,
          branchId: second,
          saleId: sale.id,
          type: 'CARD',
          amountMinor: 880,
          businessDate: day,
          actorId: 'synthetic',
          deviceId: 'synthetic',
        },
      });
      await db.pharmacyRefund.create({
        data: {
          organizationId: org,
          branchId: second,
          saleId: sale.id,
          originalTenderId: tender.id,
          amountMinor: 180,
          businessDate: day,
          reason: 'Synthetic partial refund',
          actorId: 'synthetic',
        },
      });
      for (const [ids, sales, refunds, bills] of [
        [[id], 925, 0, 1],
        [[second], 880, 180, 1],
        [[id, second], 1805, 180, 2],
      ] as const) {
        const scope = dashboardPeriods(
          ids.map((id) => ({ id, name: id })),
          'Asia/Karachi',
          at
        );
        const report = await readPharmacyOwnerCommandCentre(db, {
          branchIds: [...ids],
          from: scope[0]!.today,
          to: scope[0]!.today,
          timeZone: 'Asia/Karachi',
        });
        const summary = await readOwnerTrading(db, org, scope, 'summary', true);
        expect(report.metrics).toMatchObject({ salesMinor: sales, refundsMinor: refunds });
        expect(summary.find((p) => p.label === 'Sales')?.value).toBe(report.metrics.salesMinor);
        expect(summary.find((p) => p.label === 'Bills')?.value).toBe(bills);
        expect(summary.find((p) => p.label === 'Average bill')?.value).toBe(
          Math.round(sales / bills)
        );
        expect(
          (await readOwnerTrading(db, org, scope, 'branches', true)).reduce(
            (n, p) => n + (p.value ?? 0),
            0
          )
        ).toBe(report.metrics.salesMinor);
      }
    });
  });
});
