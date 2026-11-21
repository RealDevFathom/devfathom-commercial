// @vitest-environment node
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const runtimeUrl = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.M8_TEST_OWNER_DATABASE_URL;
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
const describeDb = runtimeUrl && ownerUrl ? describe : describe.skip;
const suffix = randomBytes(5).toString('hex');
const organizationId = `org_fin02_${suffix}`;
const branchId = `branch_fin02_${suffix}`;
const actorId = `accountant_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  bookkeeping: typeof import('./bookkeeping');
  tax: typeof import('./tax-profiles');
};
let deps: Deps;
const inTenant = <T>(work: (db: ScopedDb) => Promise<T>) => deps.withTenantDb(organizationId, work);
const scope = { organizationId, branchId, actorId };

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  const [scoped, bookkeeping, tax, guard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./bookkeeping'),
    import('./tax-profiles'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scoped.withTenantDb, bookkeeping, tax };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(`SET app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$2,'Finance fixture','Finance fixture','ACTIVE','SHARED',now(),now())`,
      [organizationId, `finance-${suffix}`]
    );
    await owner.query(
      `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","createdAt","updatedAt") VALUES ($1,$2,$3,'Main pharmacy','1 Test Road','Lahore','PB',now(),now())`,
      [branchId, organizationId, `FIN-${suffix}`]
    );
  } finally {
    await owner.end();
  }
}, 120_000);

describeDb('FIN-02 bookkeeper acceptance', () => {
  it('keeps partial allocations reconciled when one payment is reversed', async () => {
    await inTenant(async (db) => {
      const first = await db.$transaction((tx) =>
        deps.bookkeeping.postBookkeepingTransaction(tx as ScopedDb, scope, {
          reference: `PAY-1-${suffix}`,
          kind: 'SUPPLIER_PAYMENT',
          amountMinor: 6_000,
          occurredAt: new Date('2026-08-10T10:00:00Z'),
          idempotencyKey: `pay-1-${suffix}`,
          allocations: [
            {
              sourceKind: 'PURCHASE_INVOICE',
              sourceId: 'invoice-1',
              sourceReference: 'INV-100',
              amountMinor: 6_000,
            },
          ],
        })
      );
      await db.$transaction((tx) =>
        deps.bookkeeping.postBookkeepingTransaction(tx as ScopedDb, scope, {
          reference: `PAY-2-${suffix}`,
          kind: 'SUPPLIER_PAYMENT',
          amountMinor: 4_000,
          occurredAt: new Date('2026-08-11T10:00:00Z'),
          idempotencyKey: `pay-2-${suffix}`,
          allocations: [
            {
              sourceKind: 'PURCHASE_INVOICE',
              sourceId: 'invoice-1',
              sourceReference: 'INV-100',
              amountMinor: 4_000,
            },
          ],
        })
      );
      const bankLine = await db.pharmacyBankStatementLine.create({
        data: {
          organizationId,
          branchId,
          statementRef: 'AUG-26',
          lineReference: 'BANK-1',
          bookedAt: new Date('2026-08-10T10:00:00Z'),
          amountMinor: -6_000,
          description: 'Supplier payment',
        },
      });
      await deps.bookkeeping.reconcileBankLine(db, scope, {
        statementLineId: bankLine.id,
        transactionId: first.id,
        amountMinor: 6_000,
      });
      await db.$transaction((tx) =>
        deps.bookkeeping.reverseBookkeepingTransaction(tx as ScopedDb, scope, {
          transactionId: first.id,
          at: new Date('2026-08-12T10:00:00Z'),
          reason: 'Cheque returned',
          idempotencyKey: `reverse-${suffix}`,
        })
      );

      const activeAllocated = await db.pharmacyBookkeepingAllocation.aggregate({
        where: { organizationId, sourceId: 'invoice-1', transaction: { status: 'POSTED' } },
        _sum: { amountMinor: true },
      });
      expect(activeAllocated._sum.amountMinor).toBe(4_000);
      expect(
        await db.pharmacyBankStatementLine.findUniqueOrThrow({ where: { id: bankLine.id } })
      ).toMatchObject({ status: 'REVERSED' });
      expect(
        await db.pharmacyBankReconciliation.findFirstOrThrow({
          where: { organizationId, transactionId: first.id },
        })
      ).toMatchObject({ reversalReason: 'Cheque returned' });
      const journal = await db.financeJournalEntry.findMany({
        where: { organizationId, sourceId: first.id },
        include: { lines: true },
      });
      expect(journal).toHaveLength(2);
      const signed = journal
        .flatMap((entry) => entry.lines)
        .reduce(
          (sum, line) => sum + (line.side === 'DEBIT' ? line.amountMinor : -line.amountMinor),
          0
        );
      expect(signed).toBe(0);
    });
  });

  it('refuses postings inside a closed period and permits them after controlled reopen', async () => {
    await inTenant(async (db) => {
      const period = await deps.bookkeeping.closeAccountingPeriod(db, scope, {
        startsAt: new Date('2026-09-01T00:00:00Z'),
        endsAt: new Date('2026-10-01T00:00:00Z'),
      });
      const post = () =>
        db.$transaction((tx) =>
          deps.bookkeeping.postBookkeepingTransaction(tx as ScopedDb, scope, {
            reference: `EXP-${suffix}`,
            kind: 'EXPENSE',
            amountMinor: 500,
            occurredAt: new Date('2026-09-10T10:00:00Z'),
            idempotencyKey: `expense-${suffix}`,
          })
        );
      await expect(post()).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
      await deps.bookkeeping.reopenAccountingPeriod(db, scope, {
        periodId: period.id,
        reason: 'Approved correction',
      });
      await expect(post()).resolves.toMatchObject({ status: 'POSTED' });
    });
  });
});

