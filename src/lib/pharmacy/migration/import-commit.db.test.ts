/**
 * Import 1/5 CTO hold — adversarial integration coverage against migrated PostgreSQL as a
 * NOSUPERUSER NOBYPASSRLS role, with persisted roles and user overrides:
 *   - exact and wildcard user DENY over role/owner ALLOW at every mutation entry point;
 *   - same-tenant cross-branch reads and writes under the forced branch policies;
 *   - duplicate concurrent commits and retries of the same source content, and two imports
 *     racing to create the same new supplier;
 *   - two concurrent rollback workers;
 *   - cross-batch and cross-branch reversal links and manifest tampering;
 *   - exact signed stock compensation, and an all-or-nothing refusal once stock or a created
 *     supplier was used.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type ImportRequest = import('./import-authority').ImportRequest;

const suffix = randomBytes(6).toString('hex');
const ids = {
  orgA: `org_imp1_a_${suffix}`,
  orgB: `org_imp1_b_${suffix}`,
  a1: `br_imp1_a1_${suffix}`,
  a2: `br_imp1_a2_${suffix}`,
  b1: `br_imp1_b1_${suffix}`,
  manager: `u_imp1_manager_${suffix}`,
  managerA2: `u_imp1_manager_a2_${suffix}`,
  managerB: `u_imp1_manager_b_${suffix}`,
  owner: `u_imp1_owner_${suffix}`,
  cashier: `u_imp1_cashier_${suffix}`,
  userDenyExact: `u_imp1_deny_exact_${suffix}`,
  userDenyWildcard: `u_imp1_deny_wild_${suffix}`,
  ownerDenied: `u_imp1_owner_denied_${suffix}`,
  roleDenyUserAllow: `u_imp1_role_deny_${suffix}`,
};
const FORBIDDEN = { reason: 'FORBIDDEN' };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let workbench: typeof import('./workbench');
let importCommit: typeof import('./import-commit');
let stagedReviewRouter: typeof import('@/server/routers/pharmacy-staged-review').pharmacyStagedReviewRouter;
let disconnect: (() => Promise<void>) | null = null;
const stock = {
  a1: { medicine: '', manufacturingBatch: '', pack: '', location: '' },
  a2Location: '',
};

function inOrg<T>(userId: string, run: (db: ScopedDb) => Promise<T>, organizationId = ids.orgA) {
  return withTenantDb(organizationId, run, { timeout: 60_000, userId });
}
function request(userId: string, branchId = ids.a1, organizationId = ids.orgA): ImportRequest {
  return { organizationId, branchId, actor: { userId, role: 'EMPLOYEE' } };
}
async function bind(db: ScopedDb, branchId: string) {
  await db.$queryRawUnsafe(`SELECT set_config('app.current_branch_id', $1, true)`, branchId);
}

/** A clean Excel/CSV export; the tag makes the bytes (and so the content hash) unique. */
function csv(tag: string, quantity = 120) {
  return Buffer.from(
    [
      'Sr,Item Name,Pack Size,Barcode,Batch No,Expiry,MRP,Trade Price,Qty,Supplier',
      `1,Amoxil 500mg ${tag},10x10,89640${tag.length}101018,B-${tag},2027-05-31,250.00,212.50,${quantity},Distributor ${tag}`,
    ].join('\n')
  );
}

/** Upload and preview as `userId`, signing off any blocking exception, as the workbench would. */
async function preview(userId: string, tag: string, branchId = ids.a1, organizationId = ids.orgA) {
  const persisted = await inOrg(
    userId,
    (db) =>
      workbench.importSourceFile(db, request(userId, branchId, organizationId), {
        kind: 'EXCEL_CSV',
        fileName: `stock-${tag}.csv`,
        bytes: new Uint8Array(csv(tag)),
        label: `Import ${tag}`,
      }),
    organizationId
  );
  const rows = await inOrg(
    userId,
    async (db) => {
      await bind(db, branchId);
      const blocking = await db.pharmacyMigrationException.findMany({
        where: { batchId: persisted.batchId, status: 'OPEN', severity: 'BLOCKING' },
        select: { id: true },
      });
      for (const exception of blocking)
        await workbench.signOffException(db, request(userId, branchId, organizationId), {
          exceptionId: exception.id,
          note: 'Checked against the paper stock sheet.',
        });
      return db.pharmacyMigrationRow.findMany({
        where: { batchId: persisted.batchId },
        orderBy: { rowNumber: 'asc' },
        select: { id: true, sourceKey: true },
      });
    },
    organizationId
  );
  return { batchId: persisted.batchId, sourceId: persisted.sourceId, rowId: rows[0]!.id, tag };
}

