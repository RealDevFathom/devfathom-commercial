/**
 * PH-MIG / MIG-01, MIG-02 — the workbench against migrated PostgreSQL with
 * FORCED row-level security.
 *
 * These cases only mean anything against a real database. "The source is never
 * modified" is a policy omission plus a trigger; "sign-off is final" is a
 * trigger; and the cross-tenant case is an RLS predicate. A mocked client would
 * assert that the code calls Prisma, not that any of those hold. Skipped (never
 * silently passed) when the database URLs are absent.
 *
 * ON WHAT THE TRIGGERS CAN AND CANNOT PROVE HERE. The migration guards the
 * read-only tables twice: SELECT/INSERT-only policies, and a trigger that raises.
 * Because FORCE ROW LEVEL SECURITY subjects the table owner too, an UPDATE from
 * any role this suite may legitimately connect as is filtered to zero rows
 * BEFORE a row trigger could fire. So the read-only tables are proved by the
 * zero-rows outcome plus a catalog assertion that the trigger is installed; the
 * exception table, which does carry an UPDATE policy, has its triggers proved by
 * actually provoking them.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { excelCsvProfiler } from './excel-csv-profiler';
import { margBatchStockProfiler, parseMargBatchStockText } from './marg-batch-stock-profiler';
import { profileTable } from './profiler';
import {
  decodeTallyXmlBytes,
  flattenTallyXml,
  tallyXmlProfiler,
  unmappedTallyRequiredFields,
} from './tally-xml-profiler';
import { parseDelimitedText } from './source-values';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const FIXTURE_DIR = join(process.cwd(), 'src/lib/pharmacy/migration/fixtures');
const MISSING_FIELDS_FIXTURE = join(FIXTURE_DIR, 'excel-missing-fields.csv');

const suffix = randomBytes(6).toString('hex');
const orgA = `org_wha1163_a_${suffix}`;
const orgB = `org_wha1163_b_${suffix}`;
const signerA = `user_wha1163_a_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  workbench: typeof import('./workbench');
  assertRlsEnforcingRole: (typeof import('@/lib/testing/rls-role-guard'))['assertRlsEnforcingRole'];
};

let deps: Deps;

function inOrgA<T>(work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgA, work);
}

function inOrgB<T>(work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgB, work);
}

/** Register the fixture and profile it into a batch, as a caller would. */
async function profileMissingFieldsFixture(db: ScopedDb, label: string) {
  const bytes = readFileSync(MISSING_FIELDS_FIXTURE);
  const source = await deps.workbench.recordSource(db, {
    kind: 'EXCEL_CSV',
    fileName: 'excel-missing-fields.csv',
    bytes,
  });
  const result = profileTable(excelCsvProfiler, parseDelimitedText(bytes.toString('utf8')), {
    quantityUnit: 'UNITS',
  });
  const persisted = await deps.workbench.persistProfile(db, {
    sourceId: source.id,
    label,
    profiler: excelCsvProfiler,
    result,
  });
  return { source, result, persisted };
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL || !OWNER_DATABASE_URL) return;
  // The runtime role must NOT be the owner, or FORCE RLS proves nothing here.
  expect(OWNER_DATABASE_URL).not.toBe(TEST_DATABASE_URL);

  const [scopedDb, workbench, roleGuard, verticalCatalog] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./workbench'),
    import('@/lib/testing/rls-role-guard'),
    import('@/lib/vertical-catalog'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    workbench,
    assertRlsEnforcingRole: roleGuard.assertRlsEnforcingRole,
  };
  await deps.assertRlsEnforcingRole(scopedDb.withPlatformDb);

  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO "organizations"
        ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'PH-MIG A', 'PH-MIG A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              ($3, $4, 'PH-MIG B', 'PH-MIG B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [orgA, `wha1163-a-${suffix}`, orgB, `wha1163-b-${suffix}`]
    );

    // `users.department` is a composite foreign key onto organization_departments,
    // so the sign-off actor needs its organization's catalog first.
    for (const [tenant, organizationId] of [
      ['a', orgA],
      ['b', orgB],
    ] as const) {
      for (const department of verticalCatalog.defaultDepartmentRowsForVertical('AGENCY')) {
        await owner.query(
          `INSERT INTO "organization_departments"
            ("id", "organizationId", "key", "name", "sortOrder", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            `dep_${suffix}_${tenant}_${department.key.toLowerCase()}`,
            organizationId,
            department.key,
            department.name,
            department.sortOrder,
          ]
        );
      }
    }

    await owner.query(
      `INSERT INTO "users"
        ("id", "organizationId", "name", "email", "role", "department", "title",
         "startDate", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, 'Migration Lead', $3, 'ADMIN', 'LEADERSHIP', 'Pharmacist',
         CURRENT_TIMESTAMP, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [signerA, orgA, `${signerA}@example.test`]
    );
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await owner.end();
  }
}, 60_000);

