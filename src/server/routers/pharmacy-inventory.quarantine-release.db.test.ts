/**
 * DEV-1052 — only safety staff can release a safety quarantine, against PostgreSQL as a
 * NOSUPERUSER NOBYPASSRLS role with forced row-level security, through the real router.
 *
 * A stock clerk (`pharmacy:inventory`) could release stock a safety officer
 * (`pharmacy:safety`) had quarantined, and the counter then sold it. These cases drive the
 * two release procedures as real people with real role grants and read the stock balances
 * and the append-only hold entries back. Skipped unless TEST_DATABASE_URL names that role on
 * a migrated disposable database.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
/** The migration owner, when the runner provides one: the backfill runs as that role. */
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? process.env.OWNER_DATABASE_URL;
const itIfOwner = ownerUrl ? it : it.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `org_qrel_a_${suffix}`,
  orgB: `org_qrel_b_${suffix}`,
  branchA: `br_qrel_a_${suffix}`,
  branchB: `br_qrel_b_${suffix}`,
  branchOther: `br_qrel_o_${suffix}`,
  clerk: `user_qrel_clerk_${suffix}`,
  officer: `user_qrel_officer_${suffix}`,
  both: `user_qrel_both_${suffix}`,
  officerElsewhere: `user_qrel_offb_${suffix}`,
  witness: `user_qrel_wit_${suffix}`,
  outsider: `user_qrel_out_${suffix}`,
};

type Person = { id: string; organizationId: string };
type InventoryCaller = ReturnType<
  (typeof import('./pharmacy-inventory'))['pharmacyInventoryRouter']['createCaller']
>;

const SAFETY_HOLD = {
  code: 'FORBIDDEN',
  message:
    'This stock is held by pharmacy safety. Only someone with the safety permission can release it.',
};
const NO_PERMISSION = { code: 'FORBIDDEN', message: 'You do not have permission for this action.' };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let inventory: typeof import('./pharmacy-inventory');
let ledger: typeof import('@/lib/pharmacy/stock-ledger');
let operations: typeof import('@/lib/pharmacy/inventory-operations');
let holds: typeof import('@/lib/pharmacy/quarantine-holds');
let disconnect: (() => Promise<void>) | null = null;

const clerk: Person = { id: ids.clerk, organizationId: ids.orgA };
const officer: Person = { id: ids.officer, organizationId: ids.orgA };
const both: Person = { id: ids.both, organizationId: ids.orgA };
const officerElsewhere: Person = { id: ids.officerElsewhere, organizationId: ids.orgA };
const outsider: Person = { id: ids.outsider, organizationId: ids.orgB };

