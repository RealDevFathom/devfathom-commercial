// Run the actual fact-reader SQL against disposable tables without changing migrated data.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { PharmacyAnomalySignalKind } from '@/generated/prisma/client';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyAnomalyFacts } from './anomaly-signals-operations';
import { detectPharmacyAnomalies } from './anomaly-signals';

const url = process.env.TEST_DATABASE_URL ?? process.env.M8_TEST_RUNTIME_DATABASE_URL;
const database = url ? describe : describe.skip;
const now = new Date('2026-09-04T12:00:00Z');
let client: Client;

database('cash anomaly SQL reconciliation', () => {
  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE pharmacy_daily_closes (
        id text, "organizationId" text, "branchId" text, "actorId" text,
        "businessDate" date, "cashExpectedMinor" integer, "createdAt" timestamptz,
        "isFinal" boolean, sequence integer
      ) ON COMMIT DROP;
      CREATE TEMP TABLE pharmacy_tenders (
        id text, "organizationId" text, "branchId" text, "businessDate" date,
        type text, "amountMinor" integer
      ) ON COMMIT DROP;
      CREATE TEMP TABLE pharmacy_refunds (
        "organizationId" text, "branchId" text, "businessDate" date,
        "originalTenderId" text, "amountMinor" integer
      ) ON COMMIT DROP;
      CREATE TEMP TABLE pharmacy_drawer_sessions (
        id text, "organizationId" text, "branchId" text, "businessDate" date
      ) ON COMMIT DROP;
      CREATE TEMP TABLE pharmacy_drawer_movements (
        "organizationId" text, "drawerSessionId" text, kind text, "amountMinor" integer
      ) ON COMMIT DROP;
      INSERT INTO pharmacy_daily_closes VALUES
        ('close', 'org', 'branch', 'cashier', '2026-09-04', 970000, '2026-09-04T12:00Z', true, 1);
      INSERT INTO pharmacy_tenders VALUES
        ('cash', 'org', 'branch', '2026-09-04', 'CASH', 1000000),
        ('card', 'org', 'branch', '2026-09-04', 'CARD', 300000);
      INSERT INTO pharmacy_refunds VALUES
        ('org', 'branch', '2026-09-04', 'cash', 100000),
        ('org', 'branch', '2026-09-04', 'card', 200000);
      INSERT INTO pharmacy_drawer_sessions VALUES
        ('drawer', 'org', 'branch', '2026-09-04'),
        ('other_day', 'org', 'branch', '2026-09-03'),
        ('other_branch', 'org', 'other_branch', '2026-09-04'),
        ('other_org', 'other_org', 'branch', '2026-09-04');
      INSERT INTO pharmacy_drawer_movements VALUES
        ('org', 'drawer', 'OPENING_FLOAT', 100000),
        ('org', 'drawer', 'PAID_IN', 20000),
        ('org', 'drawer', 'PAID_OUT', 50000),
        ('org', 'drawer', 'CASH_SALE', 1000000),
        ('org', 'drawer', 'CASH_REFUND', 100000),
        ('org', 'drawer', 'CLOSING_COUNT', 970000),
        ('org', 'other_day', 'OPENING_FLOAT', 400000),
        ('org', 'other_branch', 'OPENING_FLOAT', 400000),
        ('other_org', 'other_org', 'OPENING_FLOAT', 400000);
    `);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('expands a populated enum to accept both new kinds while preserving old values', async () => {
    // Use a separate session: enum additions must commit before inserts use them.
    // Everything lives in pg_temp and disappears when this connection closes.
    const enumClient = new Client({ connectionString: url });
    await enumClient.connect();
    try {
      await enumClient.query(`
        CREATE TYPE pg_temp."PharmacyAnomalySignalKind" AS ENUM
          ('SHRINKAGE', 'DISCOUNT_OVERRIDE', 'GHOST_RETURN', 'CASH_VARIANCE', 'PURCHASE_PRICE_DRIFT');
        CREATE TEMP TABLE anomaly_kind_fixture (kind pg_temp."PharmacyAnomalySignalKind");
        INSERT INTO anomaly_kind_fixture VALUES ('CASH_VARIANCE');
      `);
      await enumClient.query(
        readFileSync(
          'prisma/migrations/20261029020000_pharmacy_anomaly_signal_kinds/migration.sql',
          'utf8'
        )
      );
      for (const kind of ['VOID_ABUSE', 'TENDER_MISMATCH'] as const) {
        expect(PharmacyAnomalySignalKind[kind]).toBe(kind);
        await enumClient.query('INSERT INTO anomaly_kind_fixture VALUES ($1)', [kind]);
      }
      expect((await enumClient.query('SELECT kind::text FROM anomaly_kind_fixture')).rows).toEqual([
        { kind: 'CASH_VARIANCE' },
        { kind: 'VOID_ABUSE' },
        { kind: 'TENDER_MISMATCH' },
      ]);
    } finally {
      await enumClient.end();
    }
  });

  it('keeps a balanced day clear and detects a real discrepancy after drawer adjustments', async () => {
    const queryRaw = vi.fn(async (query: Prisma.Sql) => {
      if (!query.text.includes('AS "tenderNetMinor"')) return [];
      return (await client.query(query.text, [...query.values])).rows;
    });
    const read = () =>
      readPharmacyAnomalyFacts(
        { $queryRaw: queryRaw } as unknown as ScopedDb,
        { branchIds: ['branch'], from: '2026-09-04', to: '2026-09-04' },
        now
      );
    const balanced = await read();
    expect(balanced.facts.tenderMismatch).toEqual([
      expect.objectContaining({
        tenderNetMinor: 900000,
        closeExpectedMinor: 900000,
        mismatchMinor: 0,
      }),
    ]);
    const detect = (result: typeof balanced) =>
      detectPharmacyAnomalies(result.facts, {
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
        computedAt: now,
      });
    expect(detect(balanced)).toEqual([]);
    await client.query('SAVEPOINT held_cash');
    await client.query(`INSERT INTO pharmacy_drawer_movements VALUES ('org','drawer','REJECTED_OFFLINE_CASH',38000);
      UPDATE pharmacy_daily_closes SET "cashExpectedMinor"="cashExpectedMinor"+38000`);
    expect((await read()).facts.tenderMismatch).toEqual(balanced.facts.tenderMismatch);
    await client.query('ROLLBACK TO SAVEPOINT held_cash');
    await client.query('UPDATE pharmacy_daily_closes SET "cashExpectedMinor"=1170000');
    expect(detect(await read())).toEqual([
      expect.objectContaining({
        kind: 'TENDER_MISMATCH',
        scope: { branchId: 'branch', userId: 'cashier' },
        exactNumbers: expect.objectContaining({ mismatchMinor: -200000 }),
      }),
    ]);
  });
});
