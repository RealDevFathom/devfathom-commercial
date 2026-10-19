// Synthetic, isolated PostgreSQL only. Real middleware/ABAC/audit; supplied session and entitlement views are fixtures, not login/package-resolution proof.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';
const url = process.env.WHA1618_STAGED_TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
let tenant: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let platform: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let router: typeof import('./pharmacy-staged-review').pharmacyStagedReviewRouter;
const org = 'staged_synthetic_a_v2',
  foreign = 'staged_synthetic_b_v2';
const hash = 'a'.repeat(64);
const scope = { branchId: `${org}_branch`, sourceId: `${org}_source`, batchId: `${org}_batch` };
const tables = [
  'pharmacy_migration_sources',
  'pharmacy_migration_batches',
  'pharmacy_migration_rows',
  'pharmacy_migration_exceptions',
  'pharmacy_medicines',
  'pharmacy_reference_connectors',
  'pharmacy_reference_connector_runs',
  'pharmacy_reference_connector_proposals',
  'pharmacy_medicine_provenance',
  'pharmacy_medicine_publication_batches',
  'pharmacy_medicine_publication_entries',
];
let before: unknown;
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const organization of [org, foreign]) {
    await tenant(organization, async (db) => {
      for (const table of tables)
        result[`${organization}:${table}`] = await db.$queryRawUnsafe(
          `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`
        );
    });
  }
  return result;
}
function caller(
  db: ScopedDb,
  options: {
    role?: string;
    enabled?: boolean;
    status?: string;
    revoked?: boolean;
    denied?: boolean;
    organizationId?: string;
  } = {}
) {
  return router.createCaller({
    db,
    entitlements: {
      organizationId: options.organizationId ?? org,
      enabledModules: options.enabled === false ? [] : ['pharmacy-core'],
      modules: [],
    },
    session: {
      expires: '2099-01-01',
      user: {
        id: `${org}_${options.denied ? 'denied' : 'admin'}`,
        organizationId: org,
        role: options.role ?? 'ADMIN',
        status: options.status ?? 'ACTIVE',
        sessionRevoked: options.revoked,
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {}, db },
  } as unknown as TRPCContext).pharmacyMedicine;
}
beforeAll(async () => {
  if (!url) return;
  ({ withTenantDb: tenant, withPlatformDb: platform } = await import('@/lib/tenancy/scoped-db'));
  ({ pharmacyStagedReviewRouter: router } = await import('./pharmacy-staged-review'));
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(platform);
  for (const id of [org, foreign]) {
    await platform((db) =>
      db.organization.create({
        data: { id, slug: id, legalName: 'Synthetic', displayName: 'Synthetic' },
      })
    );
    await tenant(id, async (db) => {
      await db.organizationDepartment.create({ data: { key: 'synthetic', name: 'Synthetic' } });
      for (const suffix of ['admin', 'denied'])
        await db.user.create({
          data: {
            id: `${id}_${suffix}`,
            name: 'Synthetic actor',
            email: `${suffix}@${id}.invalid`,
            department: 'synthetic',
            title: 'Synthetic',
            role: 'ADMIN',
          },
        });
      await db.userPermissionOverride.create({
        data: {
          userId: `${id}_denied`,
          capability: 'admin:access',
          effect: 'DENY',
          reason: 'Synthetic denial fixture',
        },
      });
      for (const suffix of ['branch', 'second', 'inactive'])
        await db.pharmacyBranch.create({
          data: {
            id: `${id}_${suffix}`,
            code: suffix,
            name: suffix,
            addressLine: 'Synthetic',
            city: 'Synthetic',
            provinceCode: 'XX',
            active: suffix !== 'inactive',
          },
        });
      for (const suffix of ['', '_other']) {
        await db.pharmacyMigrationSource.create({
          data: {
            id: `${id}_source${suffix}`,
            kind: 'EXCEL_CSV',
            fileName: 'synthetic.csv',
            byteSize: BigInt(0),
            contentHash: suffix ? 'b'.repeat(64) : hash,
          },
        });
        await db.pharmacyMigrationBatch.create({
          data: {
            id: `${id}_batch${suffix}`,
            sourceId: `${id}_source${suffix}`,
            label: 'Synthetic',
            profilerVersion: 'synthetic',
            status: 'PROFILED',
            profiledAt: new Date('2026-10-06T00:00:00Z'),
          },
        });
      }
      for (let n = 1; n <= 28; n++) {
        const raw = {
          Name: `Synthetic ${n}`,
          aliasname: 'AliasExact',
          active: '0',
          saleprice: '0007.5000',
          purprice: '5.0000',
          PackUnits: '010',
          QTY: '9007199254740993.0000',
          name: 'lowercase grouping',
          classname: 'Class',
          Category: 'Category',
          UnitPrice: '0.750000',
          PackQty: '1.0000',
          StockValue: '0009.00',
          __source_sha256: hash,
          __source_row: String(n),
          __review_flags: n < 3 ? 'NORMALIZED_NAME_COLLISION_NO_MERGE' : '',
          hidden_arbitrary_key: 'must not render',
        };
        await db.pharmacyMigrationRow.create({
          data: {
            id: `${id}_row_${n}`,
            batchId: `${id}_batch`,
            sourceKey: `sha256:${hash}:row:${n}`,
            rowNumber: n,
            rawPayload: raw,
            targetModelKey: n === 28 ? 'party.customer' : 'med.product',
            targetNaturalKey: null,
            productName: n < 3 ? 'Collision' : `Synthetic ${n}`,
            quantityCanonical: null,
          },
        });
        if (n < 3 || n === 28)
          await db.pharmacyMigrationException.create({
            data: {
              batchId: `${id}_batch`,
              rowId: `${id}_row_${n}`,
              bucket: n < 3 ? 'DUPLICATE_PRODUCT' : 'PARTY_UNMATCHED',
              severity: 'BLOCKING',
              detail: 'Synthetic retained exception',
            },
          });
        if (n === 3)
          for (const bucket of ['MISSING_BATCH', 'MISSING_EXPIRY', 'MISSING_MRP'] as const)
            await db.pharmacyMigrationException.create({
              data: {
                batchId: `${id}_batch`,
                rowId: `${id}_row_${n}`,
                bucket,
                severity: 'BLOCKING',
                detail: 'Synthetic missing fact',
              },
            });
      }
      await db.pharmacyMigrationRow.create({
        data: {
          id: `${id}_other_row`,
          batchId: `${id}_batch_other`,
          sourceKey: 'other',
          rowNumber: 1,
          rawPayload: {},
          targetModelKey: 'med.product',
        },
      });
    });
  }
  before = await snapshot();
  expect((before as Record<string, unknown[]>)[`${org}:pharmacy_migration_rows`]).toHaveLength(29);
  expect((before as Record<string, unknown[]>)[`${foreign}:pharmacy_migration_rows`]).toHaveLength(
    29
  );
}, 60000);
afterAll(async () => {
  if (url) {
    const { db } = await import('@/lib/db');
    await db.$disconnect();
  }
});
suite('staged review on restricted PostgreSQL', () => {
  it('forces RLS on all staging tables and hides cross-tenant raw SELECTs without application predicates', async () => {
    await tenant(org, async (db) => {
      for (const table of tables.slice(0, 4)) {
        const flags = await db.$queryRawUnsafe<
          { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='${table}'::regclass`);
        expect(flags).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
        expect(
          await db.$queryRawUnsafe(`SELECT id FROM ${table} WHERE "organizationId"=$1`, foreign)
        ).toEqual([]);
      }
    });
  });
  it('RLS rejects cross-tenant INSERT', async () => {
    await expect(
      tenant(org, (db) =>
        db.pharmacyMigrationSource.create({
          data: {
            organizationId: foreign,
            kind: 'EXCEL_CSV',
            fileName: 'denied',
            byteSize: BigInt(0),
            contentHash: 'c'.repeat(64),
          },
        })
      )
    ).rejects.toThrow(/row.level security/i);
  });
  it('stable pagination and organization-wide branch context preserve all candidates', async () => {
    await tenant(org, async (db) => {
      const api = caller(db),
        first = await api.stagedRows(scope),
        second = await api.stagedRows({ ...scope, page: 2 });
      expect(first.total).toBe(27);
      expect(first.rows).toHaveLength(25);
      expect(second.rows.map((r) => r.rowNumber)).toEqual([26, 27]);
      expect(await api.stagedRows(scope)).toEqual(first);
      expect(await api.stagedRows({ ...scope, branchId: `${org}_second` })).toEqual(first);
      expect((await api.stagedBranches()).map((b) => b.id).sort()).toEqual([
        `${org}_branch`,
        `${org}_second`,
      ]);
      expect((await api.stagedBatches({ branchId: scope.branchId })).total).toBe(2);
    });
  });
  it('search/filter/detail retain exact source strings, case and collision evidence', async () => {
    await tenant(org, async (db) => {
      const api = caller(db);
      expect(
        (await api.stagedRows({ ...scope, query: 'synthetic 3' })).rows.map((r) => r.rowNumber)
      ).toEqual([3]);
      expect((await api.stagedRows({ ...scope, query: 'AliasExact' })).total).toBe(27);
      for (const filter of ['stock', 'price'] as const)
        expect((await api.stagedRows({ ...scope, filter })).rows.map((r) => r.rowNumber)).toEqual([
          3,
        ]);
      const collisions = await api.stagedRows({ ...scope, filter: 'collision' });
      expect(collisions.rows.map((r) => r.rowNumber)).toEqual([1, 2]);
      const row = await api.stagedDetail({ ...scope, rowId: `${org}_row_1` });
      expect(row.references).toEqual({
        Name: 'Synthetic 1',
        aliasname: 'AliasExact',
        active: '0',
        saleprice: '0007.5000',
        purprice: '5.0000',
        PackUnits: '010',
        QTY: '9007199254740993.0000',
        name: 'lowercase grouping',
        classname: 'Class',
        Category: 'Category',
        UnitPrice: '0.750000',
        PackQty: '1.0000',
        StockValue: '0009.00',
      });
      expect(row.lineage).toBe('Source lineage matches');
      expect(row.collision).toBe(true);
      expect(row.sellable).toBe(false);
      expect(row.verified).toBe(false);
      expect(row.canonicalQuantity).toBeNull();
      expect(row.exceptions).toContainEqual(
        expect.objectContaining({
          bucket: 'DUPLICATE_PRODUCT',
          severity: 'BLOCKING',
          status: 'OPEN',
        })
      );
    });
  });
  it('exception summary remains batch-wide including non-product targets under empty search/filter', async () => {
    await tenant(org, async (db) => {
      const result = await caller(db).stagedRows({
        ...scope,
        query: 'absent',
        filter: 'collision',
      });
      expect(result.total).toBe(0);
      expect(result.candidateCount).toBe(27);
      expect(result.exceptions.reduce((sum, e) => sum + e.count, 0)).toBe(6);
      expect(result.exceptions).toContainEqual(
        expect.objectContaining({ bucket: 'PARTY_UNMATCHED', count: 1 })
      );
    });
  });
  it.each([`${org}_inactive`, `${foreign}_branch`])(
    'denies inactive/foreign branch %s',
    async (branchId) => {
      await tenant(org, async (db) => {
        await expect(caller(db).stagedRows({ ...scope, branchId })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      });
    }
  );
  it('denies foreign or mismatched source/batch and row scope', async () => {
    await tenant(org, async (db) => {
      const api = caller(db);
      for (const changes of [
        { sourceId: `${org}_source_other` },
        { batchId: `${foreign}_batch`, sourceId: `${foreign}_source` },
      ])
        await expect(api.stagedRows({ ...scope, ...changes })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      for (const rowId of [`${foreign}_row_1`, `${org}_other_row`, `${org}_row_28`])
        await expect(api.stagedDetail({ ...scope, rowId })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
    });
  });
  it.each([
    { role: 'EMPLOYEE' },
    { enabled: false },
    { status: 'INACTIVE' },
    { revoked: true },
    { denied: true },
    { organizationId: foreign },
  ])('real caller middleware denies %j', async (options) => {
    await tenant(org, async (db) => {
      await expect(caller(db, options).stagedRows(scope)).rejects.toMatchObject({
        code: options.revoked ? 'UNAUTHORIZED' : 'FORBIDDEN',
      });
    });
  });
  it('all reads leave source/reference/candidate/exception snapshots unchanged while persisting audit', async () => {
    expect(await snapshot()).toEqual(before);
    await tenant(org, async (db) => {
      expect(
        await db.auditLog.count({
          where: { action: 'pharmacyMedicine.stagedRows', outcome: 'SUCCESS' },
        })
      ).toBeGreaterThan(0);
      expect(
        await db.auditLog.count({
          where: { action: 'pharmacyMedicine.stagedRows', outcome: 'FAILURE' },
        })
      ).toBeGreaterThan(0);
    });
  });
});