function context(db: unknown, user: Person) {
  return {
    db,
    entitlements: {
      organizationId: user.organizationId,
      enabledModules: ['pharmacy-inventory'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: user.id,
        role: 'EMPLOYEE',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: user.organizationId,
      },
    },
    organization: { id: user.organizationId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never;
}

/** One request by one person: its own transaction, as /api/trpc runs it. */
function act<T>(user: Person, run: (api: InventoryCaller) => Promise<T>): Promise<T> {
  return withTenantDb(
    user.organizationId,
    (db) =>
      run(inventory.pharmacyInventoryRouter.createCaller(context(db, user)) as InventoryCaller),
    { timeout: 60_000 }
  );
}

/** A refusal aborts the PostgreSQL transaction, so each expected one gets its own request. */
function refusal(user: Person, run: (api: InventoryCaller) => Promise<unknown>) {
  return act(user, run).then(
    () => ({ resolved: true }),
    (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message })
  );
}

let unique = 0;
function tag(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

type Stock = { lotId: string; locationId: string };

/** A private medicine, shelf and received lot of `units`, expiring in `days`. */
async function stock(label: string, units: number, days = 60, branchId = ids.branchA) {
  return withTenantDb(ids.orgA, async (db): Promise<Stock> => {
    const medicine = await db.medicine.create({
      data: {
        organizationId: ids.orgA,
        productName: `Hold test ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId: ids.orgA, presentation: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId: ids.orgA,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${tag(label)}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId: ids.orgA,
        branchId,
        code: `S-${tag(label)}`,
        name: 'Shelf',
        kind: 'STORE',
      },
    });
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId: ids.orgA,
        medicineId: medicine.id,
        batchNumber: `B-${tag(label)}`,
        expiresAt,
        expiryPrecision: 'DAY',
      },
    });
    const { lot } = await ledger.receiveLot(
      db,
      { organizationId: ids.orgA, branchId, actorId: ids.clerk },
      {
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        stockLocationId: location.id,
        unitsPerPack: 1,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: `INV-${tag(label)}`,
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: units,
        idempotencyKey: `receipt-${tag(label)}`,
        receivedAt: new Date('2026-02-01T00:00:00.000Z'),
      }
    );
    return { lotId: lot.id, locationId: location.id };
  });
}

function position(at: Stock) {
  return { branchId: ids.branchA, inventoryLotId: at.lotId, stockLocationId: at.locationId };
}

/** The safety officer quarantines `units` by hand (`quarantinePart`, pharmacy:safety). */
function safetyHold(at: Stock, units: number) {
  return act(officer, (api) =>
    api.quarantinePart({
      ...position(at),
      units,
      reason: 'Suspected counterfeit',
      idempotencyKeyPrefix: tag('safety-hold'),
    })
  );
}

/** The stock clerk quarantines `units` on the expiry board (pharmacy:inventory). */
function inventoryHold(at: Stock, units: number) {
  return act(clerk, (api) =>
    api.quarantineExpiring({
      ...position(at),
      units,
      reason: 'Short dated',
      requestKey: tag('expiry-hold'),
    })
  );
}

function release(at: Stock, units: number, key = tag('release'), reason = 'Cleared') {
  return { ...position(at), units, reason, idempotencyKeyPrefix: key };
}

/** What the counter can sell (AVAILABLE) and what is held (QUARANTINE), from the balances. */
async function units(at: Stock) {
  const rows = await withTenantDb(ids.orgA, (db) =>
    db.pharmacyStockBalance.findMany({
      where: { organizationId: ids.orgA, inventoryLotId: at.lotId, stockLocationId: at.locationId },
      select: { disposition: true, onHandUnits: true },
    })
  );
  const of = (disposition: string) =>
    rows.find((row) => row.disposition === disposition)?.onHandUnits ?? 0;
  return { saleable: of('AVAILABLE'), held: of('QUARANTINE') };
}

function entries(at: Stock) {
  return withTenantDb(ids.orgA, (db) =>
    db.pharmacyQuarantineHoldEntry.findMany({
      where: { organizationId: ids.orgA, inventoryLotId: at.lotId, stockLocationId: at.locationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        authority: true,
        origin: true,
        quantityUnits: true,
        actorId: true,
        reason: true,
        movementId: true,
      },
    })
  );
}

/** A hold as code before DEV-1052 left it: the two movements and no owner. */
async function ownerlessHold(at: Stock, heldUnits: number) {
  await withTenantDb(ids.orgA, async (db) => {
    const common = {
      organizationId: ids.orgA,
      branchId: ids.branchA,
      inventoryLotId: at.lotId,
      stockLocationId: at.locationId,
      kind: 'ADJUSTMENT' as const,
      actorId: ids.officer,
      reason: 'Held before owners were recorded',
    };
    const key = tag('ownerless');
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        disposition: 'AVAILABLE',
        quantityUnits: -heldUnits,
        sealedPackDelta: -heldUnits,
        idempotencyKey: `${key}:out`,
      },
    });
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        disposition: 'QUARANTINE',
        quantityUnits: heldUnits,
        sealedPackDelta: heldUnits,
        idempotencyKey: `${key}:in`,
      },
    });
  });
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  inventory = await import('./pharmacy-inventory');
  ledger = await import('@/lib/pharmacy/stock-ledger');
  operations = await import('@/lib/pharmacy/inventory-operations');
  holds = await import('@/lib/pharmacy/quarantine-holds');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  disconnect = () => db.$disconnect();

  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  const [table] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = 'pharmacy_quarantine_hold_entries'`
    )
  );
  expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

  await withPlatformDb(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Hold A', 'Hold A', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
              ($2, $2, 'Hold B', 'Hold B', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.orgA,
      ids.orgB
    );
  });

  const address = { addressLine: '1 Road', city: 'Lahore', provinceCode: 'PB' };
  const roleFor = (db: ScopedDb, key: string, capabilities: string[]) =>
    db.organizationRole.create({
      data: {
        key: `${key}-${suffix}`,
        name: key,
        permissions: {
          create: capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const })),
        },
      },
      select: { id: true },
    });
  const personFor = (db: ScopedDb, id: string, roleId: string) =>
    db.user.create({
      data: {
        id,
        name: `Person ${id}`,
        email: `${id}@example.test`,
        department: 'LEADERSHIP',
        title: 'Pharmacy',
        organizationRoleId: roleId,
      },
    });

  await withTenantDb(ids.orgA, async (db) => {
    await seedDepartments(db, [ids.orgA], ['LEADERSHIP']);
    await db.pharmacyBranch.createMany({
      data: [
        { id: ids.branchA, code: 'A', name: 'Branch A', ...address },
        { id: ids.branchB, code: 'B', name: 'Branch B', ...address },
      ],
    });
    const inventoryRole = await roleFor(db, 'stock-clerk', ['pharmacy:inventory']);
    const safetyRole = await roleFor(db, 'safety-officer', ['pharmacy:safety']);
    const bothRole = await roleFor(db, 'pharmacist', ['pharmacy:inventory', 'pharmacy:safety']);
    await personFor(db, ids.clerk, inventoryRole.id);
    await personFor(db, ids.witness, inventoryRole.id);
    await personFor(db, ids.officer, safetyRole.id);
    await personFor(db, ids.officerElsewhere, safetyRole.id);
    await personFor(db, ids.both, bothRole.id);
    await db.pharmacyBranchAssignment.createMany({
      data: [
        { userId: ids.clerk, branchId: ids.branchA },
        { userId: ids.witness, branchId: ids.branchA },
        { userId: ids.officer, branchId: ids.branchA },
        { userId: ids.both, branchId: ids.branchA },
        { userId: ids.officerElsewhere, branchId: ids.branchB },
      ],
    });
  });
  await withTenantDb(ids.orgB, async (db) => {
    await seedDepartments(db, [ids.orgB], ['LEADERSHIP']);
    await db.pharmacyBranch.create({
      data: { id: ids.branchOther, code: 'O', name: 'Other business', ...address },
    });
    const role = await roleFor(db, 'pharmacist', ['pharmacy:inventory', 'pharmacy:safety']);
    await personFor(db, ids.outsider, role.id);
    await db.pharmacyBranchAssignment.create({
      data: { userId: ids.outsider, branchId: ids.branchOther },
    });
  });
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('DEV-1052 only safety staff release a safety quarantine', () => {
  it('refuses a stock clerk releasing a safety hold, and the stock stays unsaleable', async () => {
    const at = await stock('clerk-refused', 20);
    await safetyHold(at, 10);
    expect(await units(at)).toEqual({ saleable: 10, held: 10 });
    expect(await entries(at)).toEqual([
      expect.objectContaining({
        authority: 'SAFETY',
        origin: 'MANUAL',
        quantityUnits: 10,
        actorId: ids.officer,
        reason: 'Suspected counterfeit',
      }),
    ]);

    // The whole hold, one unit of it, and the direct call that skips the screen.
    for (const asked of [10, 1]) {
      expect(await refusal(clerk, (api) => api.releaseQuarantinedPart(release(at, asked)))).toEqual(
        SAFETY_HOLD
      );
    }
    // The safety procedure is not open to the inventory permission at all.
    expect(await refusal(clerk, (api) => api.releaseSafetyQuarantine(release(at, 1)))).toEqual(
      NO_PERMISSION
    );

    expect(await units(at)).toEqual({ saleable: 10, held: 10 });
    expect((await entries(at)).filter((entry) => entry.origin === 'RELEASE')).toEqual([]);
  });

  it('lets a safety officer admitted to the branch release it, with the reason on record', async () => {
    const at = await stock('officer-release', 20);
    await safetyHold(at, 10);
    const moved = await act(officer, (api) =>
      api.releaseSafetyQuarantine(release(at, 10, tag('release'), 'Lab cleared the batch'))
    );
    expect(await units(at)).toEqual({ saleable: 20, held: 0 });
    expect((await entries(at)).at(-1)).toEqual({
      authority: 'SAFETY',
      origin: 'RELEASE',
      quantityUnits: -10,
      actorId: ids.officer,
      reason: 'Lab cleared the batch',
      movementId: moved!.removed.id,
    });
  });

  it('still lets inventory release a hold a stock workflow placed, and not a safety officer alone', async () => {
    const at = await stock('inventory-hold', 20);
    await inventoryHold(at, 8);
    expect(await entries(at)).toEqual([
      expect.objectContaining({
        authority: 'INVENTORY',
        origin: 'EXPIRY',
        quantityUnits: 8,
        actorId: ids.clerk,
      }),
    ]);
    // Each unit is checked against its own hold: this one is not a safety hold.
    expect(await refusal(officer, (api) => api.releaseSafetyQuarantine(release(at, 1)))).toEqual({
      code: 'FORBIDDEN',
      message:
        'Only 0 of these units are a safety hold. The rest was held by a stock workflow, and someone with the inventory permission releases it.',
    });
    expect(await units(at)).toEqual({ saleable: 12, held: 8 });

    await act(clerk, (api) => api.releaseQuarantinedPart(release(at, 8)));
    expect(await units(at)).toEqual({ saleable: 20, held: 0 });
    expect((await entries(at)).at(-1)).toEqual(
      expect.objectContaining({ authority: 'INVENTORY', origin: 'RELEASE', quantityUnits: -8 })
    );
  });

  it('checks each unit of a mixed lot against its own hold', async () => {
    const at = await stock('mixed', 20);
    await safetyHold(at, 6);
    await inventoryHold(at, 4);
    expect(await units(at)).toEqual({ saleable: 10, held: 10 });

    // The clerk can never take more than the inventory-owned quantity.
    for (const asked of [10, 5]) {
      expect(await refusal(clerk, (api) => api.releaseQuarantinedPart(release(at, asked)))).toEqual(
        {
          code: 'FORBIDDEN',
          message:
            'Only 4 of these units can be released with the inventory permission. The rest is held by pharmacy safety, and only someone with the safety permission can release it.',
        }
      );
    }
    expect(await units(at)).toEqual({ saleable: 10, held: 10 });

    await act(clerk, (api) => api.releaseQuarantinedPart(release(at, 4)));
    expect(await units(at)).toEqual({ saleable: 14, held: 6 });
    // Nothing inventory-owned is left, so one more unit is a safety unit.
    expect(await refusal(clerk, (api) => api.releaseQuarantinedPart(release(at, 1)))).toEqual(
      SAFETY_HOLD
    );
    expect(await units(at)).toEqual({ saleable: 14, held: 6 });

    await act(officer, (api) => api.releaseSafetyQuarantine(release(at, 6)));
    expect(await units(at)).toEqual({ saleable: 20, held: 0 });
  });

  it('records both authorities when someone holding both permissions releases a mixed lot', async () => {
    const at = await stock('mixed-both', 20);
    await safetyHold(at, 6);
    await inventoryHold(at, 4);
    const moved = await act(both, (api) => api.releaseQuarantinedPart(release(at, 10)));
    expect(await units(at)).toEqual({ saleable: 20, held: 0 });
    expect((await entries(at)).filter((entry) => entry.origin === 'RELEASE')).toEqual([
      expect.objectContaining({
        authority: 'INVENTORY',
        quantityUnits: -4,
        actorId: ids.both,
        movementId: moved!.removed.id,
      }),
      expect.objectContaining({
        authority: 'SAFETY',
        quantityUnits: -6,
        actorId: ids.both,
        movementId: moved!.removed.id,
      }),
    ]);
  });

  it('treats a hold with no recorded owner as a safety hold', async () => {
    const at = await stock('ownerless', 20);
    await ownerlessHold(at, 7);
    expect(await entries(at)).toEqual([]);
    const shown = await withTenantDb(ids.orgA, (db) =>
      holds.listQuarantineHolds(db, { organizationId: ids.orgA, branchId: ids.branchA })
    );
    expect(shown.get(`${at.lotId}:${at.locationId}`)).toMatchObject({
      safetyUnits: 7,
      inventoryUnits: 0,
    });

    expect(await refusal(clerk, (api) => api.releaseQuarantinedPart(release(at, 1)))).toEqual(
      SAFETY_HOLD
    );
    expect(await units(at)).toEqual({ saleable: 13, held: 7 });

    await act(officer, (api) => api.releaseSafetyQuarantine(release(at, 7)));
    expect(await units(at)).toEqual({ saleable: 20, held: 0 });
    expect(await entries(at)).toEqual([
      expect.objectContaining({ authority: 'SAFETY', origin: 'UNATTRIBUTED', quantityUnits: 7 }),
      expect.objectContaining({ authority: 'SAFETY', origin: 'RELEASE', quantityUnits: -7 }),
    ]);
  });

  itIfOwner(
    'backfills existing ownerless holds as safety holds without changing stock, once',
    async () => {
      const at = await stock('backfill', 20);
      await ownerlessHold(at, 9);
      const sql = readFileSync(
        join(
          process.cwd(),
          'prisma/migrations/20261127060000_pharmacy_quarantine_hold_entries/migration.sql'
        ),
        'utf8'
      );
      const backfill = sql.slice(
        sql.indexOf("SELECT set_config('app.is_platform_admin', 'true', true);"),
        sql.lastIndexOf('COMMIT;')
      );
      expect(backfill).toContain("'LEGACY'");
      const owner = new Client({ connectionString: ownerUrl });
      await owner.connect();
      try {
        // Twice: the migration must be safe to run again.
        for (let run = 0; run < 2; run += 1) await owner.query(`BEGIN;\n${backfill}\nCOMMIT;`);
      } finally {
        await owner.end();
      }
      expect(await units(at)).toEqual({ saleable: 11, held: 9 });
      expect(await entries(at)).toEqual([
        {
          authority: 'SAFETY',
          origin: 'LEGACY',
          quantityUnits: 9,
          actorId: null,
          reason: 'Held before hold ownership was recorded',
          movementId: null,
        },
      ]);
      expect(await refusal(clerk, (api) => api.releaseQuarantinedPart(release(at, 9)))).toEqual(
        SAFETY_HOLD
      );
      expect(await units(at)).toEqual({ saleable: 11, held: 9 });
    }
  );

  it('replays a release without moving stock twice, and refuses a different request on the key', async () => {
    const at = await stock('replay', 20);
    await safetyHold(at, 10);
    const key = tag('replay-key');
    const first = await act(officer, (api) => api.releaseSafetyQuarantine(release(at, 4, key)));
    const again = await act(officer, (api) => api.releaseSafetyQuarantine(release(at, 4, key)));
    expect(again!.removed.id).toBe(first!.removed.id);
    expect(again!.released.id).toBe(first!.released.id);
    expect(await units(at)).toEqual({ saleable: 14, held: 6 });
    expect((await entries(at)).filter((entry) => entry.origin === 'RELEASE')).toHaveLength(1);

    expect(
      await refusal(officer, (api) => api.releaseSafetyQuarantine(release(at, 5, key)))
    ).toMatchObject({ code: 'CONFLICT' });
    // Someone else cannot ride the officer's key to a release of their own.
    expect(
      await refusal(both, (api) => api.releaseQuarantinedPart(release(at, 4, key)))
    ).toMatchObject({ code: 'CONFLICT' });
    expect(await units(at)).toEqual({ saleable: 14, held: 6 });
  });

  it('refuses a safety officer of another branch, and another business', async () => {
    const at = await stock('elsewhere', 20);
    await safetyHold(at, 10);

    // Safety permission, but assigned to branch B only.
    expect(
      await refusal(officerElsewhere, (api) => api.releaseSafetyQuarantine(release(at, 1)))
    ).toEqual({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
    // Naming their own branch does not reach branch A's lot.
    expect(
      await refusal(officerElsewhere, (api) =>
        api.releaseSafetyQuarantine({ ...release(at, 1), branchId: ids.branchB })
      )
    ).toEqual({ code: 'FORBIDDEN', message: 'CROSS_BRANCH_REFERENCE' });

    // Another business, holding both permissions there.
    for (const call of ['releaseSafetyQuarantine', 'releaseQuarantinedPart'] as const) {
      expect(await refusal(outsider, (api) => api[call](release(at, 1)))).toEqual({
        code: 'BAD_REQUEST',
        message: 'That record is not in this workspace.',
      });
      expect(
        await refusal(outsider, (api) =>
          api[call]({ ...release(at, 1), branchId: ids.branchOther })
        )
      ).toEqual({ code: 'FORBIDDEN', message: 'CROSS_BRANCH_REFERENCE' });
    }
    expect(await units(at)).toEqual({ saleable: 10, held: 10 });
    // Row-level security: the other business cannot read who holds what here.
    const seen = await withTenantDb(ids.orgB, (db) =>
      db.pharmacyQuarantineHoldEntry.count({ where: { inventoryLotId: at.lotId } })
    );
    expect(seen).toBe(0);
  });

  it('records goods refused at receiving as an inventory hold', async () => {
    const at = await stock('goods-in-shelf', 5);
    const held = await withTenantDb(ids.orgA, async (db) => {
      const lot = await db.pharmacyInventoryLot.findFirstOrThrow({ where: { id: at.lotId } });
      const { lot: received } = await ledger.receiveLot(
        db,
        { organizationId: ids.orgA, branchId: ids.branchA, actorId: ids.clerk },
        {
          manufacturingBatchId: lot.manufacturingBatchId,
          packLevelId: lot.packLevelId,
          stockLocationId: at.locationId,
          unitsPerPack: 1,
          supplierName: 'Distributor Ltd',
          supplierInvoiceRef: `INV-${tag('goods-in')}`,
          unitCostMinor: 1200,
          printedMrpMinor: 2000,
          receivedExpiresAt: lot.receivedExpiresAt ?? new Date(Date.now() + 60 * 86_400_000),
          receivedExpiryPrecision: 'DAY',
          quantityUnits: 5,
          idempotencyKey: `receipt-${tag('goods-in')}`,
          receivedAt: new Date('2026-02-01T00:00:00.000Z'),
          quarantine: {
            units: 3,
            stockLocationId: at.locationId,
            idempotencyKey: `receipt-q-${tag('goods-in')}`,
            reason: 'Damaged carton',
          },
        }
      );
      return { lotId: received.id, locationId: at.locationId };
    });
    expect(await entries(held)).toEqual([
      expect.objectContaining({
        authority: 'INVENTORY',
        origin: 'GOODS_IN',
        quantityUnits: 3,
        actorId: ids.clerk,
      }),
    ]);
    await act(clerk, (api) => api.releaseQuarantinedPart(release(held, 3)));
    expect(await units(held)).toEqual({ saleable: 8, held: 0 });
  });

  it('never lets a write-off turn what is left of a safety hold into an inventory hold', async () => {
    const at = await stock('write-off', 20);
    await safetyHold(at, 6);
    await inventoryHold(at, 4);
    // Four held units are destroyed. They come off the inventory hold first.
    await withTenantDb(ids.orgA, (db) =>
      operations.writeOff(
        db,
        { organizationId: ids.orgA, branchId: ids.branchA, actorId: ids.clerk },
        {
          inventoryLotId: at.lotId,
          stockLocationId: at.locationId,
          units: 4,
          witnessId: ids.witness,
          reason: 'Destroyed',
          evidenceRef: 'certificate',
          idempotencyKey: tag('write-off'),
          disposition: 'QUARANTINE',
        }
      )
    );
    expect(await units(at)).toEqual({ saleable: 10, held: 6 });
    expect((await entries(at)).at(-1)).toEqual(
      expect.objectContaining({
        authority: 'INVENTORY',
        origin: 'REMOVED',
        quantityUnits: -4,
        actorId: ids.clerk,
      })
    );
    expect(await refusal(clerk, (api) => api.releaseQuarantinedPart(release(at, 1)))).toEqual(
      SAFETY_HOLD
    );
    expect(await units(at)).toEqual({ saleable: 10, held: 6 });
  });

  it('keeps the hold entries append-only and the per-authority balance non-negative', async () => {
    const at = await stock('append-only', 20);
    await safetyHold(at, 5);
    const attempt = (work: (db: ScopedDb) => Promise<unknown>) =>
      withTenantDb(ids.orgA, work).then(
        () => 'resolved',
        (error: Error) => error.message
      );
    const where = { organizationId: ids.orgA, inventoryLotId: at.lotId };
    expect(
      await attempt((db) =>
        db.pharmacyQuarantineHoldEntry.updateMany({ where, data: { authority: 'INVENTORY' } })
      )
    ).toContain('append-only');
    expect(await attempt((db) => db.pharmacyQuarantineHoldEntry.deleteMany({ where }))).toContain(
      'append-only'
    );
    // A forged inventory release of units inventory never held is refused by the database.
    expect(
      await attempt((db) =>
        db.pharmacyQuarantineHoldEntry.create({
          data: {
            branchId: ids.branchA,
            inventoryLotId: at.lotId,
            stockLocationId: at.locationId,
            authority: 'INVENTORY',
            origin: 'REMOVED',
            quantityUnits: -5,
          },
        })
      )
    ).toContain('exceeds the units this authority holds');
    // And nobody places a safety hold in inventory's name.
    expect(
      await attempt((db) =>
        db.pharmacyQuarantineHoldEntry.create({
          data: {
            branchId: ids.branchA,
            inventoryLotId: at.lotId,
            stockLocationId: at.locationId,
            authority: 'INVENTORY',
            origin: 'MANUAL',
            quantityUnits: 5,
            actorId: ids.clerk,
            movementId: 'missing',
          },
        })
      )
    ).not.toBe('resolved');
    expect(await entries(at)).toHaveLength(1);
  });
});