function instructions(
  batch: { rowId: string; tag: string },
  quantityUnits = 120,
  stockLocationId = stock.a1.location
) {
  return [
    { rowId: batch.rowId, kind: 'SUPPLIER' as const, name: `Distributor ${batch.tag}` },
    {
      rowId: batch.rowId,
      kind: 'OPENING_STOCK' as const,
      manufacturingBatchId: stock.a1.manufacturingBatch,
      packLevelId: stock.a1.pack,
      stockLocationId,
      unitsPerPack: 10,
      quantityUnits,
      unitCostMinor: 21_250,
      printedMrpMinor: 25_000,
    },
  ];
}
const commit = (userId: string, batch: { batchId: string; rowId: string; tag: string }) =>
  inOrg(userId, (db) =>
    importCommit.commitImportBatch(db, request(userId), {
      batchId: batch.batchId,
      instructions: instructions(batch),
    })
  );
const rollback = (userId: string, batchId: string) =>
  inOrg(userId, (db) =>
    importCommit.rollbackImportBatch(db, request(userId), {
      batchId,
      reason: 'Wrong opening sheet; re-importing tomorrow.',
    })
  );

type Entry = {
  id: string;
  operation: string;
  entityId: string;
  stockMovementId: string | null;
  quantityUnits: number | null;
  reversesEntryId: string | null;
  reversedById: string | null;
  releasedAt: Date | null;
  applicationKey: string;
};
const manifest = (batchId: string, branchId = ids.a1) =>
  inOrg(ids.manager, async (db) => {
    await bind(db, branchId);
    return db.$queryRawUnsafe<Entry[]>(
      `SELECT id, operation::text AS operation, "entityId", "stockMovementId", "quantityUnits",
              "reversesEntryId", "reversedById", "releasedAt", "applicationKey"
         FROM pharmacy_migration_batch_entities WHERE "batchId" = $1 ORDER BY "createdAt", id`,
      batchId
    );
  });
/** On-hand units of every lot an import posted into, through the ledger's own projection. */
const onHandFor = (movementIds: string[]) =>
  inOrg(ids.manager, async (db) => {
    const movements = await db.pharmacyStockMovement.findMany({
      where: { id: { in: movementIds } },
      select: { inventoryLotId: true },
    });
    const balances = await db.pharmacyStockBalance.findMany({
      where: { inventoryLotId: { in: movements.map((movement) => movement.inventoryLotId) } },
      select: { onHandUnits: true },
    });
    return balances.reduce((sum, balance) => sum + balance.onHandUnits, 0);
  });