describeDb('accounting period boundaries', () => {
  it('closes up to the following approved 05:00 start, including 00:30 Karachi', async () => {
    await inTenant(async (db) => {
      const following = await deps.bookkeeping.closeAccountingPeriod(db, scope, {
        startsAt: new Date('2017-06-01T00:00Z'),
        endsAt: new Date('2017-07-01T00:00Z'),
      });
      const previous = await deps.bookkeeping.closeAccountingPeriod(
        db,
        scope,
        { startsAt: '2017-05-01', endsAt: '2017-06-01' },
        'Asia/Karachi'
      );
      expect(previous.endsAt).toEqual(following.startsAt);
      expect(previous.endsAt.getTime()).toBeGreaterThan(
        new Date('2017-06-01T00:30:00+05:00').getTime()
      );
      expect(previous.startsAt).toEqual(new Date('2017-04-30T19:00Z'));
    });
  });
  it('closes a new Karachi period at midnight and keeps the previous approved end', async () => {
    await inTenant(async (db) => {
      const old = await deps.bookkeeping.closeAccountingPeriod(db, scope, {
        startsAt: new Date('2018-12-01T00:00Z'),
        endsAt: new Date('2019-01-01T00:00Z'),
      });
      const current = await deps.bookkeeping.closeAccountingPeriod(
        db,
        scope,
        { startsAt: '2019-01-01', endsAt: '2019-02-01' },
        'Asia/Karachi'
      );
      const next = await deps.bookkeeping.closeAccountingPeriod(
        db,
        scope,
        { startsAt: '2019-02-01', endsAt: '2019-03-01' },
        'Asia/Karachi'
      );
      expect(current.startsAt).toEqual(old.endsAt);
      expect(current.endsAt).toEqual(new Date('2019-01-31T19:00Z'));
      expect(next.startsAt).toEqual(current.endsAt);
      expect(next.startsAt <= new Date('2019-02-01T00:30:00+05:00')).toBe(true);
    });
  });
});
describeDb('FIN-04 tax profile versioning', () => {
  it.each([
    ['legacy', new Date('2024-01-01T00:00:00Z'), '2024-01-01', '2024-01-01T00:00:00.000Z'],
    ['local', '2025-01-01', '2025-01-01', '2024-12-31T19:00:00.000Z'],
  ] as const)(
    'joins a %s expiry to its replacement on the Karachi clock',
    async (kind, oldEnd, day, expected) => {
      await inTenant(async (db) => {
        const zone = 'Asia/Karachi';
        const branch = await db.pharmacyBranch.create({
          data: {
            organizationId,
            name: 'Cutover',
            code: kind,
            city: 'Karachi',
            provinceCode: 'SD',
            addressLine: 'Fixture',
          },
        });
        const cutoverScope = { ...scope, branchId: branch.id };
        const common = {
          name: 'Fixture profile',
          approvalReference: 'Fixture accountant',
          rules: [
            {
              productClass: 'MEDICINE' as const,
              pctHsCode: '3004',
              priceMode: 'INCLUSIVE' as const,
              rate: '0.10',
            },
          ],
        };
        const first = await deps.tax.publishPharmacyTaxProfile(
          db,
          cutoverScope,
          {
            ...common,
            effectiveFrom: kind === 'legacy' ? new Date('2023-12-01T00:00:00Z') : '2024-12-01',
            effectiveTo: oldEnd,
            idempotencyKey: kind + '-prior',
          },
          zone
        );
        const second = await deps.tax.publishPharmacyTaxProfile(
          db,
          cutoverScope,
          {
            ...common,
            effectiveFrom: day,
            effectiveTo: day.slice(0, 4) + '-02-01',
            idempotencyKey: kind + '-successor',
          },
          zone
        );
        expect(first.effectiveTo?.toISOString()).toBe(expected);
        expect(second.effectiveFrom.toISOString()).toBe(expected);
        expect(second.effectiveTo?.toISOString()).toBe(day.slice(0, 4) + '-01-31T19:00:00.000Z');
        const at = new Date(day + 'T00:30:00+05:00');
        const tax = await deps.tax.calculatePharmacyTax(db, {
          organizationId,
          branchId: branch.id,
          at,
          productClass: 'MEDICINE',
          pctHsCode: '3004',
          consideration: '110.00',
        });
        expect(tax.profileVersionId).toBe(kind === 'legacy' ? first.id : second.id);
      });
    }
  );

  it('publishes up to the following legacy start and charges the earlier profile at 00:30 Karachi', async () => {
    await inTenant(async (db) => {
      const zone = 'Asia/Karachi';
      const branch = await db.pharmacyBranch.create({
        data: {
          organizationId,
          name: 'Predecessor',
          code: 'predecessor',
          city: 'Karachi',
          provinceCode: 'SD',
          addressLine: 'Fixture',
        },
      });
      const cutoverScope = { ...scope, branchId: branch.id };
      const common = {
        name: 'Predecessor fixture',
        approvalReference: 'Approved',
        rules: [
          {
            productClass: 'MEDICINE' as const,
            pctHsCode: '3004',
            priceMode: 'INCLUSIVE' as const,
            rate: '0.10',
          },
        ],
      };
      const following = await deps.tax.publishPharmacyTaxProfile(
        db,
        cutoverScope,
        {
          ...common,
          effectiveFrom: new Date('2017-06-01T00:00Z'),
          effectiveTo: new Date('2017-07-01T00:00Z'),
          idempotencyKey: 'legacy-following',
        },
        zone
      );
      const previous = await deps.tax.publishPharmacyTaxProfile(
        db,
        cutoverScope,
        {
          ...common,
          effectiveFrom: '2017-05-01',
          effectiveTo: '2017-06-01',
          idempotencyKey: 'new-predecessor',
        },
        zone
      );
      expect(previous.effectiveTo).toEqual(following.effectiveFrom);
      for (const [at, id] of [
        ['2017-06-01T00:30:00+05:00', previous.id],
        ['2017-06-01T05:00:00+05:00', following.id],
      ] as const) {
        const tax = await deps.tax.calculatePharmacyTax(db, {
          ...cutoverScope,
          at: new Date(at),
          productClass: 'MEDICINE',
          pctHsCode: '3004',
          consideration: '110.00',
        });
        expect(tax.profileVersionId).toBe(id);
      }
    });
  });

  it('selects effective approved versions and applies shared inclusive rounding', async () => {
    await inTenant(async (db) => {
      const first = await db.$transaction((tx) =>
        deps.tax.publishPharmacyTaxProfile(tx as ScopedDb, scope, {
          name: '2026 medicine tax',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          effectiveTo: new Date('2027-01-01T00:00:00Z'),
          approvalReference: 'ACCOUNTANT-1',
          idempotencyKey: `tax-1-${suffix}`,
          rules: [
            {
              productClass: 'MEDICINE',
              pctHsCode: '3004',
              sroReference: 'SRO-PROVISIONAL-1',
              priceMode: 'INCLUSIVE',
              rate: '0.10',
            },
          ],
        })
      );
      const second = await db.$transaction((tx) =>
        deps.tax.publishPharmacyTaxProfile(tx as ScopedDb, scope, {
          name: '2027 medicine tax',
          effectiveFrom: new Date('2027-01-01T00:00:00Z'),
          approvalReference: 'ACCOUNTANT-2',
          idempotencyKey: `tax-2-${suffix}`,
          rules: [
            { productClass: 'MEDICINE', pctHsCode: '3004', priceMode: 'EXCLUSIVE', rate: '0.18' },
          ],
        })
      );
      expect([first.versionNumber, second.versionNumber]).toEqual([1, 2]);
      const result = await deps.tax.calculatePharmacyTax(db, {
        organizationId,
        branchId,
        at: new Date('2026-06-01T00:00:00Z'),
        productClass: 'MEDICINE',
        pctHsCode: '3004',
        consideration: '110.00',
      });
      expect(result.profileVersionId).toBe(first.id);
      expect(result.net.toString()).toBe('100');
      expect(result.tax.toString()).toBe('10');
      await expect(
        db.pharmacyTaxProfileVersion.update({
          where: { id: first.id },
          data: { name: 'rewritten' },
        })
      ).rejects.toThrow(/PHARMACY_TAX_PROFILE_PUBLISHED_IMMUTABLE/);
    });
  });
});

describeDb('CEO-JVCORE-20261025 common ledger lock', () => {
  it('makes a post wait for a concurrent close and then honour the closed period', async () => {
    let releaseClose!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      closeLocked = resolve;
    });
    const closing = deps.withTenantDb(
      organizationId,
      async (db) => {
        const period = await deps.bookkeeping.closeAccountingPeriod(db, scope, {
          startsAt: new Date('2024-02-01T00:00:00Z'),
          endsAt: new Date('2024-03-01T00:00:00Z'),
        });
        closeLocked();
        await gate;
        return period;
      },
      { timeout: 30_000 }
    );
    await locked;
    let postSettled = false;
    const posting = deps
      .withTenantDb(
        organizationId,
        (db) =>
          deps.bookkeeping.postBookkeepingTransaction(db, scope, {
            reference: `LOCK-${suffix}`,
            kind: 'EXPENSE',
            amountMinor: 700,
            occurredAt: new Date('2024-02-10T10:00:00Z'),
            idempotencyKey: `lock-${suffix}`,
          }),
        { timeout: 30_000 }
      )
      .finally(() => {
        postSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(postSettled).toBe(false);
    releaseClose();
    await closing;
    await expect(posting).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
  }, 60_000);
});
