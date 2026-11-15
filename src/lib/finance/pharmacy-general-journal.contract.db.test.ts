// @vitest-environment node
/**
 * CEO-JVCORE-20261025 — the ledger contract a posted journal voucher must keep
 * with the shared FIN-01 journal: one balanced canonical entry per voucher,
 * linked by source and foreign key, netting to zero after its one reversal;
 * and a failed transactional audit rolls the posting back. Skips without a
 * database URL.
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
const organizationId = `org_jvc_${suffix}`;
const branchId = `branch_jvc_${suffix}`;
const actorId = `owner_jvc_${suffix}`;
const scope = { organizationId, branchId, actorId };

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  jv: typeof import('@/lib/pharmacy/accounts/general-journal');
  journal: typeof import('./journal');
};
let deps: Deps;
const inTenant = <T>(work: (db: ScopedDb) => Promise<T>) =>
  deps.withTenantDb(organizationId, work, { timeout: 30_000 });

function draft(n: number) {
  return {
    branchId,
    createKey: `create-${suffix}-${n}`,
    reference: `JVC-${suffix}-${n}`,
    purpose: 'NONTRADE_OPERATING_ACCRUAL' as const,
    occurredAt: '2026-10-05T09:00:00.000Z',
    currency: 'PKR' as const,
    reason: 'Rent accrual',
    evidenceReference: `LEASE-${n}`,
    lines: [
      { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT' as const, amountMinor: 80_000 },
      { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT' as const, amountMinor: 80_000 },
    ],
  };
}

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  const [scoped, jv, journal, guard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/pharmacy/accounts/general-journal'),
    import('./journal'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scoped.withTenantDb, jv, journal };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(`SET app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$2,'JV contract','JV contract','ACTIVE','SHARED',now(),now())`,
      [organizationId, `jvc-${suffix}`]
    );
    await owner.query(
      `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","createdAt","updatedAt") VALUES ($1,$2,$3,'JV contract pharmacy','1 Test Road','Lahore','PB',now(),now())`,
      [branchId, organizationId, `JVC-${suffix}`]
    );
  } finally {
    await owner.end();
  }
}, 120_000);

describeDb('pharmacy journal voucher ledger contract', () => {
  it('posts one balanced canonical entry and nets to zero after its reversal', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(1)));
    const posted = await inTenant((db) =>
      deps.jv.postJournalVoucher(db, scope, {
        branchId,
        voucherId: created.id,
        expectedVersion: 1,
        commandKey: `post-${suffix}-1`,
      })
    );
    await inTenant((db) =>
      deps.jv.reverseJournalVoucher(db, scope, {
        branchId,
        voucherId: created.id,
        commandKey: `reverse-${suffix}-1`,
        reason: 'Lease cancelled',
        at: '2026-10-06T09:00:00.000Z',
      })
    );
    const entries = await inTenant((db) =>
      deps.journal.entriesForSource(db, organizationId, 'PHARMACY_JOURNAL_VOUCHER', created.id)
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe(posted.voucher.journalEntryId);
    expect(entries[1]!.reversesEntryId).toBe(entries[0]!.id);
    for (const entry of entries) {
      expect(entry.branchId).toBe(branchId);
      const debit = entry.lines
        .filter((l) => l.side === 'DEBIT')
        .reduce((s, l) => s + l.amountMinor, 0);
      const credit = entry.lines
        .filter((l) => l.side === 'CREDIT')
        .reduce((s, l) => s + l.amountMinor, 0);
      expect(debit).toBe(credit);
    }
    const net = new Map<string, number>();
    for (const line of entries.flatMap((entry) => entry.lines)) {
      net.set(line.accountCode, (net.get(line.accountCode) ?? 0) + deps.journal.signedMinor(line));
    }
    expect(Object.fromEntries(net)).toEqual({ OPERATING_EXPENSE: 0, MANUAL_NONTRADE_ACCRUAL: 0 });
  }, 60_000);

  it('rolls the posting back when the same-transaction audit fails', async () => {
    const created = await inTenant((db) => deps.jv.createJournalVoucherDraft(db, scope, draft(2)));
    await expect(
      inTenant(async (db) => {
        await deps.jv.postJournalVoucher(db, scope, {
          branchId,
          voucherId: created.id,
          expectedVersion: 1,
          commandKey: `post-${suffix}-2`,
        });
        throw new Error('audit write failed');
      })
    ).rejects.toThrow('audit write failed');
    const after = await inTenant((db) => deps.jv.getJournalVoucher(db, scope, created.id));
    expect(after).toMatchObject({ status: 'DRAFT', journalEntryId: null });
    const entries = await inTenant((db) =>
      deps.journal.entriesForSource(db, organizationId, 'PHARMACY_JOURNAL_VOUCHER', created.id)
    );
    expect(entries).toEqual([]);
  }, 60_000);

  it('refuses a voucher ledger key that belongs to another source', async () => {
    await expect(
      inTenant(async (db) => {
        await deps.journal.postJournalEntry(db, scope, {
          sourceKind: 'PHARMACY_JOURNAL_VOUCHER',
          sourceId: `foreign-${suffix}`,
          description: 'collision',
          occurredAt: new Date('2026-10-05T09:00:00Z'),
          idempotencyKey: `collide-${suffix}`,
          branchId,
          lines: [
            { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 10 },
            { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor: 10 },
          ],
        });
        return deps.journal.postJournalEntry(db, scope, {
          sourceKind: 'PHARMACY_JOURNAL_VOUCHER',
          sourceId: `other-${suffix}`,
          description: 'collision',
          occurredAt: new Date('2026-10-05T09:00:00Z'),
          idempotencyKey: `collide-${suffix}`,
          branchId,
          lines: [
            { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 10 },
            { accountCode: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', amountMinor: 10 },
          ],
        });
      })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  }, 60_000);
});