describeIfDatabase('PH-MIG workbench — MIG-01 read-only source evidence', () => {
  it('leaves the source file byte-identical after a full profiling pass', async () => {
    const before = {
      bytes: readFileSync(MISSING_FIELDS_FIXTURE),
      stat: statSync(MISSING_FIELDS_FIXTURE),
    };

    const { source } = await inOrgA((db) => profileMissingFieldsFixture(db, 'hash evidence'));

    const after = {
      bytes: readFileSync(MISSING_FIELDS_FIXTURE),
      stat: statSync(MISSING_FIELDS_FIXTURE),
    };

    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.stat.size).toBe(before.stat.size);
    expect(after.stat.mtimeMs).toBe(before.stat.mtimeMs);
    // The digest the database holds is the digest of the bytes still on disk.
    expect(source.contentHash).toBe(deps.workbench.hashSourceBytes(after.bytes));
    expect(source.byteSize).toBe(BigInt(after.stat.size));
  });

  it('returns the existing source when the same bytes are registered again', async () => {
    const bytes = readFileSync(join(FIXTURE_DIR, 'excel-clean.csv'));

    const { first, second } = await inOrgA(async (db) => ({
      first: await deps.workbench.recordSource(db, {
        kind: 'EXCEL_CSV',
        fileName: 'excel-clean.csv',
        bytes,
      }),
      second: await deps.workbench.recordSource(db, {
        kind: 'EXCEL_CSV',
        fileName: 'excel-clean-resent.csv',
        bytes,
      }),
    }));

    expect(second.id).toBe(first.id);
    expect(second.fileName).toBe('excel-clean.csv');
  });

  it('refuses every update and delete against a registered source', async () => {
    const { source, updated, deleted, stillThere } = await inOrgA(async (db) => {
      const created = await deps.workbench.recordSource(db, {
        kind: 'ABUZAR',
        fileName: 'abuzar-stock-export.csv',
        bytes: readFileSync(join(FIXTURE_DIR, 'abuzar-stock-export.csv')),
      });
      return {
        source: created,
        updated: await db.pharmacyMigrationSource.updateMany({
          where: { id: created.id },
          data: { fileName: 'tampered.csv' },
        }),
        deleted: await db.pharmacyMigrationSource.deleteMany({ where: { id: created.id } }),
        stillThere: await db.pharmacyMigrationSource.findUnique({ where: { id: created.id } }),
      };
    });

    expect(updated.count).toBe(0);
    expect(deleted.count).toBe(0);
    expect(stillThere?.fileName).toBe('abuzar-stock-export.csv');
    expect(stillThere?.contentHash).toBe(source.contentHash);
  });

  it('installs the second read-only guard as a trigger on both evidence tables', async () => {
    const triggers = await deps.withPlatformDb((db) =>
      db.$queryRawUnsafe<{ table: string; trigger: string }[]>(
        `SELECT relation.relname AS "table", trigger.tgname AS "trigger"
           FROM pg_trigger AS trigger
           JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
          WHERE NOT trigger.tgisinternal
            AND relation.relname IN ('pharmacy_migration_sources', 'pharmacy_migration_rows')
          ORDER BY relation.relname, trigger.tgname`
      )
    );

    expect(triggers).toEqual([
      { table: 'pharmacy_migration_rows', trigger: 'pharmacy_migration_rows_append_only' },
      { table: 'pharmacy_migration_sources', trigger: 'pharmacy_migration_sources_read_only' },
    ]);
  });

  it('keeps profiled rows append-only', async () => {
    const { updated, deleted } = await inOrgA(async (db) => {
      const { persisted } = await profileMissingFieldsFixture(db, 'append-only');
      return {
        updated: await db.pharmacyMigrationRow.updateMany({
          where: { batchId: persisted.batchId },
          data: { batchNumber: 'INVENTED' },
        }),
        deleted: await db.pharmacyMigrationRow.deleteMany({
          where: { batchId: persisted.batchId },
        }),
      };
    });

    expect(updated.count).toBe(0);
    expect(deleted.count).toBe(0);
  });
});

