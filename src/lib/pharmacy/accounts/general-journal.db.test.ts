// @vitest-environment node
/**
 * CEO-JVCORE-20261025 — the journal voucher lifecycle against PostgreSQL:
 * versioned drafts, once-per-document posting, payload-stable replay, the
 * linked canonical reversal, the immutability triggers, branch-scoped RLS and
 * the shared ledger lock. Skips without a database URL.
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
const organizationId = `org_jv_${suffix}`;
const otherOrganizationId = `org_jv_other_${suffix}`;
const branchId = `branch_jv_${suffix}`;
const otherBranchId = `branch_jv_b_${suffix}`;
const actorId = `owner_jv_${suffix}`;
const scope = { organizationId, branchId, actorId };

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  jv: typeof import('./general-journal');
  bookkeeping: typeof import('../bookkeeping');
};
let deps: Deps;
const inTenant = <T>(work: (db: ScopedDb) => Promise<T>, org = organizationId) =>
  deps.withTenantDb(org, work, { timeout: 30_000 });

function draft(n: number, overrides: Record<string, unknown> = {}) {
  return {
    branchId,
    createKey: `create-${suffix}-${n}`,
    reference: `JV-${suffix}-${n}`,
    purpose: 'NONTRADE_OPERATING_ACCRUAL' as const,
    occurredAt: '2026-10-10T09:00:00.000Z',
    currency: 'PKR' as const,
    reason: 'Electricity accrual',
    evidenceReference: `BILL-${n}`,
    lines: [
      { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT' as const, amountMinor: 12_500 },
      { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT' as const, amountMinor: 12_500 },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  const [scoped, jv, bookkeeping, guard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./general-journal'),
    import('../bookkeeping'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scoped.withTenantDb, jv, bookkeeping };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(`SET app.is_platform_admin = 'true'`);
    for (const [org, slug] of [
      [organizationId, `jv-${suffix}`],
      [otherOrganizationId, `jv-other-${suffix}`],
    ]) {
      await owner.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$2,'JV fixture','JV fixture','ACTIVE','SHARED',now(),now())`,
        [org, slug]
      );
    }
    for (const [id, code] of [
      [branchId, `JVA-${suffix}`],
      [otherBranchId, `JVB-${suffix}`],
    ]) {
      await owner.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","createdAt","updatedAt") VALUES ($1,$2,$3,'JV pharmacy','1 Test Road','Lahore','PB',now(),now())`,
        [id, organizationId, code]
      );
    }
  } finally {
    await owner.end();
  }
}, 120_000);

describeDb('pharmacy journal voucher lifecycle', () => {
  it('saves, reloads and versions a draft, then posts it once with a stable replay', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(1)));
    const replayed = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(1)));
    expect(replayed.id).toBe(created.id);

    const reloaded = await inTenant((db) => deps.jv.getJournalVoucher(db, scope, created.id));
    expect(reloaded).toMatchObject({ status: 'DRAFT', version: 1 });
    expect(reloaded.lines.map((line) => `${line.accountCode}:${line.side}`)).toEqual([
      'OPERATING_EXPENSE:DEBIT',
      'MANUAL_NONTRADE_ACCRUAL:CREDIT',
    ]);

    const edited = await inTenant((db) =>
      deps.jv.updateJournalVoucherDraft(db, scope, {
        ...draft(1, {
          lines: [
            { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 15_000 },
            { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor: 15_000 },
          ],
        }),
        voucherId: created.id,
        expectedVersion: 1,
      })
    );
    expect(edited.version).toBe(2);
    await expect(
      inTenant((db) =>
        deps.jv.updateJournalVoucherDraft(db, scope, {
          ...draft(1),
          voucherId: created.id,
          expectedVersion: 1,
        })
      )
    ).rejects.toMatchObject({ reason: 'STALE_VERSION' });

    const post = {
      branchId,
      voucherId: created.id,
      expectedVersion: 2,
      commandKey: `post-${suffix}-1`,
    };
    const first = await inTenant((db) => deps.jv.postJournalVoucher(db, scope, post));
    expect(first.voucher.status).toBe('POSTED');
    const again = await inTenant((db) => deps.jv.postJournalVoucher(db, scope, post));
    expect(again).toMatchObject({ replayed: true });
    expect(again.voucher.journalEntryId).toBe(first.voucher.journalEntryId);
    await expect(
      inTenant((db) => deps.jv.postJournalVoucher(db, scope, { ...post, expectedVersion: 1 }))
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      inTenant((db) =>
        deps.jv.postJournalVoucher(db, scope, { ...post, commandKey: `post-${suffix}-1b` })
      )
    ).rejects.toMatchObject({ reason: 'ALREADY_POSTED' });

    const entries = await inTenant((db) =>
      db.financeJournalEntry.findMany({
        where: { organizationId, sourceKind: 'PHARMACY_JOURNAL_VOUCHER', sourceId: created.id },
        include: { lines: true },
      })
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lines.map((line) => line.amountMinor)).toEqual([15_000, 15_000]);
  }, 60_000);

  it('serializes racing posts with different keys into exactly one ledger entry', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(2)));
    const results = await Promise.allSettled(
      ['a', 'b', 'c'].map((key) =>
        inTenant((db) =>
          deps.jv.postJournalVoucher(db, scope, {
            branchId,
            voucherId: created.id,
            expectedVersion: 1,
            commandKey: `race-${suffix}-${key}`,
          })
        )
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const entries = await inTenant((db) =>
      db.financeJournalEntry.count({
        where: { organizationId, sourceKind: 'PHARMACY_JOURNAL_VOUCHER', sourceId: created.id },
      })
    );
    expect(entries).toBe(1);
  }, 60_000);

  it('freezes posted vouchers and their lines in the database', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(3)));
    await inTenant((db) =>
      deps.jv.postJournalVoucher(db, scope, {
        branchId,
        voucherId: created.id,
        expectedVersion: 1,
        commandKey: `post-${suffix}-3`,
      })
    );
    await expect(
      inTenant((db) =>
        db.pharmacyJournalVoucher.update({
          where: { id: created.id },
          data: { reason: 'rewritten' },
        })
      )
    ).rejects.toThrow(/immutable/);
    await expect(
      inTenant((db) =>
        db.pharmacyJournalVoucherLine.updateMany({
          where: { organizationId, voucherId: created.id },
          data: { amountMinor: 1 },
        })
      )
    ).rejects.toThrow(/immutable outside DRAFT/);
    await expect(
      inTenant((db) => db.pharmacyJournalVoucher.delete({ where: { id: created.id } }))
    ).rejects.toThrow(/cannot be deleted/);
  }, 60_000);

  it('reverses once with a linked canonical entry and refuses a closed period', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(4)));
    const posted = await inTenant((db) =>
      deps.jv.postJournalVoucher(db, scope, {
        branchId,
        voucherId: created.id,
        expectedVersion: 1,
        commandKey: `post-${suffix}-4`,
      })
    );
    await inTenant((db) =>
      deps.bookkeeping.closeAccountingPeriod(db, scope, {
        startsAt: new Date('2026-10-20T00:00:00Z'),
        endsAt: new Date('2026-10-21T00:00:00Z'),
      })
    );
    await expect(
      inTenant((db) =>
        deps.jv.reverseJournalVoucher(db, scope, {
          branchId,
          voucherId: created.id,
          commandKey: `reverse-${suffix}-4a`,
          reason: 'Wrong branch',
          at: '2026-10-20T12:00:00.000Z',
        })
      )
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });

    const reverse = {
      branchId,
      voucherId: created.id,
      commandKey: `reverse-${suffix}-4`,
      reason: 'Wrong branch',
      at: '2026-10-22T12:00:00.000Z',
    };
    const reversed = await inTenant((db) => deps.jv.reverseJournalVoucher(db, scope, reverse));
    expect(reversed.voucher.status).toBe('REVERSED');
    const reversal = await inTenant((db) =>
      db.financeJournalEntry.findFirstOrThrow({
        where: { organizationId, id: reversed.voucher.reversalEntryId! },
      })
    );
    expect(reversal.reversesEntryId).toBe(posted.voucher.journalEntryId);
    await expect(
      inTenant((db) => deps.jv.reverseJournalVoucher(db, scope, reverse))
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      inTenant((db) =>
        deps.jv.reverseJournalVoucher(db, scope, { ...reverse, commandKey: `reverse-${suffix}-4b` })
      )
    ).rejects.toMatchObject({ reason: 'ALREADY_REVERSED' });
  }, 60_000);

  it('hides vouchers from another branch scope and another organization', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(5)));
    await expect(
      inTenant((db) =>
        deps.jv.getJournalVoucher(db, { organizationId, branchId: otherBranchId }, created.id)
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    const visible = await inTenant(
      (db) => db.pharmacyJournalVoucher.findMany({ where: { id: created.id } }),
      otherOrganizationId
    );
    expect(visible).toEqual([]);
  }, 60_000);
});
