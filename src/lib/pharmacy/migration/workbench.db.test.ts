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
import { profileTable } from './profiler';
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
const signerB = `user_wha1163_b_${suffix}`;
const branchA = `branch_wha1163_a_${suffix}`;
const branchB = `branch_wha1163_b_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  workbench: typeof import('./workbench');
  assertRlsEnforcingRole: (typeof import('@/lib/testing/rls-role-guard'))['assertRlsEnforcingRole'];
};

let deps: Deps;

function inOrgA<T>(work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgA, async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branchA);
    return work(tx);
  });
}

function inOrgB<T>(work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgB, async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branchB);
    return work(tx);
  });
}

/** Import 1/5: every workbench write authorizes itself (pharmacy:data-import, branch). */
const requestA = {
  organizationId: orgA,
  branchId: branchA,
  actor: { userId: signerA, role: 'ADMIN' },
};
const requestB = {
  organizationId: orgB,
  branchId: branchB,
  actor: { userId: signerB, role: 'ADMIN' },
};

/** Register the fixture and profile it into a batch, as a caller would. */
async function profileMissingFieldsFixture(db: ScopedDb, label: string, request = requestA) {
  const bytes = readFileSync(MISSING_FIELDS_FIXTURE);
  const source = await deps.workbench.recordSource(db, request, {
    kind: 'EXCEL_CSV',
    fileName: 'excel-missing-fields.csv',
    bytes,
  });
  const result = profileTable(excelCsvProfiler, parseDelimitedText(bytes.toString('utf8')));
  const persisted = await deps.workbench.persistProfile(db, request, {
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

    // Import 1/5: the signers hold pharmacy:data-import through a persisted organization role.
    for (const [tenant, organizationId, signer] of [
      ['a', orgA, signerA],
      ['b', orgB, signerB],
    ] as const) {
      await owner.query(
        `INSERT INTO "organization_roles" ("id", "organizationId", "key", "name", "createdAt", "updatedAt")
         VALUES ($1, $2, $1, 'Import lead', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [`role_wha1163_${tenant}_${suffix}`, organizationId]
      );
      await owner.query(
        `INSERT INTO "organization_role_permissions" ("id", "organizationId", "organizationRoleId", "capability", "effect")
         VALUES ($1, $2, $3, 'pharmacy:data-import', 'ALLOW')`,
        [`perm_wha1163_${tenant}_${suffix}`, organizationId, `role_wha1163_${tenant}_${suffix}`]
      );
      await owner.query(
        `INSERT INTO "users"
          ("id", "organizationId", "name", "email", "role", "department", "title",
           "startDate", "status", "organizationRoleId", "createdAt", "updatedAt")
         VALUES ($1, $2, 'Migration Lead', $3, 'ADMIN', 'LEADERSHIP', 'Pharmacist',
           CURRENT_TIMESTAMP, 'ACTIVE', $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [signer, organizationId, `${signer}@example.test`, `role_wha1163_${tenant}_${suffix}`]
      );
    }
    await owner.query(
      `INSERT INTO "pharmacy_branches" ("id","organizationId","code","name","addressLine","city","provinceCode","createdAt","updatedAt")
       VALUES ($1,$2,'A','Branch A','Test','Karachi','SD',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
              ($3,$4,'B','Branch B','Test','Karachi','SD',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [branchA, orgA, branchB, orgB]
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
      first: await deps.workbench.recordSource(db, requestA, {
        kind: 'EXCEL_CSV',
        fileName: 'excel-clean.csv',
        bytes,
      }),
      second: await deps.workbench.recordSource(db, requestA, {
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
      const created = await deps.workbench.recordSource(db, requestA, {
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
      { table: 'pharmacy_migration_rows', trigger: 'pharmacy_migration_rows_legacy_lineage' },
      { table: 'pharmacy_migration_sources', trigger: 'pharmacy_migration_sources_legacy_lineage' },
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

    expect(batch.status).toBe('PREVIEW');
    expect(batch.rowCount).toBe(5);
    expect(batch.exceptionCount).toBe(5);
    expect(batch.profiledAt).not.toBeNull();
    expect(batch.profilerVersion).toBe(excelCsvProfiler.version);
  });

  it('records the sign-off actor and time, and clears the open queue', async () => {
    const { before, after, signed } = await inOrgA(async (db) => {
      const { persisted } = await profileMissingFieldsFixture(db, 'sign-off');
      const openBefore = await deps.workbench.openExceptionCounts(db, requestA, persisted.batchId);
      const target = await db.pharmacyMigrationException.findFirstOrThrow({
        where: { batchId: persisted.batchId, bucket: 'MISSING_MRP' },
      });

      await deps.workbench.signOffException(db, requestA, {
        exceptionId: target.id,
        note: 'Confirmed against the paper purchase invoice.',
      });

      return {
        before: openBefore,
        after: await deps.workbench.openExceptionCounts(db, requestA, persisted.batchId),
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
      await deps.workbench.signOffException(db, requestA, { exceptionId: target.id });
      return target.id;
    });

    // The application path reports it as "no open exception"…
    await expect(
      inOrgA((db) => deps.workbench.signOffException(db, requestA, { exceptionId }))
    ).rejects.toThrow(/No open exception/);

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
    const b = await inOrgB((db) => profileMissingFieldsFixture(db, 'tenant B', requestB));

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
      inOrgB((db) => deps.workbench.signOffException(db, requestB, { exceptionId }))
    ).rejects.toThrow(/No open exception/);

    const stillOpen = await inOrgA((db) =>
      db.pharmacyMigrationException.findUniqueOrThrow({ where: { id: exceptionId } })
    );
    expect(stillOpen.status).toBe('OPEN');
    expect(stillOpen.signedOffByUserId).toBeNull();
  });
});