const batchStatus = (batchId: string, branchId = ids.a1) =>
  inOrg(ids.manager, async (db) => {
    await bind(db, branchId);
    return db.pharmacyMigrationBatch.findFirst({
      where: { id: batchId },
      select: { status: true, committedAt: true, rolledBackAt: true },
    });
  });

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  workbench = await import('./workbench');
  importCommit = await import('./import-commit');
  stagedReviewRouter = (await import('@/server/routers/pharmacy-staged-review'))
    .pharmacyStagedReviewRouter;
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  disconnect = () => db.$disconnect();
  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  for (const org of [ids.orgA, ids.orgB])
    await withPlatformDb((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, 'Import hold', 'Import hold', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
        org
      )
    );
  const people: Array<{
    org: string;
    id: string;
    role: Array<[string, 'ALLOW' | 'DENY']>;
    override?: [string, 'ALLOW' | 'DENY'];
    branches: string[];
  }> = [
    {
      org: ids.orgA,
      id: ids.manager,
      role: [['pharmacy:data-import', 'ALLOW']],
      branches: [ids.a1],
    },
    {
      org: ids.orgA,
      id: ids.managerA2,
      role: [['pharmacy:data-import', 'ALLOW']],
      branches: [ids.a2],
    },
    {
      org: ids.orgB,
      id: ids.managerB,
      role: [['pharmacy:data-import', 'ALLOW']],
      branches: [ids.b1],
    },
    // The pharmacy Owner template's wildcard reaches data-import (not an exact-grant-only action).
    { org: ids.orgA, id: ids.owner, role: [['pharmacy:*', 'ALLOW']], branches: [ids.a1] },
    { org: ids.orgA, id: ids.cashier, role: [['pharmacy:counter', 'ALLOW']], branches: [ids.a1] },
    {
      org: ids.orgA,
      id: ids.userDenyExact,
      role: [['pharmacy:data-import', 'ALLOW']],
      override: ['pharmacy:data-import', 'DENY'],
      branches: [ids.a1],
    },
    {
      org: ids.orgA,
      id: ids.userDenyWildcard,
      role: [['pharmacy:data-import', 'ALLOW']],
      override: ['pharmacy:*', 'DENY'],
      branches: [ids.a1],
    },
    {
      org: ids.orgA,
      id: ids.ownerDenied,
      role: [['pharmacy:*', 'ALLOW']],
      override: ['pharmacy:data-import', 'DENY'],
      branches: [ids.a1],
    },
    {
      org: ids.orgA,
      id: ids.roleDenyUserAllow,
      role: [['pharmacy:data-import', 'DENY']],
      override: ['pharmacy:data-import', 'ALLOW'],
      branches: [ids.a1],
    },
  ];
  for (const org of [ids.orgA, ids.orgB])
    await withTenantDb(org, async (tx) => {
      await seedDepartments(tx, [org], ['LEADERSHIP']);
      for (const branchId of org === ids.orgA ? [ids.a1, ids.a2] : [ids.b1])
        await tx.pharmacyBranch.create({
          data: {
            id: branchId,
            code: branchId.split('_')[2]!.toUpperCase(),
            name: branchId,
            addressLine: '1 Road',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
      for (const person of people.filter((candidate) => candidate.org === org)) {
        await tx.organizationRole.create({
          data: {
            id: `role_${person.id}`,
            key: `role_${person.id}`,
            name: person.id,
            permissions: {
              create: person.role.map(([capability, effect]) => ({ capability, effect })),
            },
          },
        });
        await tx.user.create({
          data: {
            id: person.id,
            name: person.id,
            email: `${person.id}@example.test`,
            department: 'LEADERSHIP',
            title: 'Import',
            organizationRoleId: `role_${person.id}`,
          },
        });
        if (person.override)
          await tx.userPermissionOverride.create({
            data: {
              userId: person.id,
              capability: person.override[0],
              effect: person.override[1],
              reason: 'Set by the import hold test',
            },
          });
        for (const branchId of person.branches)
          await tx.pharmacyBranchAssignment.create({ data: { userId: person.id, branchId } });
      }
    });
  await withTenantDb(ids.orgA, async (tx) => {
    const medicine = await tx.medicine.create({
      data: {
        productName: `Amoxil 500mg ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { presentation: 'Capsule, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const pack = await tx.packLevel.create({
      data: {
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const manufacturingBatch = await tx.pharmacyManufacturingBatch.create({
      data: {
        medicineId: medicine.id,
        batchNumber: `B-${suffix}`,
        expiresAt: new Date('2028-10-01T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    });
    const location = await tx.pharmacyStockLocation.create({
      data: { branchId: ids.a1, code: `A1-${suffix}`, name: 'Main', kind: 'STORE' },
    });
    const locationA2 = await tx.pharmacyStockLocation.create({
      data: { branchId: ids.a2, code: `A2-${suffix}`, name: 'Main', kind: 'STORE' },
    });
    stock.a1 = {
      medicine: medicine.id,
      manufacturingBatch: manufacturingBatch.id,
      pack: pack.id,
      location: location.id,
    };
    stock.a2Location = locationA2.id;
  });
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('import commit and rollback under the CTO hold (import 1/5)', () => {
  it('refuses every mutation entry point to a user without data-import; an explicit user DENY wins', async () => {
    const batch = await preview(ids.manager, 'deny-target');
    for (const userId of [ids.userDenyExact, ids.userDenyWildcard, ids.ownerDenied, ids.cashier]) {
      await expect(
        inOrg(userId, (db) =>
          workbench.importSourceFile(db, request(userId), {
            kind: 'EXCEL_CSV',
            fileName: 'denied.csv',
            bytes: new Uint8Array(csv(`denied-${userId}`)),
            label: 'Denied',
          })
        )
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inOrg(userId, (db) =>
          importCommit.commitImportBatch(db, request(userId), {
            batchId: batch.batchId,
            instructions: instructions(batch),
          })
        )
      ).rejects.toMatchObject(FORBIDDEN);
      await expect(rollback(userId, batch.batchId)).rejects.toMatchObject(FORBIDDEN);
      await expect(
        inOrg(userId, (db) =>
          workbench.signOffException(db, request(userId), { exceptionId: 'any' })
        )
      ).rejects.toMatchObject(FORBIDDEN);
      // The tRPC boundary is capability-gated through central can() as well.
      await expect(
        inOrg(userId, (db) =>
          stagedReviewRouter
            .createCaller({
              db,
              entitlements: {
                organizationId: ids.orgA,
                enabledModules: ['pharmacy-core'],
                modules: [],
              },
              session: {
                expires: 'later',
                user: { id: userId, organizationId: ids.orgA, role: 'EMPLOYEE', status: 'ACTIVE' },
              },
              organization: { id: ids.orgA, vertical: 'PHARMACY' },
              support: null,
              requestMeta: { ip: null, userAgent: null },
              audit: { detail: {} },
            } as never)
            .importCore.rollback({
              branchId: ids.a1,
              batchId: batch.batchId,
              reason: 'Testing the capability gate.',
            })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await batchStatus(batch.batchId)).toMatchObject({ status: 'PREVIEW' });
    // A role grant and the owner wildcard are both enough on their own.
    await expect(preview(ids.owner, 'owner-allowed')).resolves.toMatchObject({
      batchId: expect.any(String),
    });
  });

  // Role DENY over a user ALLOW override is decided in src/lib/abac/index.ts, which lets a
  // matching user ALLOW return before role rules are read. The central fix is 6b120a50 on
  // fix/abac-deny-precedence (not on main); turn this back into `it` when it lands.
  it.fails('refuses a role DENY over a user ALLOW override', async () => {
    await expect(preview(ids.roleDenyUserAllow, 'role-deny')).rejects.toMatchObject(FORBIDDEN);
  });

  it('keeps branches and tenants apart under the forced branch policies', async () => {
    const inA1 = await preview(ids.manager, 'branch-a1');
    const inA2 = await preview(ids.managerA2, 'branch-a2', ids.a2);
    const inB1 = await preview(ids.managerB, 'tenant-b', ids.b1, ids.orgB);

    // Reads: bound to A1, nothing of A2 (same tenant) or of tenant B is visible.
    const seenFromA1 = await inOrg(ids.manager, async (db) => {
      await bind(db, ids.a1);
      return {
        batches: (await db.pharmacyMigrationBatch.findMany({ select: { id: true } })).map(
          (b) => b.id
        ),
        foreignRows: await db.pharmacyMigrationRow.count({ where: { batchId: inA2.batchId } }),
        foreignExceptions: await db.pharmacyMigrationException.count({
          where: { batchId: inA2.batchId },
        }),
        foreignSources: await db.pharmacyMigrationSource.count({ where: { id: inA2.sourceId } }),
        tenantB: await db.pharmacyMigrationBatch.count({ where: { id: inB1.batchId } }),
      };
    });
    expect(seenFromA1.batches).toContain(inA1.batchId);
    expect(seenFromA1.batches).not.toContain(inA2.batchId);
    expect(seenFromA1).toMatchObject({
      foreignRows: 0,
      foreignExceptions: 0,
      foreignSources: 0,
      tenantB: 0,
    });
    // With no branch bound at all, the tables show nothing.
    expect(
      await inOrg(ids.manager, (db) =>
        db.pharmacyMigrationBatch.count({ where: { id: inA1.batchId } })
      )
    ).toBe(0);

    // Writes: bound to A1, A2's batch cannot be updated and A2 rows cannot be inserted.
    const updated = await inOrg(ids.manager, async (db) => {
      await bind(db, ids.a1);
      return db.pharmacyMigrationBatch.updateMany({
        where: { id: inA2.batchId },
        data: { label: 'tampered' },
      });
    });
    expect(updated.count).toBe(0);
    await expect(
      inOrg(ids.manager, async (db) => {
        await bind(db, ids.a1);
        await db.pharmacyMigrationSource.create({
          data: {
            branchId: ids.a2,
            kind: 'EXCEL_CSV',
            fileName: 'smuggled.csv',
            byteSize: BigInt(1),
            contentHash: 'f'.repeat(64),
            createdByUserId: ids.manager,
          },
        });
      })
    ).rejects.toThrow(/row-level security/);

    // The services: a branch the actor is not assigned to, or a batch of another branch.
    await expect(
      inOrg(ids.manager, (db) =>
        importCommit.commitImportBatch(db, request(ids.manager, ids.a2), {
          batchId: inA2.batchId,
          instructions: instructions(inA2),
        })
      )
    ).rejects.toMatchObject({ reason: 'BRANCH_OUT_OF_SCOPE' });
    await expect(
      inOrg(ids.manager, (db) =>
        importCommit.commitImportBatch(db, request(ids.manager), {
          batchId: inA2.batchId,
          instructions: instructions(inA2),
        })
      )
    ).rejects.toMatchObject({ reason: 'BATCH_NOT_FOUND' });
    await expect(
      inOrg(
        ids.managerB,
        (db) =>
          importCommit.rollbackImportBatch(db, request(ids.managerB, ids.a1, ids.orgB), {
            batchId: inA1.batchId,
            reason: 'Cross-tenant attempt here.',
          }),
        ids.orgB
      )
    ).rejects.toMatchObject({ reason: 'BRANCH_OUT_OF_SCOPE' });
    expect(await batchStatus(inA2.batchId, ids.a2)).toMatchObject({ status: 'PREVIEW' });
  });

  it('commits suppliers and opening stock once, with persisted application keys', async () => {
    const batch = await preview(ids.manager, 'commit-once');
    const result = await commit(ids.manager, batch);
    expect(result).toMatchObject({ created: 1, posted: 1, matched: 0, alreadyApplied: 0 });
    const entries = await manifest(batch.batchId);
    expect(entries.map((entry) => entry.operation).sort()).toEqual(['CREATED', 'STOCK_MOVEMENT']);
    expect(entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.applicationKey))).toBe(true);
    const movement = entries.find((entry) => entry.operation === 'STOCK_MOVEMENT')!;
    expect(movement).toMatchObject({ quantityUnits: 120, stockMovementId: movement.entityId });
    expect(await onHandFor([movement.stockMovementId!])).toBe(120);
    expect(await batchStatus(batch.batchId)).toMatchObject({
      status: 'COMMITTED',
      committedAt: expect.any(Date),
      rolledBackAt: null,
    });
    // A retry of the committed batch is refused, and nothing is posted twice.
    await expect(commit(ids.manager, batch)).rejects.toMatchObject({ reason: 'BATCH_NOT_PREVIEW' });
    expect(await onHandFor([movement.stockMovementId!])).toBe(120);
  });

  it('serializes duplicate concurrent commits of one batch and of re-profiled identical content', async () => {
    const batch = await preview(ids.manager, 'concurrent');
    const settled = await Promise.allSettled([
      commit(ids.manager, batch),
      commit(ids.manager, batch),
    ]);
    expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(settled.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ reason: 'BATCH_NOT_PREVIEW' }),
    });
    const posted = (await manifest(batch.batchId)).filter(
      (entry) => entry.operation === 'STOCK_MOVEMENT'
    );
    expect(posted).toHaveLength(1);
    expect(await onHandFor(posted.map((entry) => entry.stockMovementId!))).toBe(120);

    // The same bytes uploaded twice: one source, two preview batches, the same application keys.
    const first = await preview(ids.manager, 'same-content');
    const second = await preview(ids.manager, 'same-content');
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.batchId).not.toBe(first.batchId);
    const both = await Promise.all([commit(ids.manager, first), commit(ids.manager, second)]);
    expect(both.map((outcome) => outcome.posted).sort()).toEqual([0, 1]);
    expect(both.map((outcome) => outcome.alreadyApplied + outcome.matched).sort()).toEqual([0, 2]);
    const movements = [
      ...(await manifest(first.batchId)),
      ...(await manifest(second.batchId)),
    ].filter((entry) => entry.operation === 'STOCK_MOVEMENT');
    expect(movements).toHaveLength(1);
    expect(await onHandFor(movements.map((entry) => entry.stockMovementId!))).toBe(120);
  });

  it('lets two imports that name the same new supplier both commit: one creates, one matches', async () => {
    const x = await preview(ids.manager, 'supplier-race-x');
    const y = await preview(ids.manager, 'supplier-race-y');
    const name = `Shared distributor ${suffix}`;
    const outcomes = await Promise.all(
      [x, y].map((batch) =>
        inOrg(ids.manager, (db) =>
          importCommit.commitImportBatch(db, request(ids.manager), {
            batchId: batch.batchId,
            instructions: [{ rowId: batch.rowId, kind: 'SUPPLIER', name }],
          })
        )
      )
    );
    expect(outcomes.map((outcome) => [outcome.created, outcome.matched]).sort()).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(await inOrg(ids.manager, (db) => db.pharmacySupplier.count({ where: { name } }))).toBe(
      1
    );
  });

  it('lets exactly one of two rollback workers compensate, with the exact opposite posting', async () => {
    const batch = await preview(ids.manager, 'two-workers');
    await commit(ids.manager, batch);
    const [original] = (await manifest(batch.batchId)).filter(
      (entry) => entry.operation === 'STOCK_MOVEMENT'
    );
    const settled = await Promise.allSettled([
      rollback(ids.manager, batch.batchId),
      rollback(ids.manager, batch.batchId),
    ]);
    expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(settled.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ reason: 'BATCH_ROLLED_BACK' }),
    });
    const entries = await manifest(batch.batchId);
    const reversal = entries.find((entry) => entry.operation === 'STOCK_REVERSAL')!;
    expect(entries.filter((entry) => entry.operation === 'STOCK_REVERSAL')).toHaveLength(1);
    expect(reversal).toMatchObject({ quantityUnits: -120, reversesEntryId: original!.id });
    expect(entries.find((entry) => entry.id === original!.id)).toMatchObject({
      reversedById: reversal.id,
      releasedAt: expect.any(Date),
    });
    const ledger = await inOrg(ids.manager, (db) =>
      db.pharmacyStockMovement.findFirstOrThrow({
        where: { id: reversal.stockMovementId! },
        select: { kind: true, quantityUnits: true, reversesMovementId: true },
      })
    );
    expect(ledger).toEqual({
      kind: 'ADJUSTMENT',
      quantityUnits: -120,
      reversesMovementId: original!.stockMovementId,
    });
    expect(await onHandFor([original!.stockMovementId!])).toBe(0);
    const supplier = entries.find((entry) => entry.operation === 'CREATED')!;
    expect(supplier.releasedAt).toEqual(expect.any(Date));
    expect(
      await inOrg(ids.manager, (db) =>
        db.pharmacySupplier.count({ where: { id: supplier.entityId } })
      )
    ).toBe(0);
    expect(await batchStatus(batch.batchId)).toMatchObject({
      status: 'ROLLED_BACK',
      committedAt: expect.any(Date),
      rolledBackAt: expect.any(Date),
    });
    // Released keys free the same content for a fresh import.
    const again = await preview(ids.manager, 'two-workers');
    await expect(commit(ids.manager, again)).resolves.toMatchObject({ created: 1, posted: 1 });
  });

  it('refuses the whole rollback once imported stock or a created supplier has been used', async () => {
    const usedStock = await preview(ids.manager, 'used-stock');
    await commit(ids.manager, usedStock);
    const [posting] = (await manifest(usedStock.batchId)).filter(
      (entry) => entry.operation === 'STOCK_MOVEMENT'
    );
    // One damaged sealed pack written off: the shelf no longer holds what the import posted.
    await inOrg(ids.manager, async (db) => {
      const original = await db.pharmacyStockMovement.findFirstOrThrow({
        where: { id: posting!.stockMovementId! },
      });
      await db.pharmacyStockMovement.create({
        data: {
          branchId: ids.a1,
          inventoryLotId: original.inventoryLotId,
          stockLocationId: original.stockLocationId,
          kind: 'WRITE_OFF',
          disposition: 'AVAILABLE',
          quantityUnits: -10,
          sealedPackDelta: -1,
          looseUnitDelta: 0,
          actorId: ids.manager,
          reason: 'Damaged pack',
          idempotencyKey: `write-off-${suffix}`,
        },
      });
    });
    await expect(rollback(ids.manager, usedStock.batchId)).rejects.toMatchObject({
      reason: 'ROLLBACK_BLOCKED',
      details: [expect.stringContaining('has been used since the import')],
    });

    const usedSupplier = await preview(ids.manager, 'used-supplier');
    await commit(ids.manager, usedSupplier);
    const created = (await manifest(usedSupplier.batchId)).find(
      (entry) => entry.operation === 'CREATED'
    )!;
    await inOrg(ids.manager, (db) =>
      db.pharmacySupplierLicence.create({
        data: {
          supplierId: created.entityId,
          licenceType: 'DRUG_SALE',
          licenceNumber: `L-${suffix}`,
          issuingAuthority: 'Punjab Health',
          issuedAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        },
      })
    );
    await expect(rollback(ids.manager, usedSupplier.batchId)).rejects.toMatchObject({
      reason: 'ROLLBACK_BLOCKED',
      details: [expect.stringContaining('Supplier "Distributor used-supplier" has been used')],
    });
    // Nothing moved: both batches are still committed, nothing was reversed or deleted.
    for (const batchId of [usedStock.batchId, usedSupplier.batchId]) {
      expect(await batchStatus(batchId)).toMatchObject({ status: 'COMMITTED' });
      expect((await manifest(batchId)).every((entry) => entry.releasedAt === null)).toBe(true);
    }
  });

  it('binds reversal provenance to the same batch and branch, and keeps the manifest immutable', async () => {
    const left = await preview(ids.manager, 'provenance-left');
    const right = await preview(ids.manager, 'provenance-right');
    await commit(ids.manager, left);
    await commit(ids.manager, right);
    await rollback(ids.manager, right.batchId);
    const leftEntry = (await manifest(left.batchId)).find(
      (entry) => entry.operation === 'STOCK_MOVEMENT'
    )!;
    const rightReversal = (await manifest(right.batchId)).find(
      (entry) => entry.operation === 'STOCK_REVERSAL'
    )!;
    const rightOriginal = (await manifest(right.batchId)).find(
      (entry) => entry.operation === 'STOCK_MOVEMENT'
    )!;

    const attempt = (sql: string, ...values: unknown[]) =>
      inOrg(ids.manager, async (db) => {
        await bind(db, ids.a1);
        await db.$executeRawUnsafe(sql, ...values);
      });
    // An entry of another batch (same tenant, same branch) cannot be linked as the reversal:
    // the foreign key itself is (organization, branch, batch, id).
    await expect(
      attempt(
        `UPDATE pharmacy_migration_batch_entities SET "reversedById" = $1, "releasedAt" = now() WHERE id = $2`,
        rightOriginal.id,
        leftEntry.id
      )
    ).rejects.toThrow(/reversed_by_fkey/);
    // And a reversal that is already linked can never be linked a second time.
    await expect(
      attempt(
        `UPDATE pharmacy_migration_batch_entities SET "reversedById" = $1, "releasedAt" = now() WHERE id = $2`,
        rightReversal.id,
        leftEntry.id
      )
    ).rejects.toThrow(/reversed_by_key|reversed_by_fkey/);
    // A reversal row naming an original in another batch is refused the same way.
    await expect(
      attempt(
        `INSERT INTO pharmacy_migration_batch_entities
           (id, "branchId", "batchId", "rowSourceKey", "applicationKey", "entityType", "entityId",
            operation, "stockMovementId", "quantityUnits", "reversesEntryId")
         VALUES ($1, $2, $3, '1', $4, 'PharmacyStockMovement', $5, 'STOCK_REVERSAL', $5, -120, $6)`,
        `forged-${suffix}`,
        ids.a1,
        right.batchId,
        'e'.repeat(64),
        `unheld-movement-${suffix}`,
        leftEntry.id
      )
    ).rejects.toThrow(/reverses_fkey/);
    // Another branch of the same tenant: its manifest cannot be linked from A1 in either
    // direction. The keys hold for every role, RLS or not: they name the branch and the batch.
    const otherBranch = await preview(ids.managerA2, 'provenance-a2', ids.a2);
    await inOrg(ids.managerA2, (db) =>
      importCommit.commitImportBatch(db, request(ids.managerA2, ids.a2), {
        batchId: otherBranch.batchId,
        instructions: instructions(otherBranch, 120, stock.a2Location),
      })
    );
    const a2Entry = (await manifest(otherBranch.batchId, ids.a2)).find(
      (entry) => entry.operation === 'STOCK_MOVEMENT'
    )!;
    await expect(
      attempt(
        `UPDATE pharmacy_migration_batch_entities SET "reversedById" = $1, "releasedAt" = now() WHERE id = $2`,
        a2Entry.id,
        leftEntry.id
      )
    ).rejects.toThrow(/reversed_by_fkey/);
    await expect(
      attempt(
        `INSERT INTO pharmacy_migration_batch_entities
           (id, "branchId", "batchId", "rowSourceKey", "applicationKey", "entityType", "entityId",
            operation, "stockMovementId", "quantityUnits", "reversesEntryId")
         VALUES ($1, $2, $3, '1', $4, 'PharmacyStockMovement', $5, 'STOCK_REVERSAL', $5, -120, $6)`,
        `forged-a2-${suffix}`,
        ids.a1,
        left.batchId,
        'b'.repeat(64),
        `unheld-movement-a2-${suffix}`,
        a2Entry.id
      )
    ).rejects.toThrow(/reverses_fkey/);
    expect(
      (await manifest(otherBranch.batchId, ids.a2)).find((entry) => entry.id === a2Entry.id)
    ).toMatchObject({ reversedById: null, releasedAt: null, quantityUnits: 120 });
    // Identity is immutable, including the branch, the application key and the quantity.
    for (const column of [
      `"branchId" = '${ids.a2}'`,
      `"applicationKey" = '${'d'.repeat(64)}'`,
      '"quantityUnits" = 1',
    ]) {
      await expect(
        attempt(
          `UPDATE pharmacy_migration_batch_entities SET ${column} WHERE id = $1`,
          leftEntry.id
        )
      ).rejects.toThrow(/identity is immutable|row-level security/);
    }
    // No DELETE policy exists, so a delete is filtered to zero rows; the trigger is the second guard.
    expect(
      await inOrg(ids.manager, async (db) => {
        await bind(db, ids.a1);
        return db.$executeRawUnsafe(
          `DELETE FROM pharmacy_migration_batch_entities WHERE id = $1`,
          leftEntry.id
        );
      })
    ).toBe(0);
    // A manifest row must match its ledger posting exactly. The check runs when the transaction
    // commits, so the forged row, the lot and the OPENING posting it names all roll back together.
    await expect(
      inOrg(ids.manager, async (db) => {
        await bind(db, ids.a1);
        const lot = await db.pharmacyInventoryLot.create({
          data: {
            branchId: ids.a1,
            manufacturingBatchId: stock.a1.manufacturingBatch,
            packLevelId: stock.a1.pack,
            unitsPerPack: 10,
            supplierName: 'OPENING',
            supplierInvoiceRef: `forged-${suffix}`,
            unitCostMinor: 100,
            printedMrpMinor: 200,
            receivedExpiresAt: new Date('2028-10-01T00:00:00.000Z'),
            receivedExpiryPrecision: 'DAY',
            receivedAt: new Date(),
          },
        });
        const opening = await db.pharmacyStockMovement.create({
          data: {
            branchId: ids.a1,
            inventoryLotId: lot.id,
            stockLocationId: stock.a1.location,
            kind: 'OPENING',
            disposition: 'AVAILABLE',
            quantityUnits: 30,
            sealedPackDelta: 3,
            looseUnitDelta: 0,
            actorId: ids.manager,
            reason: 'Opening stock outside the import',
            idempotencyKey: `forged-opening-${suffix}`,
          },
        });
        await db.$executeRawUnsafe(
          `INSERT INTO pharmacy_migration_batch_entities
             (id, "branchId", "batchId", "rowSourceKey", "applicationKey", "entityType", "entityId",
              operation, "stockMovementId", "quantityUnits")
           VALUES ($1, $2, $3, '9', $4, 'PharmacyStockMovement', $5, 'STOCK_MOVEMENT', $5, 31)`,
          `forged-qty-${suffix}`,
          ids.a1,
          left.batchId,
          'c'.repeat(64),
          opening.id
        );
      })
    ).rejects.toThrow(/does not match its ledger posting/);
    expect(
      await inOrg(ids.manager, (db) =>
        db.pharmacyStockMovement.count({ where: { idempotencyKey: `forged-opening-${suffix}` } })
      )
    ).toBe(0);
    // The left batch is untouched by every attempt.
    expect((await manifest(left.batchId)).find((entry) => entry.id === leftEntry.id)).toMatchObject(
      {
        reversedById: null,
        releasedAt: null,
        quantityUnits: 120,
      }
    );
  });
});