describeIfDatabase('PH-MIG workbench — MIG-02 exception workbench', () => {
  it('persists every profiled row with its source key and import batch', async () => {
    const { persisted, rows } = await inOrgA(async (db) => {
      const profiled = await profileMissingFieldsFixture(db, 'row identity');
      return {
        persisted: profiled.persisted,
        rows: await db.pharmacyMigrationRow.findMany({
          where: { batchId: profiled.persisted.batchId },
          orderBy: { rowNumber: 'asc' },
        }),
      };
    });

    expect(persisted.rowCount).toBe(5);
    expect(rows.map((row) => row.sourceKey)).toEqual(['1', '2', '3', '4', '5']);
    expect(rows.every((row) => row.batchId === persisted.batchId)).toBe(true);
    // The raw cells travelled into the database untouched.
    expect((rows[3]!.rawPayload as Record<string, string>)['Pack Size']).toBe('bottle');
  });

  it('stores the missing values as NULL rather than defaulting them', async () => {
    const rows = await inOrgA(async (db) => {
      const { persisted } = await profileMissingFieldsFixture(db, 'no defaults');
      return db.pharmacyMigrationRow.findMany({
        where: { batchId: persisted.batchId },
        orderBy: { rowNumber: 'asc' },
      });
    });

    expect(rows[0]!.batchNumber).toBeNull();
    expect(rows[1]!.expiryDate).toBeNull();
    expect(rows[2]!.mrpMinor).toBeNull();
    expect(rows[3]!.packFactor).toBeNull();
    expect(rows[4]!.quantityCanonical).toBeNull();
    // Canonical integers survive the round trip exactly.
    expect(rows[0]!.mrpMinor).toBe(BigInt(25000));
    expect(rows[0]!.packFactor).toBe(BigInt(100));
  });

  it('writes the exact exception buckets the profiler derived, linked to their rows', async () => {
    const { persisted, exceptions } = await inOrgA(async (db) => {
      const profiled = await profileMissingFieldsFixture(db, 'buckets');
      return {
        persisted: profiled.persisted,
        exceptions: await db.pharmacyMigrationException.findMany({
          where: { batchId: profiled.persisted.batchId },
          include: { row: { select: { sourceKey: true } } },
          orderBy: { row: { rowNumber: 'asc' } },
        }),
      };
    });

    expect(persisted.buckets).toEqual({
      MISSING_BATCH: 1,
      MISSING_EXPIRY: 1,
      MISSING_MRP: 1,
      UNIT_AMBIGUOUS: 2,
    });
    expect(
      exceptions.map((exception) => [
        exception.row?.sourceKey,
        exception.bucket,
        exception.severity,
      ])
    ).toEqual([
      ['1', 'MISSING_BATCH', 'BLOCKING'],
      ['2', 'MISSING_EXPIRY', 'BLOCKING'],
      ['3', 'MISSING_MRP', 'BLOCKING'],
      ['4', 'UNIT_AMBIGUOUS', 'BLOCKING'],
      ['5', 'UNIT_AMBIGUOUS', 'BLOCKING'],
    ]);
  });

  it('marks the batch profiled with counts that match what it wrote', async () => {
    const batch = await inOrgA(async (db) => {
      const { persisted } = await profileMissingFieldsFixture(db, 'batch status');
      return db.pharmacyMigrationBatch.findUniqueOrThrow({ where: { id: persisted.batchId } });
    });

    expect(batch.status).toBe('PROFILED');
    expect(batch.rowCount).toBe(5);
    expect(batch.exceptionCount).toBe(5);
    expect(batch.profiledAt).not.toBeNull();
    expect(batch.profilerVersion).toBe(excelCsvProfiler.version);
  });

  it('records the sign-off actor and time, and clears the open queue', async () => {
    const { before, after, signed } = await inOrgA(async (db) => {
      const { persisted } = await profileMissingFieldsFixture(db, 'sign-off');
      const openBefore = await deps.workbench.openExceptionCounts(db, persisted.batchId);
      const target = await db.pharmacyMigrationException.findFirstOrThrow({
        where: { batchId: persisted.batchId, bucket: 'MISSING_MRP' },
      });

      await deps.workbench.signOffException(db, {
        exceptionId: target.id,
        actorUserId: signerA,
        note: 'Confirmed against the paper purchase invoice.',
      });

      return {
        before: openBefore,
        after: await deps.workbench.openExceptionCounts(db, persisted.batchId),
        signed: await db.pharmacyMigrationException.findUniqueOrThrow({ where: { id: target.id } }),
      };
    });

    expect(before.MISSING_MRP).toBe(1);
    expect(after.MISSING_MRP).toBeUndefined();
    expect(after).toEqual({ MISSING_BATCH: 1, MISSING_EXPIRY: 1, UNIT_AMBIGUOUS: 2 });
    expect(signed.status).toBe('SIGNED_OFF');
    expect(signed.signedOffByUserId).toBe(signerA);
    expect(signed.signedOffAt).not.toBeNull();
    expect(signed.signOffNote).toBe('Confirmed against the paper purchase invoice.');
  });

  it('refuses a second sign-off and refuses to rewrite an exception identity', async () => {
    const exceptionId = await inOrgA(async (db) => {
      const { persisted } = await profileMissingFieldsFixture(db, 'sign-off finality');
      const target = await db.pharmacyMigrationException.findFirstOrThrow({
        where: { batchId: persisted.batchId, bucket: 'MISSING_BATCH' },
      });
      await deps.workbench.signOffException(db, { exceptionId: target.id, actorUserId: signerA });
      return target.id;
    });

    // The application path reports it as "no open exception"…
    await expect(
      inOrgA((db) => deps.workbench.signOffException(db, { exceptionId, actorUserId: signerA }))
    ).rejects.toThrow(/No open migration exception/);

    // …and the database refuses it even when the status filter is bypassed.
    await expect(
      inOrgA((db) =>
        db.pharmacyMigrationException.update({
          where: { id: exceptionId },
          data: { signOffNote: 'reopened' },
        })
      )
    ).rejects.toThrow(/sign-off is final/);
  });

  it('refuses to change which row or bucket an open exception refers to', async () => {
    const exceptionId = await inOrgA(async (db) => {
      const { persisted } = await profileMissingFieldsFixture(db, 'identity immutable');
      const target = await db.pharmacyMigrationException.findFirstOrThrow({
        where: { batchId: persisted.batchId, bucket: 'MISSING_EXPIRY' },
      });
      return target.id;
    });

    await expect(
      inOrgA((db) =>
        db.pharmacyMigrationException.update({
          where: { id: exceptionId },
          data: { bucket: 'PARTY_UNMATCHED' },
        })
      )
    ).rejects.toThrow(/identity is immutable/);
  });
});

