// @vitest-environment node
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { FinanceSourceKind } from '@/generated/prisma/client';

// Same optional-URL convention as journal.db.test.ts. A skipped run is not DB evidence.
const runtimeUrl = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
const describeDb = runtimeUrl ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const organizationId = `org_period_${suffix}`;
const otherOrganizationId = `org_other_period_${suffix}`;
const branchId = `branch_period_${suffix}`;
const otherBranchId = `branch_other_period_${suffix}`;
const at = new Date('2026-11-16T10:00:00Z');
const start = new Date('2026-11-01T00:00:00Z');
const end = new Date('2026-12-01T00:00:00Z');
let deps: {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  journal: typeof import('./journal');
  bookkeeping: typeof import('@/lib/pharmacy/bookkeeping');
};
const scope = { organizationId, actorId: 'cashier_period', branchId };
let sequence = 0;
const key = () => `period_${suffix}_${++sequence}`;
const inTenant = <T>(work: (db: ScopedDb) => Promise<T>) => deps.withTenantDb(organizationId, work);

beforeAll(async () => {
  if (!runtimeUrl) return;
  const [scoped, journal, bookkeeping, guard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./journal'),
    import('@/lib/pharmacy/bookkeeping'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scoped.withTenantDb, journal, bookkeeping };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  await scoped.withPlatformDb(async (db) => {
    for (const id of [organizationId, otherOrganizationId]) {
      await db.organization.create({
        data: {
          id,
          slug: id,
          legalName: 'Period fixture',
          displayName: 'Period fixture',
          status: 'ACTIVE',
          deploymentMode: 'SHARED',
          vertical: 'PHARMACY',
        },
      });
    }
  });
  await inTenant(async (db) => {
    for (const id of [branchId, otherBranchId]) {
      await db.pharmacyBranch.create({
        data: {
          id,
          organizationId,
          code: id,
          name: 'Period fixture',
          addressLine: '1 Test Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
    }
    await deps.bookkeeping.closeAccountingPeriod(db, scope, { startsAt: start, endsAt: end });
  });
}, 120_000);

function posting(occurredAt = at, targetBranch = branchId) {
  const id = key();
  return {
    sourceKind: 'PHARMACY_TENDER' as const,
    sourceId: id,
    idempotencyKey: id,
    branchId: targetBranch,
    description: 'Period fixture',
    occurredAt,
    lines: [
      { accountCode: 'CASH' as const, side: 'DEBIT' as const, amountMinor: 5000 },
      { accountCode: 'SALES_CLEARING' as const, side: 'CREDIT' as const, amountMinor: 5000 },
    ],
  };
}

const insertSql = `INSERT INTO finance_journal_entries
  (id,"organizationId","branchId","sourceKind","sourceId",description,"actorId","occurredAt","idempotencyKey")
  VALUES ($1,$2,$3,$4::"FinanceSourceKind",$1,'Period fixture','cashier_period',$5,$1)`;

async function tenantClient() {
  const client = new pg.Client({ connectionString: runtimeUrl });
  await client.connect();
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('app.current_organization_id',$1,true), set_config('app.is_platform_admin','false',true)`,
    [organizationId]
  );
  return client;
}

// Observe a real database wait before releasing the competing transaction.
async function waitForLedgerLock(client: pg.Client, waitingPid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted`,
      [waitingPid]
    );
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Expected transaction did not wait for the ledger lock');
}

describeDb('DEV-877 database period backstop', () => {
  it.each(Object.values(FinanceSourceKind))(
    'blocks raw %s writes to the closed branch',
    async (sourceKind) => {
      const id = key();
      await expect(
        inTenant((db) =>
          db.$executeRawUnsafe(insertSql, id, organizationId, branchId, sourceKind, at)
        )
      ).rejects.toThrow('PHARMACY_ACCOUNTING_PERIOD_CLOSED');
      expect(await inTenant((db) => db.financeJournalEntry.count({ where: { id } }))).toBe(0);
    }
  );

  it('rolls an operational row back with its refused journal entry', async () => {
    const id = key();
    await expect(
      inTenant(async (db) => {
        await db.pharmacyBookkeepingTransaction.create({
          data: {
            id,
            organizationId,
            branchId,
            reference: id,
            kind: 'EXPENSE',
            amountMinor: 5000,
            occurredAt: at,
            idempotencyKey: id,
            createdByUserId: scope.actorId,
          },
        });
        await deps.journal.postJournalEntry(db, scope, posting());
      })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    expect(await inTenant((db) => db.pharmacyBookkeepingTransaction.count({ where: { id } }))).toBe(
      0
    );
  });

  it('blocks a line that posts into a closed branch through an open header', async () => {
    const id = key();
    await expect(
      inTenant(async (db) => {
        await db.$executeRawUnsafe(
          insertSql,
          id,
          organizationId,
          otherBranchId,
          'PHARMACY_INTERBRANCH_TRANSFER_LINE',
          at
        );
        await db.$executeRawUnsafe(
          `INSERT INTO finance_journal_lines
        (id,"organizationId","entryId","branchId","accountCode",side,"amountMinor")
        VALUES ($1,$2,$3,$4,'INVENTORY_IN_TRANSIT','DEBIT',5000)`,
          key(),
          organizationId,
          id,
          branchId
        );
      })
    ).rejects.toThrow('PHARMACY_ACCOUNTING_PERIOD_CLOSED');
    expect(await inTenant((db) => db.financeJournalEntry.count({ where: { id } }))).toBe(0);
  });

  it('allows the exclusive end boundary and another branch, and hides the closed tenant', async () => {
    const boundary = await inTenant((db) => deps.journal.postJournalEntry(db, scope, posting(end)));
    expect(boundary.occurredAt).toEqual(end);
    await expect(
      inTenant((db) => deps.journal.postJournalEntry(db, scope, posting(at, otherBranchId)))
    ).resolves.toHaveProperty('id');
    expect(
      await deps.withTenantDb(otherOrganizationId, (db) => db.pharmacyAccountingPeriod.count())
    ).toBe(0);
  });

  it('keeps committed retries readable and permits an open-period correcting reversal', async () => {
    const input = posting(new Date(start.getTime() - 1));
    const original = await inTenant((db) => deps.journal.postJournalEntry(db, scope, input));
    await expect(
      inTenant((db) =>
        deps.journal.reverseJournalEntry(db, scope, {
          entryId: original.id,
          at,
          reason: 'Correct in open period',
          idempotencyKey: key(),
        })
      )
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    const reversal = await inTenant((db) =>
      deps.journal.reverseJournalEntry(db, scope, {
        entryId: original.id,
        at: end,
        reason: 'Correct in open period',
        idempotencyKey: key(),
      })
    );
    expect(reversal.reversesEntryId).toBe(original.id);
    await expect(
      inTenant((db) => deps.journal.postJournalEntry(db, scope, input))
    ).resolves.toMatchObject({ id: original.id });
  });

  it('serializes a raw posting behind an uncommitted period close', async () => {
    const closer = await tenantClient();
    const writer = await tenantClient();
    let result: Promise<unknown> | undefined;
    try {
      // January is open until this transaction closes it.
      await closer.query(
        `INSERT INTO pharmacy_accounting_periods
        (id,"organizationId","branchId","startsAt","endsAt",status,"closedAt","closedByUserId")
        VALUES ($1,$2,$3,'2027-01-01','2027-02-01','CLOSED',now(),'owner')`,
        [key(), organizationId, branchId]
      );
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      result = writer
        .query(insertSql, [
          key(),
          organizationId,
          branchId,
          'PHARMACY_TENDER',
          new Date('2027-01-16'),
        ])
        .then(
          () => 'unexpected success',
          (error: Error) => error.message
        );
      await waitForLedgerLock(closer, pid);
      await closer.query('COMMIT');
      expect(await result).toBe('PHARMACY_ACCOUNTING_PERIOD_CLOSED');
    } finally {
      await closer.query('ROLLBACK');
      await writer.query('ROLLBACK');
      await result;
      await closer.end();
      await writer.end();
    }
  });
});
