// @vitest-environment node
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { FinanceSourceKind } from '@/generated/prisma/client';

const runtimeUrl = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
const describeDb = runtimeUrl ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const organizationId = `period_a_${suffix}`;
const otherOrg = `period_b_${suffix}`;
const branchId = `period_branch_${suffix}`;
const otherBranch = `period_other_${suffix}`;
const actorId = 'period_test_cashier';
const startsAt = new Date('2026-11-01T00:00:00Z');
const endsAt = new Date('2026-12-01T00:00:00Z');
const at = new Date('2026-11-16T12:00:00Z');
let scoped: typeof import('@/lib/tenancy/scoped-db');
let journal: typeof import('./journal');
let bookkeeping: typeof import('@/lib/pharmacy/bookkeeping');
const scope = { organizationId, branchId, actorId };
const key = () => randomBytes(10).toString('hex');
const input = (date = at, branch: string | null = branchId) => ({
  sourceKind: 'PHARMACY_TENDER' as FinanceSourceKind,
  sourceId: key(),
  description: 'Synthetic period regression',
  occurredAt: date,
  idempotencyKey: key(),
  branchId: branch,
  lines: [
    { accountCode: 'CASH' as const, side: 'DEBIT' as const, amountMinor: 5000 },
    { accountCode: 'SALES_CLEARING' as const, side: 'CREDIT' as const, amountMinor: 5000 },
  ],
});
const inOrg = <T>(work: (db: ScopedDb) => Promise<T>, org = organizationId) =>
  scoped.withTenantDb(org, work);