describeIfDatabase('PH-MIG workbench — cross-tenant isolation', () => {
  it('shows one tenant nothing of the other, in either direction', async () => {
    const a = await inOrgA((db) => profileMissingFieldsFixture(db, 'tenant A'));
    // Tenant B profiles its own copy, so "isolated" is distinguishable from "empty".
    const b = await inOrgB((db) => profileMissingFieldsFixture(db, 'tenant B'));

    expect(b.persisted.batchId).not.toBe(a.persisted.batchId);

    const fromB = await inOrgB(async (db) => ({
      sources: await db.pharmacyMigrationSource.findMany({ select: { id: true } }),
      batches: await db.pharmacyMigrationBatch.findMany({ select: { id: true } }),
      foreignRows: await db.pharmacyMigrationRow.count({ where: { batchId: a.persisted.batchId } }),
      foreignExceptions: await db.pharmacyMigrationException.count({
        where: { batchId: a.persisted.batchId },
      }),
      ownRows: await db.pharmacyMigrationRow.count({ where: { batchId: b.persisted.batchId } }),
    }));

    expect(fromB.sources.map((source) => source.id)).not.toContain(a.source.id);
    expect(fromB.sources.map((source) => source.id)).toContain(b.source.id);
    expect(fromB.batches.map((batch) => batch.id)).not.toContain(a.persisted.batchId);
    expect(fromB.foreignRows).toBe(0);
    expect(fromB.foreignExceptions).toBe(0);
    expect(fromB.ownRows).toBe(5);
  });

  it('cannot sign off another tenant exception even with its identifier', async () => {
    const exceptionId = await inOrgA(async (db) => {
      const { persisted } = await profileMissingFieldsFixture(db, 'cross-tenant sign-off');
      const target = await db.pharmacyMigrationException.findFirstOrThrow({
        where: { batchId: persisted.batchId, bucket: 'MISSING_MRP' },
      });
      return target.id;
    });

    await expect(
      inOrgB((db) => deps.workbench.signOffException(db, { exceptionId, actorUserId: signerA }))
    ).rejects.toThrow(/No open migration exception/);

    const stillOpen = await inOrgA((db) =>
      db.pharmacyMigrationException.findUniqueOrThrow({ where: { id: exceptionId } })
    );
    expect(stillOpen.status).toBe('OPEN');
    expect(stillOpen.signedOffByUserId).toBeNull();
  });
});

