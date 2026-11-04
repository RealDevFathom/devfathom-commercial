/** SEC-374-01: authenticated router -> canonical ABAC -> real ledger/custody.
 * Run ONLY on a disposable migrated Postgres, with distinct restricted runtime
 * and setup-owner URLs. Missing URLs skip explicitly; no production fallback.
 * Synthetic fixtures are retained (no reset, delete or cleanup SQL). */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));

const runtimeUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_ADMIN_URL;
const describeDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const id = (name: string) => `sec374_${name}_${suffix}`;
const org = id('org');
const otherOrg = id('other_org');
const branchA = id('branch_a');
const branchB = id('branch_b');
const foreignBranch = id('foreign_branch');
const witness = id('witness');
const foreignWitness = id('foreign_witness');
const inactiveWitness = id('inactive_witness');
const unassignedWitness = id('unassigned_witness');
const actors = {
  allowed: id('allowed'),
  none: id('none'),
  denied: id('denied'),
  unassigned: id('unassigned'),
  inactive: id('inactive'),
};
let inTenant: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let router: (typeof import('./pharmacy-inventory'))['pharmacyInventoryRouter'];
let owner: ScopedDb;
let disconnect: (() => Promise<void>) | undefined;
let sequence = 0;

async function admin<T>(organizationId: string, run: (tx: ScopedDb) => Promise<T>) {
  return owner.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true), set_config('app.is_platform_admin', 'true', true)`;
    return run(tx as unknown as ScopedDb);
  });
}

async function call(
  actorId: string,
  input: Parameters<ReturnType<typeof router.createCaller>['writeOff']>[0],
  decorateDb: (db: ScopedDb) => ScopedDb = (db) => db
) {
  return inTenant(
    org,
    (db) =>
      router
        .createCaller({
          db: decorateDb(db),
          headers: new Headers(),
          entitlements: { organizationId: org, enabledModules: ['pharmacy-inventory'] },
          session: {
            expires: 'later',
            user: { id: actorId, role: 'EMPLOYEE', status: 'ACTIVE', organizationId: org },
          },
          // An authorized selected-branch decoy must never authorize payload branchB.
          branchId: branchA,
          selectedBranchId: branchA,
          organization: { id: org, vertical: 'PHARMACY' },
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as unknown as TRPCContext)
        .writeOff(input),
    { userId: actorId, timeout: 30_000 }
  );
}

async function fixture(branchId = branchA, organizationId = org) {
  sequence += 1;
  const tag = `${suffix}_${sequence}`;
  return admin(organizationId, async (db) => {
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `SEC374 medicine ${tag}`,
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId, presentation: `tablet ${tag}` } },
      },
      include: { presentations: true },
    });
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `pack_${tag}`,
        version: 1,
        level: 'UNIT',
        unitsPerParent: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `batch_${tag}`,
        expiresAt: new Date('2027-12-01T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId,
        code: `shelf_${tag}`,
        name: 'SEC374 shelf',
        kind: 'RACK_BIN',
      },
    });
    const lot = await db.pharmacyInventoryLot.create({
      data: {
        organizationId,
        branchId,
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        unitsPerPack: 1,
        supplierName: 'Synthetic supplier',
        supplierInvoiceRef: `invoice_${tag}`,
        unitCostMinor: 100,
        printedMrpMinor: 150,
        receivedExpiresAt: new Date('2027-12-01T00:00:00.000Z'),
        receivedExpiryPrecision: 'DAY',
        receivedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    });
    // Exercise the source migration's real projection trigger, not direct balance seeding.
    await db.pharmacyStockMovement.create({
      data: {
        organizationId,
        branchId,
        inventoryLotId: lot.id,
        stockLocationId: location.id,
        kind: 'RECEIPT',
        disposition: 'AVAILABLE',
        quantityUnits: 10,
        sealedPackDelta: 0,
        looseUnitDelta: 10,
        actorId: actors.allowed,
        reason: 'Synthetic opening receipt',
        idempotencyKey: `receipt_${tag}`,
      },
    });
    return {
      branchId,
      inventoryLotId: lot.id,
      stockLocationId: location.id,
      units: 2,
      witnessId: witness,
      reason: 'Broken seal',
      evidenceRef: `photo_${tag}`,
      idempotencyKey: `writeoff_${tag}`,
    };
  });
}

async function snapshot(organizationId: string, inventoryLotId: string) {
  return admin(organizationId, async (db) => ({
    // Read as the setup owner so RLS cannot hide an unauthorized write from the assertion.
    balances: await db.pharmacyStockBalance.findMany({
      where: { inventoryLotId },
      orderBy: { stockLocationId: 'asc' },
    }),
    movements: await db.pharmacyStockMovement.findMany({
      where: { inventoryLotId },
      orderBy: { id: 'asc' },
    }),
    custody: await db.pharmacyCustodyRecord.findMany({
      where: { organizationId },
      orderBy: { id: 'asc' },
    }),
  }));
}

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  expect(runtimeUrl).not.toEqual(ownerUrl);
  process.env.DATABASE_URL = runtimeUrl;
  const [{ PrismaClient }, { PrismaPg }, scoped, transport, guard] = await Promise.all([
    import('@/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('@/lib/tenancy/scoped-db'),
    import('./pharmacy-inventory'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) });
  inTenant = scoped.withTenantDb;
  router = transport.pharmacyInventoryRouter;
  disconnect = async () => {
    await owner.$disconnect();
    await (await import('@/lib/db')).db.$disconnect();
  };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  await admin(org, async (db) => {
    const policies = await db.$queryRaw<Array<{ name: string; forced: boolean }>>`
      SELECT c.relname AS name, c.relforcerowsecurity AS forced
      FROM pg_class c WHERE c.relname IN ('pharmacy_stock_balances','pharmacy_stock_movements','pharmacy_custody_records','pharmacy_branch_assignments')`;
    expect(policies).toHaveLength(4);
    expect(policies.every((row) => row.forced)).toBe(true);
    for (const organizationId of [org, otherOrg]) {
      await db.organization.create({
        data: {
          id: organizationId,
          legalName: organizationId,
          displayName: organizationId,
          slug: organizationId,
          vertical: 'PHARMACY',
        },
      });
      // User.department is a tenant-owned composite FK, not a free-standing
      // enum. Seed its parent for BOTH tenants before any actor or witness.
      // The migration backfills existing tenants only; these are fresh ones.
      const department = await db.organizationDepartment.create({
        data: {
          organizationId,
          key: 'LEADERSHIP',
          name: 'Synthetic leadership',
          active: true,
        },
        select: { organizationId: true, key: true, active: true },
      });
      expect(department).toEqual({ organizationId, key: 'LEADERSHIP', active: true });
    }
    for (const [branchId, organizationId] of [
      [branchA, org],
      [branchB, org],
      [foreignBranch, otherOrg],
    ]) {
      await db.pharmacyBranch.create({
        data: {
          id: branchId,
          organizationId,
          code: branchId,
          name: branchId,
          addressLine: 'Synthetic test address',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
    }
    for (const [name, actorId] of Object.entries(actors)) {
      const roleId = id(`role_${name}`);
      await db.organizationRole.create({
        data: {
          id: roleId,
          organizationId: org,
          key: `role_${name}`,
          name: 'Inventory Manager',
          permissions:
            name === 'none'
              ? undefined
              : {
                  create: {
                    organizationId: org,
                    capability: 'pharmacy:inventory',
                    effect: 'ALLOW',
                  },
                },
        },
      });
      await db.user.create({
        data: {
          id: actorId,
          organizationId: org,
          organizationRoleId: roleId,
          email: `${actorId}@example.test`,
          name: actorId,
          department: 'LEADERSHIP',
          title: 'Synthetic inventory staff',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
        },
      });
      if (name !== 'unassigned') {
        await db.pharmacyBranchAssignment.create({
          data: {
            organizationId: org,
            branchId: branchA,
            userId: actorId,
            active: name !== 'inactive',
          },
        });
      }
    }
    await db.userPermissionOverride.create({
      data: {
        organizationId: org,
        userId: actors.denied,
        capability: 'pharmacy:*',
        effect: 'DENY',
        reason: 'SEC374 regression',
      },
    });
    for (const [userId, organizationId, status] of [
      [witness, org, 'ACTIVE'],
      [inactiveWitness, org, 'INACTIVE'],
      [unassignedWitness, org, 'ACTIVE'],
      [foreignWitness, otherOrg, 'ACTIVE'],
    ] as const) {
      await db.user.create({
        data: {
          id: userId,
          organizationId,
          email: `${userId}@example.test`,
          name: userId,
          department: 'LEADERSHIP',
          title: 'Synthetic witness',
          role: 'EMPLOYEE',
          status,
        },
      });
    }
    // Witnesses must hold an active assignment in the write-off branch. The
    // unassigned witness deliberately has none; the inactive witness is
    // assigned so its refusal proves the status check on its own.
    for (const userId of [witness, inactiveWitness]) {
      await db.pharmacyBranchAssignment.create({
        data: { organizationId: org, branchId: branchA, userId, active: true },
      });
    }
  });
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeDatabase('SEC-374-01 Postgres no-effect authorization regressions', () => {
  it.each(['none', 'denied', 'unassigned', 'inactive'] as const)(
    'refuses %s staff with a valid witness and preserves full stock/movement/custody state',
    async (actor) => {
      const input = await fixture();
      const before = await snapshot(org, input.inventoryLotId);
      await expect(call(actors[actor], input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await snapshot(org, input.inventoryLotId)).toEqual(before);
    }
  );

  it('refuses a same-tenant sibling branch even with inventory grant, valid witness and authorized selected-branch decoy', async () => {
    const input = await fixture(branchB);
    const before = await snapshot(org, input.inventoryLotId);
    await expect(call(actors.allowed, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await snapshot(org, input.inventoryLotId)).toEqual(before);
  });

  it('refuses another tenant branch without changing its state', async () => {
    const input = await fixture(foreignBranch, otherOrg);
    const before = await snapshot(otherOrg, input.inventoryLotId);
    // The unchanged organization-reference guard rejects before assignment and
    // stock access. Keep the full setup-owner snapshot to prove no hidden write.
    await expect(call(actors.allowed, input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(await snapshot(otherOrg, input.inventoryLotId)).toEqual(before);
  });

  it.each(['missing', 'self', 'inactive', 'unassigned', 'foreign'] as const)(
    'still refuses %s witness without effects after actor authorization',
    async (kind) => {
      const input = await fixture();
      const witnessId = {
        missing: id('missing_witness'),
        self: actors.allowed,
        inactive: inactiveWitness,
        unassigned: unassignedWitness,
        foreign: foreignWitness,
      }[kind];
      const before = await snapshot(org, input.inventoryLotId);
      await expect(call(actors.allowed, { ...input, witnessId })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'COAUTH_REQUIRED',
      });
      expect(await snapshot(org, input.inventoryLotId)).toEqual(before);
    }
  );

  it('authorized actual-branch control removes exactly two units with one movement and matching custody evidence', async () => {
    const input = await fixture();
    const before = await snapshot(org, input.inventoryLotId);
    expect(before.balances).toHaveLength(1);
    expect(before.balances[0]!.onHandUnits).toBe(10);
    const result = await call(actors.allowed, input);
    const after = await snapshot(org, input.inventoryLotId);
    expect(after.balances[0]!.onHandUnits).toBe(8);
    expect(after.movements).toHaveLength(before.movements.length + 1);
    expect(after.custody).toHaveLength(before.custody.length + 1);
    expect(result.movement).toMatchObject({
      organizationId: org,
      branchId: branchA,
      actorId: actors.allowed,
      quantityUnits: -2,
      sealedPackDelta: 0,
      looseUnitDelta: -2,
      kind: 'WRITE_OFF',
    });
    expect(result.custody).toMatchObject({
      organizationId: org,
      branchId: branchA,
      actorId: actors.allowed,
      witnessId: witness,
      movementId: result.movement.id,
      reason: input.reason,
      evidenceRef: input.evidenceRef,
    });
    expect(result.movement.sealedPackDelta + result.movement.looseUnitDelta).toBe(
      result.movement.quantityUnits
    );
    expect(
      after.balances.reduce((total, balance) => total + balance.onHandUnits, 0) -
        before.balances.reduce((total, balance) => total + balance.onHandUnits, 0)
    ).toBe(result.movement.quantityUnits);
    // The authorized write-off also posts its valuation in the same transaction.
    const entries = await admin(org, (db) =>
      db.financeJournalEntry.findMany({
        where: { sourceKind: 'PHARMACY_STOCK_WRITE_OFF', sourceId: result.movement.id },
      })
    );
    expect(entries).toHaveLength(1);
  });

  it.each(['assignment', 'witness'] as const)(
    'refuses the write when a concurrent %s revocation obtains the row lock first',
    async (target) => {
      const input = await fixture();
      const before = await snapshot(org, input.inventoryLotId);
      let release!: () => void;
      let locked!: () => void;
      const releaseGate = new Promise<void>((resolve) => (release = resolve));
      const lockedGate = new Promise<void>((resolve) => (locked = resolve));

      const revocation = admin(org, async (db) => {
        if (target === 'assignment') {
          await db.pharmacyBranchAssignment.update({
            where: {
              organizationId_branchId_userId: {
                organizationId: org,
                branchId: branchA,
                userId: actors.allowed,
              },
            },
            data: { active: false },
          });
        } else {
          await db.user.update({ where: { id: witness }, data: { status: 'INACTIVE' } });
        }
        locked();
        await releaseGate;
      });
      await lockedGate;
      const attemptedWrite = call(actors.allowed, input);
      // Let the write reach the authorization SELECT while the revocation owns
      // the row lock, then publish the revoked state.
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();
      await revocation;

      await expect(attemptedWrite).rejects.toMatchObject({
        code: target === 'assignment' ? 'FORBIDDEN' : 'BAD_REQUEST',
      });
      expect(await snapshot(org, input.inventoryLotId)).toEqual(before);
      await admin(org, async (db) => {
        if (target === 'assignment') {
          await db.pharmacyBranchAssignment.update({
            where: {
              organizationId_branchId_userId: {
                organizationId: org,
                branchId: branchA,
                userId: actors.allowed,
              },
            },
            data: { active: true },
          });
        } else {
          await db.user.update({ where: { id: witness }, data: { status: 'ACTIVE' } });
        }
      });
    }
  );

  it('refuses the write when a concurrent capability revocation commits first', async () => {
    const input = await fixture();
    const before = await snapshot(org, input.inventoryLotId);
    let release!: () => void;
    let locked!: () => void;
    const releaseGate = new Promise<void>((resolve) => (release = resolve));
    const lockedGate = new Promise<void>((resolve) => (locked = resolve));

    const revocation = admin(org, async (db) => {
      const actor = await db.user.findUniqueOrThrow({
        where: { id: actors.allowed },
        select: { organizationRoleId: true },
      });
      await db.organizationRolePermission.update({
        where: {
          organizationRoleId_capability: {
            organizationRoleId: actor.organizationRoleId!,
            capability: 'pharmacy:inventory',
          },
        },
        data: { effect: 'DENY' },
      });
      locked();
      await releaseGate;
    });
    await lockedGate;
    const attemptedWrite = call(actors.allowed, input);
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    await revocation;

    await expect(attemptedWrite).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await snapshot(org, input.inventoryLotId)).toEqual(before);
    await admin(org, async (db) => {
      const actor = await db.user.findUniqueOrThrow({
        where: { id: actors.allowed },
        select: { organizationRoleId: true },
      });
      await db.organizationRolePermission.update({
        where: {
          organizationRoleId_capability: {
            organizationRoleId: actor.organizationRoleId!,
            capability: 'pharmacy:inventory',
          },
        },
        data: { effect: 'ALLOW' },
      });
    });
  });

  it('refuses the write when concurrent actor deactivation commits first', async () => {
    const input = await fixture();
    const before = await snapshot(org, input.inventoryLotId);
    let release!: () => void;
    let locked!: () => void;
    const releaseGate = new Promise<void>((resolve) => (release = resolve));
    const lockedGate = new Promise<void>((resolve) => (locked = resolve));

    const deactivation = admin(org, async (db) => {
      await db.user.update({ where: { id: actors.allowed }, data: { status: 'INACTIVE' } });
      locked();
      await releaseGate;
    });
    await lockedGate;
    const attemptedWrite = call(actors.allowed, input);
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    await deactivation;

    await expect(attemptedWrite).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await snapshot(org, input.inventoryLotId)).toEqual(before);
    await admin(org, async (db) => {
      await db.user.update({ where: { id: actors.allowed }, data: { status: 'ACTIVE' } });
    });
  });

  it('allows reciprocal witnesses to write off concurrently in different branches', async () => {
    // Each actor writes in its own branch; each witness must also be assigned
    // to the branch it witnesses in.
    const reciprocalAssignments = [
      { branchId: branchB, userId: actors.unassigned },
      { branchId: branchA, userId: actors.unassigned },
      { branchId: branchB, userId: actors.allowed },
    ];
    await admin(org, (db) =>
      db.pharmacyBranchAssignment.createMany({
        data: reciprocalAssignments.map((row) => ({ organizationId: org, active: true, ...row })),
      })
    );
    const inputA = { ...(await fixture(branchA)), witnessId: actors.unassigned };
    const inputB = { ...(await fixture(branchB)), witnessId: actors.allowed };
    let arrivals = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => (release = resolve));
    function synchronize(db: ScopedDb): ScopedDb {
      return new Proxy(db, {
        get(target, key) {
          if (key === '$transaction') {
            return (run: (tx: ScopedDb) => Promise<unknown>) =>
              target.$transaction((tx) => run(synchronize(tx as ScopedDb)));
          }
          if (key === '$queryRaw') {
            return async (query: Prisma.Sql) => {
              const locksParticipants = query.strings
                .join('?')
                .includes('u.id, u.role, u.department, u.status');
              if (locksParticipants) {
                if (++arrivals === 2) release();
                await bothReady;
              }
              const result = await target.$queryRaw(query);
              // Give the other request time to acquire its actor lock with the
              // old ordering. Ordered participant locks safely serialize here.
              if (locksParticipants) await new Promise((resolve) => setTimeout(resolve, 100));
              return result;
            };
          }
          return Reflect.get(target, key);
        },
      });
    }

    const results = await Promise.allSettled([
      call(actors.allowed, inputA, synchronize),
      call(actors.unassigned, inputB, synchronize),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    for (const [input, actorId] of [
      [inputA, actors.allowed],
      [inputB, actors.unassigned],
    ] as const) {
      const after = await snapshot(org, input.inventoryLotId);
      expect(after.balances[0]!.onHandUnits).toBe(8);
      const movements = after.movements.filter((movement) => movement.kind === 'WRITE_OFF');
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ actorId, branchId: input.branchId, quantityUnits: -2 });
      expect(after.custody.filter((record) => record.movementId === movements[0]!.id)).toEqual([
        expect.objectContaining({ actorId, branchId: input.branchId, witnessId: input.witnessId }),
      ]);
    }
    await admin(org, (db) =>
      db.pharmacyBranchAssignment.deleteMany({
        where: { organizationId: org, OR: reciprocalAssignments },
      })
    );
  }, 30_000);
});