beforeAll(async () => {
  if (!runtimeUrl) return;
  scoped = await import('@/lib/tenancy/scoped-db');
  journal = await import('./journal');
  bookkeeping = await import('@/lib/pharmacy/bookkeeping');
  const guard = await import('@/lib/testing/rls-role-guard');
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt")
     SELECT id,id,id,id,'ACTIVE','SHARED',now(),now() FROM unnest($1::text[]) AS id`,
      [organizationId, otherOrg]
    )
  );
  await inOrg(async (db) => {
    for (const id of [branchId, otherBranch])
      await db.pharmacyBranch.create({
        data: {
          id,
          organizationId,
          code: id,
          name: 'Synthetic branch',
          addressLine: 'Test',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
    await bookkeeping.closeAccountingPeriod(db, scope, { startsAt, endsAt });
  });
}, 120_000);

describeDb('DEV-877 period lock against PostgreSQL with enforced RLS', () => {
  it.each<FinanceSourceKind>([
    'PHARMACY_SALE_LINE',
    'PHARMACY_TENDER',
    'PHARMACY_REFUND',
    'PHARMACY_GOODS_RECEIPT',
    'PHARMACY_STOCK_WRITE_OFF',
    'PHARMACY_INTERBRANCH_TRANSFER_LINE',
    'PHARMACY_INVENTORY_COUNT_LINE',
    'PHARMACY_OPENING_STOCK',
    'PHARMACY_OPENING_LEDGER',
  ])('rejects %s and rolls back the surrounding transaction', async (sourceKind) => {
    const post = { ...input(), sourceKind };
    await expect(
      inOrg(async (db) => {
        // A preceding operational write must disappear along with the refused post.
        await db.pharmacySale.create({
          data: { id: post.sourceId, organizationId, branchId, createdByUserId: actorId },
        });
        return journal.postJournalEntry(db, scope, post);
      })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    await inOrg(async (db) => {
      expect(await db.pharmacySale.count({ where: { id: post.sourceId } })).toBe(0);
      expect(await db.financeJournalEntry.count({ where: { sourceId: post.sourceId } })).toBe(0);
    });
  });

  it.each([
    ['start', startsAt, false],
    ['last millisecond', new Date(endsAt.getTime() - 1), false],
    ['before', new Date(startsAt.getTime() - 1), true],
    ['end', endsAt, true],
  ] as const)('uses an inclusive start and exclusive end: %s', async (_label, date, allowed) => {
    const post = input(date);
    const result = inOrg((db) => journal.postJournalEntry(db, scope, post));
    if (allowed) await expect(result).resolves.toMatchObject({ occurredAt: date });
    else await expect(result).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
  });

  it('keeps another branch and tenant independent', async () => {
    await expect(
      inOrg((db) => journal.postJournalEntry(db, scope, input(at, otherBranch)))
    ).resolves.toBeDefined();
    // Same dimensions under another tenant cannot see this tenant's period.
    await expect(
      inOrg(
        (db) => journal.postJournalEntry(db, { organizationId: otherOrg, actorId }, input()),
        otherOrg
      )
    ).resolves.toBeDefined();
  });

  it('enforces the guard on a direct entry INSERT that bypasses the helper', async () => {
    await expect(
      inOrg((db) =>
        db.financeJournalEntry.create({
          data: {
            ...input(),
            lines: undefined,
            organizationId,
            actorId,
          },
        })
      )
    ).rejects.toThrow('PHARMACY_ACCOUNTING_PERIOD_CLOSED');
  });

  it('enforces a closed line branch even without an entry branch', async () => {
    await expect(
      inOrg(async (db) => {
        const entry = await db.financeJournalEntry.create({
          data: {
            ...input(at, null),
            lines: undefined,
            organizationId,
            actorId,
          },
        });
        await db.financeJournalLine.create({
          data: {
            organizationId,
            entryId: entry.id,
            branchId,
            accountCode: 'CASH',
            side: 'DEBIT',
            amountMinor: 5000,
          },
        });
      })
    ).rejects.toThrow('PHARMACY_ACCOUNTING_PERIOD_CLOSED');
  });

  it('allows an existing replay after close but refuses a new closed-period reversal', async () => {
    const post = input(at, otherBranch);
    const original = await inOrg((db) => journal.postJournalEntry(db, scope, post));
    const period = await inOrg((db) =>
      bookkeeping.closeAccountingPeriod(
        db,
        { ...scope, branchId: otherBranch },
        { startsAt, endsAt }
      )
    );
    await expect(inOrg((db) => journal.postJournalEntry(db, scope, post))).resolves.toMatchObject({
      id: original.id,
    });
    await expect(
      inOrg((db) =>
        journal.reverseJournalEntry(db, scope, {
          entryId: original.id,
          reason: 'Synthetic correction',
          at,
          idempotencyKey: key(),
        })
      )
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    await expect(
      inOrg((db) =>
        journal.reverseJournalEntry(db, scope, {
          entryId: original.id,
          reason: 'Synthetic correction in open period',
          at: endsAt,
          idempotencyKey: key(),
        })
      )
    ).resolves.toMatchObject({ reversesEntryId: original.id });
    await inOrg((db) =>
      bookkeeping.reopenAccountingPeriod(
        db,
        { ...scope, branchId: otherBranch },
        { periodId: period.id, reason: 'Synthetic reopen' }
      )
    );
    await expect(
      inOrg((db) => journal.postJournalEntry(db, scope, input(at, otherBranch)))
    ).resolves.toBeDefined();
  });

  it('a direct close that wins the lock makes a waiting raw posting fail', async () => {
    const close = new pg.Client({ connectionString: runtimeUrl });
    const post = new pg.Client({ connectionString: runtimeUrl });
    await close.connect();
    await post.connect();
    let posting: Promise<pg.QueryResult> | undefined;
    try {
      for (const client of [close, post]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_organization_id', $1, true)", [
          organizationId,
        ]);
      }
      await close.query(
        `INSERT INTO pharmacy_accounting_periods
        (id,"organizationId","branchId","startsAt","endsAt",status,"closedAt","closedByUserId")
        VALUES ($1,$2,$3,$4,$5,'CLOSED',now(),$6)`,
        [key(), organizationId, otherBranch, endsAt, new Date('2027-01-01'), actorId]
      );
      const pid = (await post.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      posting = post.query(
        `INSERT INTO finance_journal_entries
        (id,"organizationId","branchId","sourceKind","sourceId",description,"actorId","occurredAt","idempotencyKey")
        VALUES ($1,$2,$3,'PHARMACY_TENDER',$4,'Race regression',$5,$6,$7)`,
        [key(), organizationId, otherBranch, key(), actorId, new Date('2026-12-16'), key()]
      );
      // Attach the rejection assertion before releasing the winning close.
      const rejected = expect(posting).rejects.toThrow('PHARMACY_ACCOUNTING_PERIOD_CLOSED');
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const result = await close.query('SELECT wait_event FROM pg_stat_activity WHERE pid = $1', [
          pid,
        ]);
        if (result.rows[0]?.wait_event === 'advisory') {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        await close.query('SELECT pg_stat_clear_snapshot()');
      }
      expect(waiting).toBe(true);
      await close.query('COMMIT');
      await rejected;
    } finally {
      await close.query('ROLLBACK');
      await posting?.catch(() => undefined);
      await post.query('ROLLBACK');
      await close.end();
      await post.end();
    }
  });
});
