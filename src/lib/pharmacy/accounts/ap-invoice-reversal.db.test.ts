// @vitest-environment node
/**
 * DEV-103 — reversing a supplier expense invoice or a payment against PostgreSQL. Recording and
 * paying post through the canonical machinery; reversing a payment posts its mirror through the
 * canonical bookkeeping reversal and the invoice owes that amount again, exactly; an invoice with
 * a payment in force cannot be reversed, and once reversed it leaves the aging while its original
 * entry stays. The recorder may approve only under the solo rule, which counts real owner-level
 * users with an own PIN. Racing reversals apply once, a closed period refuses both, and another
 * tenant cannot see or reverse the entry. Skips without a database URL.
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
const id = (label: string) => `aprev_${label}_${suffix}`;
const organizationId = id('org');
const otherOrganizationId = id('org_other');
const soloOrganizationId = id('org_solo');
const branchId = id('branch');
const closedBranchId = id('branch_closed');
const soloBranchId = id('branch_solo');
const ownerId = id('owner');
const managerId = id('manager');
const cashierId = id('cashier');
const soloOwnerId = id('solo_owner');
const owner = { organizationId, branchId, actorId: ownerId };
const manager = { organizationId, branchId, actorId: managerId };

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  ap: typeof import('./ap-invoices');
  aging: typeof import('./ap-aging');
  approvers: typeof import('./ap-reversal-approvers');
};
let deps: Deps;
const inTenant = <T>(work: (db: ScopedDb) => Promise<T>, org = organizationId) =>
  deps.withTenantDb(org, work, { timeout: 30_000 });
const segregated = { soleApprover: async () => false };

const day = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  const [scoped, ap, aging, approvers, guard, credentials] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./ap-invoices'),
    import('./ap-aging'),
    import('./ap-reversal-approvers'),
    import('@/lib/testing/rls-role-guard'),
    import('@/lib/restaurant/operator-credentials'),
  ]);
  deps = { withTenantDb: scoped.withTenantDb, ap, aging, approvers };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`SET app.is_platform_admin = 'true'`);
    for (const [org, slug] of [
      [organizationId, `aprev-${suffix}`],
      [otherOrganizationId, `aprev-other-${suffix}`],
      [soloOrganizationId, `aprev-solo-${suffix}`],
    ]) {
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$2,'AP reversal fixture','AP reversal fixture','ACTIVE','SHARED',now(),now())`,
        [org, slug]
      );
      await client.query(
        `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
        [`${org}_department`, org]
      );
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'owner','Owner',true,now())`,
        [`${org}_role`, org]
      );
      await client.query(
        `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'*','ALLOW')`,
        [`${org}_perm`, org, `${org}_role`]
      );
    }
    for (const [branch, org, code] of [
      [branchId, organizationId, `AR-${suffix}`],
      [closedBranchId, organizationId, `ARC-${suffix}`],
      [soloBranchId, soloOrganizationId, `ARS-${suffix}`],
    ]) {
      await client.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","createdAt","updatedAt") VALUES ($1,$2,$3,'Reversal pharmacy','1 Test Road','Lahore','PB',now(),now())`,
        [branch, org, code]
      );
    }
    // Two owner-level people with their own PIN in one organization, a cashier with a PIN but
    // no owner role, and an organization with exactly one owner.
    const pinHash = await credentials.hashOperatorCredential('PIN', '2468');
    for (const [user, org, role, roleId] of [
      [ownerId, organizationId, 'ADMIN', `${organizationId}_role`],
      [managerId, organizationId, 'ADMIN', `${organizationId}_role`],
      [cashierId, organizationId, 'EMPLOYEE', null],
      [soloOwnerId, soloOrganizationId, 'ADMIN', `${soloOrganizationId}_role`],
    ] as const) {
      await client.query(
        `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,role,"updatedAt") VALUES ($1,$2,$3,$4,$5,'Pharmacy','Staff',$6,now())`,
        [user, org, roleId, `Person ${user.slice(6, 12)}`, `${user}@ap-reversal.test`, role]
      );
      await client.query(
        `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName",status,"updatedAt") VALUES ($1,$2,$3,'Staff','ACTIVE',now())`,
        [`${user}_staff`, org, user]
      );
      await client.query(
        `INSERT INTO restaurant_operator_credentials (id,"organizationId","staffProfileId",type,"credentialHash","updatedAt") VALUES ($1,$2,$3,'PIN',$4,now())`,
        [`${user}_pin`, org, `${user}_staff`, pinHash]
      );
    }
  } finally {
    await client.end();
  }
}, 120_000);

async function recordBill(
  n: number,
  amountMinor: number,
  scope: { organizationId: string; branchId: string; actorId: string } = owner
) {
  const result = await inTenant(
    (db) =>
      deps.ap.recordApInvoice(db, scope, {
        branchId: scope.branchId,
        createKey: `aprev-bill-${suffix}-${n}`,
        reference: `AR-${suffix}-${n}`,
        payeeName: 'K-Electric',
        supplierInvoiceRef: `KE-${suffix}-${n}`,
        invoiceDate: day(-10),
        dueDate: day(-3),
        amountMinor,
        currency: 'PKR',
        description: 'Electricity',
        evidenceReference: 'Bill scan',
      }),
    scope.organizationId
  );
  return result.invoice;
}

async function pay(
  invoiceId: string,
  n: string,
  amountMinor: number,
  scope: { organizationId: string; branchId: string; actorId: string } = owner
) {
  const result = await inTenant(
    (db) =>
      deps.ap.payApInvoice(db, scope, {
        branchId: scope.branchId,
        invoiceId,
        commandKey: `aprev-pay-${suffix}-${n}`,
        reference: `PV-${suffix}-${n}`,
        amountMinor,
        paidAt: new Date(Date.now() - 3_600_000).toISOString(),
        fundingAccount: 'BANK',
      }),
    scope.organizationId
  );
  return result.settlement;
}

const outstanding = async (invoiceId: string) => {
  const view = await inTenant((db) =>
    deps.aging.readApAging(db, { organizationId, branchId }, day(0))
  );
  return view.rows.find((row) => row.invoiceId === invoiceId);
};

describeDb('DEV-103 AP invoice and payment reversal', () => {
  it('a different manager reverses a payment with its mirror; the invoice owes that amount again exactly', async () => {
    const bill = await recordBill(1, 100_000);
    const payment = await pay(bill.id, '1a', 40_001);
    expect(await outstanding(bill.id)).toMatchObject({
      paidMinor: 40_001,
      outstandingMinor: 59_999,
    });

    const result = await inTenant((db) =>
      deps.ap.reverseApSettlement(
        db,
        manager,
        {
          branchId,
          settlementId: payment.id,
          commandKey: `aprev-rev-pay-${suffix}-1`,
          reason: 'Bank returned the transfer',
        },
        segregated
      )
    );
    expect(result).toMatchObject({ policy: 'PHARMACY_AP_REVERSAL_MANAGER_PIN', replayed: false });
    expect(result.settlement).toMatchObject({
      status: 'REVERSED',
      createdByUserId: ownerId,
      reversedByUserId: managerId,
      reversalReason: 'Bank returned the transfer',
    });
    expect(await outstanding(bill.id)).toMatchObject({ paidMinor: 0, outstandingMinor: 100_000 });

    const { transaction, entries, invoice } = await inTenant(async (db) => ({
      transaction: await db.pharmacyBookkeepingTransaction.findFirst({
        where: { organizationId, id: payment.transactionId },
      }),
      entries: await db.financeJournalEntry.findMany({
        where: {
          organizationId,
          branchId,
          OR: [{ sourceKind: { not: 'PHARMACY_AP_INVOICE' } }, { reversesEntryId: { not: null } }],
        },
        include: { lines: true },
      }),
      invoice: await db.pharmacyApInvoice.findFirst({ where: { organizationId, id: bill.id } }),
    }));
    // The original payment and its posting stay; one mirror entry reverses it.
    expect(transaction).toMatchObject({ status: 'REVERSED' });
    const original = entries.find((entry) => entry.id === transaction!.journalEntryId)!;
    const mirror = entries.filter((entry) => entry.reversesEntryId === original.id);
    expect(mirror).toHaveLength(1);
    const sides = (lines: { accountCode: string; side: string; amountMinor: number }[]) =>
      lines.map((line) => `${line.accountCode}:${line.side}:${line.amountMinor}`).sort();
    expect(sides(mirror[0]!.lines)).toEqual(
      sides(
        original.lines.map((line) => ({
          ...line,
          side: line.side === 'DEBIT' ? 'CREDIT' : 'DEBIT',
        }))
      )
    );
    expect(invoice).toMatchObject({ status: 'POSTED' });

    // A replay of the same command returns the same reversal and posts nothing more.
    const replay = await inTenant((db) =>
      deps.ap.reverseApSettlement(
        db,
        manager,
        {
          branchId,
          settlementId: payment.id,
          commandKey: `aprev-rev-pay-${suffix}-1`,
          reason: 'Bank returned the transfer',
        },
        segregated
      )
    );
    expect(replay.replayed).toBe(true);
    const mirrorsAfter = await inTenant((db) =>
      db.financeJournalEntry.count({ where: { organizationId, reversesEntryId: original.id } })
    );
    expect(mirrorsAfter).toBe(1);
  }, 90_000);

  it('refuses reversing an invoice with a payment in force; after that payment is reversed it leaves the aging', async () => {
    const bill = await recordBill(2, 50_000);
    const payment = await pay(bill.id, '2a', 50_000);
    const reverseInvoice = () =>
      inTenant((db) =>
        deps.ap.reverseApInvoice(
          db,
          manager,
          {
            branchId,
            invoiceId: bill.id,
            commandKey: `aprev-rev-inv-${suffix}-2`,
            reason: 'Duplicate of AR-1',
          },
          segregated
        )
      );
    await expect(reverseInvoice()).rejects.toMatchObject({ reason: 'ACTIVE_SETTLEMENTS' });
    await inTenant((db) =>
      deps.ap.reverseApSettlement(
        db,
        manager,
        {
          branchId,
          settlementId: payment.id,
          commandKey: `aprev-rev-pay-${suffix}-2`,
          reason: 'Duplicate of AR-1',
        },
        segregated
      )
    );
    expect(await outstanding(bill.id)).toMatchObject({ outstandingMinor: 50_000 });
    const reversed = await reverseInvoice();
    expect(reversed.invoice).toMatchObject({
      status: 'REVERSED',
      reversedByUserId: managerId,
      reversalReason: 'Duplicate of AR-1',
    });
    expect(await outstanding(bill.id)).toBeUndefined();
    const entries = await inTenant((db) =>
      db.financeJournalEntry.findMany({
        where: { organizationId, sourceKind: 'PHARMACY_AP_INVOICE', sourceId: bill.id },
        include: { lines: true },
      })
    );
    // The original entry stays and one mirror (Dr AP / Cr expense) reverses it.
    expect(entries).toHaveLength(2);
    const mirror = entries.find((entry) => entry.reversesEntryId === bill.journalEntryId)!;
    expect(
      mirror.lines.map((line) => `${line.accountCode}:${line.side}:${line.amountMinor}`).sort()
    ).toEqual(['ACCOUNTS_PAYABLE:DEBIT:50000', 'OPERATING_EXPENSE:CREDIT:50000']);
    // A reversed invoice takes no new payment.
    await expect(pay(bill.id, '2b', 1)).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  }, 90_000);

  it('refuses the recorder reversing their own entry while someone else could approve, and writes nothing', async () => {
    const bill = await recordBill(3, 30_000);
    const payment = await pay(bill.id, '3a', 10_000);
    // The real approver rule: the manager is another owner-level person with their own PIN.
    const others = await inTenant((db) => deps.approvers.otherApReversalApprovers(db, owner));
    expect(others.map((other) => other.id)).toEqual([managerId]);
    await expect(
      inTenant((db) =>
        deps.ap.reverseApSettlement(
          db,
          owner,
          {
            branchId,
            settlementId: payment.id,
            commandKey: `aprev-rev-pay-${suffix}-3`,
            reason: 'Wrong amount',
          },
          {
            soleApprover: async () =>
              (await deps.approvers.otherApReversalApprovers(db, owner)).length === 0,
          }
        )
      )
    ).rejects.toMatchObject({ reason: 'SELF_APPROVAL' });
    const after = await inTenant((db) =>
      db.pharmacyApInvoiceSettlement.findFirst({ where: { organizationId, id: payment.id } })
    );
    expect(after).toMatchObject({ status: 'ACTIVE', reverseCommandKey: null });
    expect(await outstanding(bill.id)).toMatchObject({ outstandingMinor: 20_000 });
  }, 90_000);

  it('the cashier never counts as an approver; a solo owner reverses their own entry', async () => {
    // Only the manager counts for the owner: the cashier has a PIN but no owner-level role.
    const forManager = await inTenant((db) => deps.approvers.otherApReversalApprovers(db, manager));
    expect(forManager.map((other) => other.id)).toEqual([ownerId]);

    const soloScope = {
      organizationId: soloOrganizationId,
      branchId: soloBranchId,
      actorId: soloOwnerId,
    };
    const others = await inTenant(
      (db) => deps.approvers.otherApReversalApprovers(db, soloScope),
      soloOrganizationId
    );
    expect(others).toEqual([]);
    const bill = await recordBill(4, 12_345, soloScope);
    const result = await inTenant(
      (db) =>
        deps.ap.reverseApInvoice(
          db,
          soloScope,
          {
            branchId: soloBranchId,
            invoiceId: bill.id,
            commandKey: `aprev-rev-inv-${suffix}-4`,
            reason: 'Entered on the wrong branch',
          },
          {
            soleApprover: async () =>
              (await deps.approvers.otherApReversalApprovers(db, soloScope)).length === 0,
          }
        ),
      soloOrganizationId
    );
    expect(result).toMatchObject({ policy: 'PHARMACY_AP_REVERSAL_SOLE_APPROVER_PIN' });
    expect(result.invoice).toMatchObject({
      status: 'REVERSED',
      createdByUserId: soloOwnerId,
      reversedByUserId: soloOwnerId,
    });
  }, 90_000);

  it('racing reversals of one payment apply exactly once', async () => {
    const bill = await recordBill(5, 80_000);
    const payment = await pay(bill.id, '5a', 80_000);
    const results = await Promise.allSettled(
      ['a', 'b', 'c'].map((key) =>
        inTenant((db) =>
          deps.ap.reverseApSettlement(
            db,
            manager,
            {
              branchId,
              settlementId: payment.id,
              commandKey: `aprev-rev-pay-${suffix}-5${key}`,
              reason: 'Paid twice',
            },
            segregated
          )
        )
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const lost of results.filter((r) => r.status === 'rejected')) {
      expect((lost as PromiseRejectedResult).reason).toMatchObject({ reason: 'ALREADY_REVERSED' });
    }
    const mirrors = await inTenant((db) =>
      db.pharmacyBookkeepingTransaction.findFirst({
        where: { organizationId, id: payment.transactionId },
        select: { status: true, reversalEntryId: true },
      })
    );
    expect(mirrors).toMatchObject({ status: 'REVERSED' });
    expect(await outstanding(bill.id)).toMatchObject({ outstandingMinor: 80_000 });
  }, 90_000);

  it('refuses both reversals in a closed period and changes nothing', async () => {
    const closed = { organizationId, branchId: closedBranchId, actorId: ownerId };
    const bill = await recordBill(6, 20_000, closed);
    const payment = await pay(bill.id, '6a', 5_000, closed);
    await inTenant((db) =>
      db.pharmacyAccountingPeriod.create({
        data: {
          organizationId,
          branchId: closedBranchId,
          startsAt: new Date(Date.now() - 86_400_000),
          endsAt: new Date(Date.now() + 86_400_000),
          status: 'CLOSED',
          closedAt: new Date(),
          closedByUserId: managerId,
        },
      })
    );
    const closedManager = { ...manager, branchId: closedBranchId };
    await expect(
      inTenant((db) =>
        deps.ap.reverseApSettlement(
          db,
          closedManager,
          {
            branchId: closedBranchId,
            settlementId: payment.id,
            commandKey: `aprev-rev-pay-${suffix}-6`,
            reason: 'Wrong payee',
          },
          segregated
        )
      )
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    const state = await inTenant(async (db) => ({
      settlement: await db.pharmacyApInvoiceSettlement.findFirst({
        where: { organizationId, id: payment.id },
      }),
      mirrors: await db.financeJournalEntry.count({
        where: { organizationId, branchId: closedBranchId, reversesEntryId: { not: null } },
      }),
    }));
    expect(state.settlement).toMatchObject({ status: 'ACTIVE' });
    expect(state.mirrors).toBe(0);
  }, 90_000);

  it('another tenant can neither see nor reverse the entry', async () => {
    const bill = await recordBill(7, 9_000);
    const payment = await pay(bill.id, '7a', 1_000);
    const foreign = { organizationId: otherOrganizationId, branchId, actorId: managerId };
    await expect(
      inTenant(
        (db) =>
          deps.ap.reverseApSettlement(
            db,
            foreign,
            {
              branchId,
              settlementId: payment.id,
              commandKey: `aprev-rev-pay-${suffix}-7`,
              reason: 'Not ours',
            },
            segregated
          ),
        otherOrganizationId
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    await expect(
      inTenant(
        (db) =>
          deps.ap.reverseApInvoice(
            db,
            foreign,
            {
              branchId,
              invoiceId: bill.id,
              commandKey: `aprev-rev-inv-${suffix}-7`,
              reason: 'Not ours',
            },
            segregated
          ),
        otherOrganizationId
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(await outstanding(bill.id)).toMatchObject({ outstandingMinor: 8_000 });
  }, 90_000);
});

describeDb('DEV-103 reversal search and paging', () => {
  const tag = `ARQ-${suffix}`;
  async function bill(n: number, invoiceDate: string, amountMinor: number, payeeName: string) {
    const result = await inTenant((db) =>
      deps.ap.recordApInvoice(db, owner, {
        branchId,
        createKey: `aprev-search-${suffix}-${n}`,
        reference: `${tag}-${String(n).padStart(2, '0')}`,
        payeeName,
        supplierInvoiceRef: `SUP-${suffix}-${n}`,
        invoiceDate,
        dueDate: invoiceDate,
        amountMinor,
        currency: 'PKR',
        description: 'Search fixture',
        evidenceReference: 'Bill scan',
      })
    );
    return result.invoice;
  }
  const search = (
    input: Parameters<Deps['ap']['searchApReversals']>[2],
    scope: { organizationId: string; branchId: string } = { organizationId, branchId },
    org = organizationId
  ) => inTenant((db) => deps.ap.searchApReversals(db, scope, input, 'Asia/Karachi'), org);

  it('finds an older invoice or payment by reference, payee, amount and day, a stable page at a time', async () => {
    // 27 bills on three dates; two share a date, so ties fall back to the id.
    const made = [];
    for (let n = 1; n <= 27; n += 1) {
      made.push(
        await bill(n, day(-(n % 3) - 20), 100_000 + n, n === 5 ? 'Search Payee Five' : 'Payee')
      );
    }
    const paid = made[6]!;
    const payment = await pay(paid.id, 'search', 23_456);
    const reversed = made[8]!;
    await inTenant((db) =>
      deps.ap.reverseApInvoice(
        db,
        manager,
        {
          branchId,
          invoiceId: reversed.id,
          commandKey: `aprev-search-rev-${suffix}`,
          reason: 'Entered twice',
        },
        segregated
      )
    );

    // Paging: 26 posted bills match, 25 on page one and 1 on the page older than its last row,
    // in one total order.
    const first = await search({ reference: tag });
    expect(first.older).not.toBeNull();
    const second = await search({ reference: tag, older: first.older! });
    expect(first.invoices).toHaveLength(25);
    expect(first.hasOlder).toBe(true);
    expect(first.hasNewer).toBe(false);
    expect(second.invoices).toHaveLength(1);
    expect(second.hasOlder).toBe(false);
    expect(second.hasNewer).toBe(true);
    const listed = [...first.invoices, ...second.invoices];
    expect(new Set(listed.map((row) => row.id)).size).toBe(26);
    expect(listed.map((row) => row.id)).not.toContain(reversed.id);
    const expectedOrder = made
      .filter((row) => row.id !== reversed.id)
      .sort(
        (a, b) =>
          b.invoiceDate.getTime() - a.invoiceDate.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      )
      .map((row) => row.id);
    expect(listed.map((row) => row.id)).toEqual(expectedOrder);
    // The same page read twice is the same page.
    expect((await search({ reference: tag })).invoices.map((row) => row.id)).toEqual(
      first.invoices.map((row) => row.id)
    );

    // Payee, ignoring case; the supplier's invoice number; an invoice amount; a payment amount.
    expect((await search({ payee: 'search payee five' })).invoices.map((r) => r.id)).toEqual([
      made[4]!.id,
    ]);
    expect((await search({ reference: `SUP-${suffix}-12` })).invoices.map((r) => r.id)).toEqual([
      made[11]!.id,
    ]);
    expect(
      (await search({ reference: tag, amountMinor: 100_013 })).invoices.map((r) => r.id)
    ).toEqual([made[12]!.id]);
    const byPayment = await search({ reference: tag, amountMinor: 23_456 });
    expect(byPayment.invoices.map((r) => r.id)).toEqual([paid.id]);
    expect(byPayment.invoices[0]!.settlements.map((s) => s.id)).toEqual([payment.id]);

    // Days on the shop's clock: the invoice date, or the day a payment in force was made.
    const oldest = day(-22);
    const onOldest = await search({ reference: tag, from: oldest, to: oldest });
    expect(onOldest.invoices.map((r) => r.id).sort()).toEqual(
      made
        .filter((row) => row.invoiceDate.toISOString().slice(0, 10) === oldest)
        .map((row) => row.id)
        .sort()
    );
    const paidDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(
      payment.paidAt
    );
    expect(
      (await search({ reference: tag, from: paidDay, to: paidDay })).invoices.map((r) => r.id)
    ).toEqual([paid.id]);

    // Nothing outside this branch or this tenant.
    expect(
      (await search({ reference: tag }, { organizationId, branchId: closedBranchId })).invoices
    ).toEqual([]);
    expect(
      (
        await search(
          { reference: tag },
          { organizationId: otherOrganizationId, branchId },
          otherOrganizationId
        )
      ).invoices
    ).toEqual([]);
  }, 180_000);
});

describeDb('DEV-967 reversal list cursor paging and literal search', () => {
  const tag = `ARP-${suffix}`;
  let made = 0;
  async function bill(invoiceDate: string, payeeName = 'Cursor payee', reference?: string) {
    made += 1;
    const result = await inTenant((db) =>
      deps.ap.recordApInvoice(db, owner, {
        branchId,
        createKey: `aprev-cursor-${suffix}-${made}`,
        reference: reference ?? `${tag}-${String(made).padStart(2, '0')}`,
        payeeName,
        supplierInvoiceRef: `CUR-${suffix}-${made}`,
        invoiceDate,
        dueDate: invoiceDate,
        amountMinor: 50_000 + made,
        currency: 'PKR',
        description: 'Cursor fixture',
        evidenceReference: 'Bill scan',
      })
    );
    return result.invoice;
  }
  const reverse = (invoiceId: string, n: string) =>
    inTenant((db) =>
      deps.ap.reverseApInvoice(
        db,
        manager,
        {
          branchId,
          invoiceId,
          commandKey: `aprev-cursor-rev-${suffix}-${n}`,
          reason: 'Wrong bill',
        },
        segregated
      )
    );
  const search = (input: Parameters<Deps['ap']['searchApReversals']>[2]) =>
    inTenant((db) =>
      deps.ap.searchApReversals(db, { organizationId, branchId }, input, 'Asia/Karachi')
    );
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
  const listOrder = (rows: { id: string; invoiceDate: Date }[]) =>
    [...rows]
      .sort(
        (a, b) =>
          b.invoiceDate.getTime() - a.invoiceDate.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      )
      .map((row) => row.id);

  it('shows every bill exactly once across pages while bills are recorded and reversed between page reads', async () => {
    // 30 bills on three dates, so most rows tie on the date and fall back to the id.
    const before = [];
    for (let n = 0; n < 30; n += 1) before.push(await bill(day(-(n % 3) - 40)));

    const first = await search({ reference: tag });
    expect(first.invoices).toHaveLength(25);
    expect(first.hasOlder).toBe(true);
    expect(first.hasNewer).toBe(false);
    expect(first.older).toEqual({
      invoiceDate: first.invoices[24]!.invoiceDate.toISOString(),
      id: first.invoices[24]!.id,
    });

    // Between the two reads: someone reverses the newest listed bill and the bill the page
    // ended on, and the oldest bill not yet shown; bills are recorded newer than every bill,
    // on the date the page ended on, and older than every bill.
    const unread = before.filter((row) => !ids(first.invoices).includes(row.id));
    const goneUnread = unread[0]!;
    await reverse(first.invoices[0]!.id, '1');
    await reverse(first.invoices[24]!.id, '2');
    await reverse(goneUnread.id, '3');
    const newest = await bill(day(-1));
    const tie = await bill(first.invoices[24]!.invoiceDate.toISOString().slice(0, 10));
    const oldest = await bill(day(-60));

    const second = await search({ reference: tag, older: first.older! });
    const shown = [...ids(first.invoices), ...ids(second.invoices)];
    // No bill twice, and every bill posted throughout appears.
    expect(new Set(shown).size).toBe(shown.length);
    const reversedLater = new Set([first.invoices[0]!.id, first.invoices[24]!.id, goneUnread.id]);
    for (const row of before) {
      if (!reversedLater.has(row.id) || ids(first.invoices).includes(row.id)) {
        expect(shown.filter((id) => id === row.id)).toHaveLength(1);
      }
    }
    // The older page is exactly the posted rows after the cursor row, in list order.
    const posted = [...before, newest, tie, oldest].filter((row) => !reversedLater.has(row.id));
    const order = listOrder(posted);
    const cursorAt = listOrder([...posted, first.invoices[24]!]).indexOf(first.invoices[24]!.id);
    const afterCursor = listOrder([...posted, first.invoices[24]!]).slice(cursorAt + 1);
    expect(ids(second.invoices)).toEqual(afterCursor);
    expect(ids(second.invoices)).toContain(oldest.id);
    expect(ids(second.invoices)).not.toContain(goneUnread.id);
    expect(ids(second.invoices)).not.toContain(newest.id);
    expect(second.hasOlder).toBe(false);
    expect(second.older).toBeNull();
    expect(second.hasNewer).toBe(true);
    expect(second.newer).toEqual({
      invoiceDate: second.invoices[0]!.invoiceDate.toISOString(),
      id: second.invoices[0]!.id,
    });

    // Back toward the newest: the page just before the older page's first row, in list order.
    const back = await search({ reference: tag, newer: second.newer! });
    const at = order.indexOf(second.invoices[0]!.id);
    expect(ids(back.invoices)).toEqual(order.slice(Math.max(0, at - 25), at));
    expect(back.hasOlder).toBe(true);
    expect(back.older).toEqual({
      invoiceDate: back.invoices.at(-1)!.invoiceDate.toISOString(),
      id: back.invoices.at(-1)!.id,
    });
    expect(back.hasNewer).toBe(at > 25);

    // Walking the whole list from the newest page lists every posted bill once, in order.
    const walked: string[] = [];
    let page = await search({ reference: tag });
    walked.push(...ids(page.invoices));
    while (page.older) {
      page = await search({ reference: tag, older: page.older });
      walked.push(...ids(page.invoices));
    }
    expect(walked).toEqual(order);

    // A cursor whose row was reversed still turns the page; a cursor each way is refused.
    const fromReversed = await search({
      reference: tag,
      older: {
        invoiceDate: first.invoices[0]!.invoiceDate.toISOString(),
        id: first.invoices[0]!.id,
      },
    });
    expect(ids(fromReversed.invoices)).not.toContain(first.invoices[0]!.id);
    await expect(
      search({ reference: tag, older: first.older!, newer: first.older! })
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  }, 240_000);

  it('matches percent, underscore and backslash in the search as typed', async () => {
    const pct = await bill(day(-70), `Cent 100%${suffix} Pure`);
    const notPct = await bill(day(-70), `Cent 100x${suffix} Pure`);
    const under = await bill(day(-70), 'Cursor payee', `ARU_${suffix}`);
    const notUnder = await bill(day(-70), 'Cursor payee', `ARUx${suffix}`);
    const slash = await bill(day(-70), `Back\\slash${suffix}`);

    expect(ids((await search({ payee: `100%${suffix}` })).invoices)).toEqual([pct.id]);
    expect(ids((await search({ payee: `00%${suffix} p` })).invoices)).toEqual([pct.id]);
    expect(ids((await search({ reference: `ARU_${suffix}` })).invoices)).toEqual([under.id]);
    expect(ids((await search({ reference: `aru_${suffix}` })).invoices)).toEqual([under.id]);
    expect(ids((await search({ payee: `k\\slash${suffix}` })).invoices)).toEqual([slash.id]);
    // A lone wildcard character matches only the rows that contain it.
    const percentOnly = ids((await search({ payee: '%' })).invoices);
    expect(percentOnly).toEqual([pct.id]);
    const underscoreOnly = ids((await search({ reference: `_${suffix}` })).invoices);
    expect(underscoreOnly).toEqual([under.id]);
    expect(ids((await search({ reference: `ARU${suffix}` })).invoices)).toEqual([]);
    expect(ids((await search({ payee: `100${suffix}` })).invoices)).not.toContain(notPct.id);
    expect(ids((await search({ reference: `ARU_${suffix}` })).invoices)).not.toContain(notUnder.id);
  }, 120_000);
});
