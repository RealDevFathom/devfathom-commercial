// @vitest-environment node
/**
 * DEV-694 — supplier credit-note set-off against PostgreSQL: a staff request
 * moves no money, a manager approval posts one canonical entry and reduces the
 * bill in the AP aging, both ceilings (credit left, bill owed) hold, payment
 * and reversal respect an approved set-off, the immutability trigger and
 * tenant RLS. Skips without a database URL.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const runtimeUrl = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.M8_TEST_OWNER_DATABASE_URL;
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
const describeDb = runtimeUrl && ownerUrl ? describe : describe.skip;
const suffix = randomBytes(5).toString('hex');
const organizationId = `org_so_${suffix}`;
const otherOrganizationId = `org_so_other_${suffix}`;
const branchId = `branch_so_${suffix}`;
const supplierId = `supplier_so_${suffix}`;
const creditId = `credit_so_${suffix}`;
const secondCreditId = `credit_so_b_${suffix}`;
const clerk = { organizationId, branchId, actorId: `clerk_so_${suffix}` };
const manager = { organizationId, branchId, actorId: `manager_so_${suffix}` };
const SUPPLIER = 'Al-Shifa Distributors';

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  setOff: typeof import('./ap-credit-set-off');
  ap: typeof import('./ap-invoices');
  aging: typeof import('./ap-aging');
};
let deps: Deps;
const inTenant = <T>(work: (db: ScopedDb) => Promise<T>, org = organizationId) =>
  deps.withTenantDb(org, work, { timeout: 30_000 });

const day = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  const [scoped, setOff, ap, aging, guard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./ap-credit-set-off'),
    import('./ap-invoices'),
    import('./ap-aging'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scoped.withTenantDb, setOff, ap, aging };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(`SET app.is_platform_admin = 'true'`);
    for (const [org, slug] of [
      [organizationId, `so-${suffix}`],
      [otherOrganizationId, `so-other-${suffix}`],
    ]) {
      await owner.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$2,'Set-off fixture','Set-off fixture','ACTIVE','SHARED',now(),now())`,
        [org, slug]
      );
    }
    await owner.query(
      `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","createdAt","updatedAt") VALUES ($1,$2,$3,'Set-off pharmacy','1 Test Road','Lahore','PB',now(),now())`,
      [branchId, organizationId, `SO-${suffix}`]
    );
    await owner.query(
      `INSERT INTO pharmacy_suppliers (id,"organizationId",name,"createdAt","updatedAt") VALUES ($1,$2,$3,now(),now())`,
      [supplierId, organizationId, SUPPLIER]
    );
    await owner.query(
      `INSERT INTO pharmacy_supplier_credits (id,"organizationId","branchId","supplierId",reference,"amountMinor","receivedAt","recordedByUserId") VALUES ($1,$2,$3,$4,$5,50000,now() - interval '2 days',$6)`,
      [creditId, organizationId, branchId, supplierId, `CN-${suffix}`, clerk.actorId]
    );
    await owner.query(
      `INSERT INTO pharmacy_supplier_credits (id,"organizationId","branchId","supplierId",reference,"amountMinor","receivedAt","recordedByUserId") VALUES ($1,$2,$3,$4,$5,50000,now() - interval '2 days',$6)`,
      [secondCreditId, organizationId, branchId, supplierId, `CN-B-${suffix}`, clerk.actorId]
    );
  } finally {
    await owner.end();
  }
}, 120_000);

async function recordBill(n: number, amountMinor: number, currency: 'PKR' | 'USD' = 'PKR') {
  const result = await inTenant((db) =>
    deps.ap.recordApInvoice(db, clerk, {
      branchId,
      createKey: `so-bill-${suffix}-${n}`,
      reference: `SO-${suffix}-${n}`,
      payeeName: ` al-shifa   DISTRIBUTORS `,
      supplierInvoiceRef: `ASD-${suffix}-${n}`,
      invoiceDate: day(-10),
      dueDate: day(-3),
      amountMinor,
      currency,
      description: 'Supplier bill',
      evidenceReference: `Bill ${n}`,
    })
  );
  return result.invoice;
}

const outstanding = async (invoiceId: string) => {
  const view = await inTenant((db) =>
    deps.aging.readApAging(db, { organizationId, branchId }, day(0))
  );
  return view.rows.find((row) => row.invoiceId === invoiceId);
};

describeDb('AP credit-note set-off', () => {
  it('reduces the payable only after a different manager approves it', async () => {
    const bill = await recordBill(1, 100_000);
    const { setOff } = await inTenant((db) =>
      deps.setOff.requestApCreditSetOff(db, clerk, {
        invoiceId: bill.id,
        supplierCreditId: creditId,
        requestKey: `so-req-${suffix}-1`,
        amountMinor: 30_000,
      })
    );
    expect(setOff).toMatchObject({ status: 'PENDING', journalEntryId: null, currency: 'PKR' });
    expect(await outstanding(bill.id)).toMatchObject({ outstandingMinor: 100_000 });

    // The requester may not approve while another owner-level user could.
    await expect(
      inTenant((db) =>
        deps.setOff.approveApCreditSetOff(
          db,
          clerk,
          { setOffId: setOff.id, decisionKey: `so-ok-${suffix}-self` },
          { soleApprover: async () => false }
        )
      )
    ).rejects.toMatchObject({ reason: 'SELF_APPROVAL' });

    const approved = await inTenant((db) =>
      deps.setOff.approveApCreditSetOff(
        db,
        manager,
        { setOffId: setOff.id, decisionKey: `so-ok-${suffix}-1` },
        { soleApprover: async () => false }
      )
    );
    expect(approved.setOff).toMatchObject({
      status: 'APPROVED',
      decidedByUserId: manager.actorId,
      approvalPolicy: deps.setOff.AP_SET_OFF_SEGREGATED_POLICY,
    });
    const replay = await inTenant((db) =>
      deps.setOff.approveApCreditSetOff(
        db,
        manager,
        { setOffId: setOff.id, decisionKey: `so-ok-${suffix}-1` },
        { soleApprover: async () => false }
      )
    );
    expect(replay).toMatchObject({ replayed: true });

    const entries = await inTenant((db) =>
      db.financeJournalEntry.findMany({
        where: { organizationId, sourceKind: 'PHARMACY_AP_CREDIT_SET_OFF', sourceId: setOff.id },
        include: { lines: true },
      })
    );
    expect(entries).toHaveLength(1);
    expect(
      entries[0]!.lines
        .map((line) => `${line.accountCode}:${line.side}:${line.amountMinor}`)
        .sort()
    ).toEqual(['ACCOUNTS_PAYABLE:DEBIT:30000', 'SUPPLIER_CLAIM_RECEIVABLE:CREDIT:30000']);
    expect(entries[0]!.id).toBe(approved.setOff.journalEntryId);

    expect(await outstanding(bill.id)).toMatchObject({
      paidMinor: 0,
      setOffMinor: 30_000,
      outstandingMinor: 70_000,
    });
    // A payment cannot settle what the set-off already cleared.
    await expect(
      inTenant((db) =>
        deps.ap.payApInvoice(db, manager, {
          branchId,
          invoiceId: bill.id,
          commandKey: `so-pay-${suffix}-1`,
          reference: `PV-${suffix}-1`,
          amountMinor: 70_001,
          paidAt: new Date().toISOString(),
          fundingAccount: 'CASH',
        })
      )
    ).rejects.toMatchObject({ reason: 'OVERPAYMENT' });
    // Nor can the bill be reversed from under the set-off.
    await expect(
      inTenant((db) =>
        deps.ap.reverseApInvoice(db, manager, {
          branchId,
          invoiceId: bill.id,
          commandKey: `so-rev-${suffix}-1`,
          reason: 'Duplicate',
          at: new Date().toISOString(),
        })
      )
    ).rejects.toMatchObject({ reason: 'ACTIVE_SETTLEMENTS' });
  }, 60_000);

  it('never spends more than is left on the credit, counting pending requests', async () => {
    const bill = await recordBill(2, 100_000);
    // 50,000 credit less 30,000 approved above leaves 20,000.
    await expect(
      inTenant((db) =>
        deps.setOff.requestApCreditSetOff(db, clerk, {
          invoiceId: bill.id,
          supplierCreditId: creditId,
          requestKey: `so-req-${suffix}-2a`,
          amountMinor: 20_001,
        })
      )
    ).rejects.toMatchObject({ reason: 'SET_OFF_EXCEEDS_CREDIT' });
    const first = await inTenant((db) =>
      deps.setOff.requestApCreditSetOff(db, clerk, {
        invoiceId: bill.id,
        supplierCreditId: creditId,
        requestKey: `so-req-${suffix}-2b`,
        amountMinor: 15_000,
      })
    );
    await expect(
      inTenant((db) =>
        deps.setOff.requestApCreditSetOff(db, clerk, {
          invoiceId: bill.id,
          supplierCreditId: creditId,
          requestKey: `so-req-${suffix}-2c`,
          amountMinor: 5_001,
        })
      )
    ).rejects.toMatchObject({ reason: 'SET_OFF_EXCEEDS_CREDIT' });
    const rejected = await inTenant((db) =>
      deps.setOff.rejectApCreditSetOff(db, manager, {
        setOffId: first.setOff.id,
        decisionKey: `so-no-${suffix}-2b`,
        reason: 'Wrong bill',
      })
    );
    expect(rejected.setOff).toMatchObject({ status: 'REJECTED', journalEntryId: null });
    // A rejected request frees its share and moves no money.
    expect(await outstanding(bill.id)).toMatchObject({ outstandingMinor: 100_000 });
    await expect(
      inTenant((db) =>
        deps.setOff.requestApCreditSetOff(db, clerk, {
          invoiceId: bill.id,
          supplierCreditId: creditId,
          requestKey: `so-req-${suffix}-2d`,
          amountMinor: 20_000,
        })
      )
    ).resolves.toMatchObject({ setOff: { status: 'PENDING' } });
  }, 60_000);

  it('refuses a USD bill or a bill above what it still owes', async () => {
    const usd = await recordBill(3, 10_000, 'USD');
    await expect(
      inTenant((db) =>
        deps.setOff.requestApCreditSetOff(db, clerk, {
          invoiceId: usd.id,
          supplierCreditId: secondCreditId,
          requestKey: `so-req-${suffix}-3`,
          amountMinor: 1_000,
        })
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    const small = await recordBill(4, 1_000);
    await expect(
      inTenant((db) =>
        deps.setOff.requestApCreditSetOff(db, clerk, {
          invoiceId: small.id,
          supplierCreditId: secondCreditId,
          requestKey: `so-req-${suffix}-4`,
          amountMinor: 1_001,
        })
      )
    ).rejects.toMatchObject({ reason: 'SET_OFF_EXCEEDS_BILL' });
  }, 60_000);

  it('freezes decided rows, never deletes them and hides them from other tenants', async () => {
    const approved = await inTenant((db) =>
      db.pharmacyApCreditSetOff.findFirstOrThrow({
        where: { organizationId, status: 'APPROVED' },
      })
    );
    await expect(
      inTenant((db) =>
        db.pharmacyApCreditSetOff.update({
          where: { id: approved.id },
          data: { amountMinor: 1 },
        })
      )
    ).rejects.toThrow();
    await expect(
      inTenant((db) => db.pharmacyApCreditSetOff.delete({ where: { id: approved.id } }))
    ).rejects.toThrow();
    const foreign = await inTenant(
      (db) => db.pharmacyApCreditSetOff.findMany({ where: { id: approved.id } }),
      otherOrganizationId
    );
    expect(foreign).toEqual([]);
  }, 60_000);
});