describeIfDatabase('PH-MIG workbench — #721 Tally XML and Marg Batch Stock presets', () => {
  it('records a TALLY_XML source and persists the sample with zero exceptions', async () => {
    const bytes = readFileSync(join(FIXTURE_DIR, 'tally-masters-sample.xml'));
    const flattened = flattenTallyXml(decodeTallyXmlBytes(bytes));
    const result = profileTable(tallyXmlProfiler, flattened.table, { quantityUnit: 'UNITS' });
    expect(unmappedTallyRequiredFields(result.columnMap)).toEqual([]);

    const { source, persisted, batch, rows } = await inOrgA(async (db) => {
      const recorded = await deps.workbench.recordSource(db, {
        kind: 'TALLY_XML',
        fileName: 'tally-masters-sample.xml',
        bytes,
      });
      const saved = await deps.workbench.persistProfile(db, {
        sourceId: recorded.id,
        label: 'tally sample',
        profiler: tallyXmlProfiler,
        result,
      });
      return {
        source: recorded,
        persisted: saved,
        batch: await db.pharmacyMigrationBatch.findUniqueOrThrow({ where: { id: saved.batchId } }),
        rows: await db.pharmacyMigrationRow.findMany({
          where: { batchId: saved.batchId },
          orderBy: { rowNumber: 'asc' },
        }),
      };
    });

    expect(source.kind).toBe('TALLY_XML');
    expect(persisted.rowCount).toBe(6);
    expect(persisted.exceptionCount).toBe(0);
    expect(batch.profilerVersion).toBe(tallyXmlProfiler.version);
    expect(rows[0]).toMatchObject({
      batchNumber: 'B2411',
      mrpMinor: BigInt(2500),
      costMinor: BigInt(2125),
      quantityCanonical: BigInt(100),
    });
    expect(rows[5]).toMatchObject({
      customerName: 'Al-Shifa Clinic',
      balanceMinor: BigInt(275000),
    });
  });

  it('records a MARG_EXCEL source and persists the synthetic batch stock file', async () => {
    const bytes = readFileSync(join(FIXTURE_DIR, 'marg-batch-stock-synthetic.csv'));
    const result = profileTable(
      margBatchStockProfiler,
      parseMargBatchStockText(bytes.toString('utf8')).table,
      { quantityUnit: 'PACKS' }
    );

    const { source, persisted, rows } = await inOrgA(async (db) => {
      const recorded = await deps.workbench.recordSource(db, {
        kind: 'MARG_EXCEL',
        fileName: 'marg-batch-stock-synthetic.csv',
        bytes,
      });
      const saved = await deps.workbench.persistProfile(db, {
        sourceId: recorded.id,
        label: 'marg synthetic',
        profiler: margBatchStockProfiler,
        result,
      });
      return {
        source: recorded,
        persisted: saved,
        rows: await db.pharmacyMigrationRow.findMany({
          where: { batchId: saved.batchId },
          orderBy: { rowNumber: 'asc' },
        }),
      };
    });

    expect(source.kind).toBe('MARG_EXCEL');
    expect(persisted.rowCount).toBe(4);
    expect(persisted.exceptionCount).toBe(0);
    expect(rows.map((row) => row.batchNumber)).toEqual(['B2411', 'B2502', 'AG-77', 'BR-9012']);
    expect((rows[0]!.rawPayload as Record<string, string>)['Item Code']).toBe('M001');
  });
});
