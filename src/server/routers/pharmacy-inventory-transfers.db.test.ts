/**
 * WHA-1603 — INV-07 transfers console against migrated PostgreSQL with FORCED
 * row-level security, as a NOSUPERUSER NOBYPASSRLS runtime role.
 *
 * The whole lifecycle goes through the public router: allocate at branch A,
 * approve by a second person, dispatch, then a short closing receipt at branch
 * B. The ledger projection is read back after each case, because the variance
 * is only correct if the units it names actually leave IN_TRANSIT and nothing
 * else moves. Two closing receipts racing on one transfer must post exactly
 * one variance. Skipped (never silently passed) without both database URLs.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';

const RUNTIME_DATABASE_URL =
  process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
if (RUNTIME_DATABASE_URL) process.env.DATABASE_URL = RUNTIME_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

const describeIfDatabase = RUNTIME_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG = `org_wha1603_${suffix}`;
const FOREIGN_ORG = `org_wha1603_foreign_${suffix}`;
const BRANCH_A = `branch_a_${suffix}`;
const BRANCH_B = `branch_b_${suffix}`;
const ALLOCATOR = `user_alloc_${suffix}`;
const APPROVER = `user_appr_${suffix}`;
const WITNESS = `user_witness_${suffix}`;
const FOREIGN_USER = `user_foreign_${suffix}`;
const EXPIRES_AT = new Date('2028-06-01T00:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  router: (typeof import('./pharmacy-inventory'))['pharmacyInventoryRouter'];
  ledger: typeof import('@/lib/pharmacy/stock-ledger');
  operations: typeof import('@/lib/pharmacy/inventory-operations');
};
let deps: Deps;
let owner: Client;
const fixture = {
  lotId: '',
  shelfA: '',
  storeB: '',
};

function callerFor(db: ScopedDb, userId: string, organizationId = ORG) {
  return deps.router.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-inventory'],
      activeSeats: 3,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: { expires: 'later', user: { id: userId, role: 'ADMIN', status: 'ACTIVE' } },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

function as<T>(
  userId: string,
  work: (caller: ReturnType<typeof callerFor>) => Promise<T>,
  organizationId = ORG
): Promise<T> {
  return deps.withTenantDb(organizationId, (db) => work(callerFor(db, userId, organizationId)), {
    userId,
  });
}

/** The ledger projection for the fixture lot family, read as the owner with RLS bypass. */
async function balances() {
  await owner.query('BEGIN');
  try {
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    const rows = await owner.query<{
      branchId: string;
      disposition: string;
      units: number;
    }>(
      `SELECT "branchId", disposition::text AS disposition, SUM("onHandUnits")::int AS units
         FROM pharmacy_stock_balances WHERE "organizationId" = $1
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [ORG]
    );
    return Object.fromEntries(rows.rows.map((r) => [`${r.branchId}:${r.disposition}`, r.units]));
  } finally {
    await owner.query('ROLLBACK');
  }
}

async function varianceWriteOffs(transferId: string) {
  await owner.query('BEGIN');
  try {
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    const rows = await owner.query<{ quantityUnits: number; branchId: string; custody: number }>(
      `SELECT m."quantityUnits", m."branchId",
              (SELECT count(*)::int FROM pharmacy_custody_records c WHERE c."movementId" = m.id) AS custody
         FROM pharmacy_stock_movements m
        WHERE m."organizationId" = $1 AND m.kind = 'WRITE_OFF' AND m.disposition = 'IN_TRANSIT'
          AND m."idempotencyKey" LIKE $2`,
      [ORG, `transfer-variance:${transferId}:%`]
    );
    return rows.rows;
  } finally {
    await owner.query('ROLLBACK');
  }
}

/** Allocate → approve (second person) → dispatch; returns the in-transit transfer. */
async function dispatchedTransfer(units: number) {
  const allocated = await as(ALLOCATOR, (caller) =>
    caller.allocateTransfer({
      branchId: BRANCH_A,
      toBranchId: BRANCH_B,
      lines: [
        {
          sourceLotId: fixture.lotId,
          sourceStockLocationId: fixture.shelfA,
          destinationStockLocationId: fixture.storeB,
          quantityUnits: units,
        },
      ],
    })
  );
  await as(APPROVER, (caller) =>
    caller.approveTransfer({ branchId: BRANCH_A, transferId: allocated!.id })
  );
  await as(ALLOCATOR, (caller) =>
    caller.dispatchTransfer({
      branchId: BRANCH_A,
      transferId: allocated!.id,
      idempotencyKeyPrefix: `dispatch:${allocated!.id}`,
    })
  );
  return { id: allocated!.id, lineId: allocated!.lines[0]!.id };
}

const evidence = {
  reason: 'Carton crushed in transit',
  witnessId: WITNESS,
  evidenceRef: 'SEAL-42',
};

beforeAll(async () => {
  if (!RUNTIME_DATABASE_URL || !OWNER_DATABASE_URL) return;
  expect(OWNER_DATABASE_URL).not.toBe(RUNTIME_DATABASE_URL);

  const probe = new Client({ connectionString: RUNTIME_DATABASE_URL });
  await probe.connect();
  const role = await probe.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  await probe.end();
  expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

  owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  await owner.query('BEGIN');
  await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
  await owner.query(
    `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "updatedAt")
     VALUES ($1, $2, 'WHA-1603 TEST', 'WHA-1603 TEST', 'PHARMACY', 'ACTIVE', now()),
            ($3, $4, 'WHA-1603 FOREIGN', 'WHA-1603 FOREIGN', 'PHARMACY', 'ACTIVE', now())`,
    [ORG, `wha1603-${suffix}`, FOREIGN_ORG, `wha1603-foreign-${suffix}`]
  );
  await owner.query(
    `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
     VALUES ($1, $2, 'pharmacy', 'Pharmacy', now()), ($3, $4, 'pharmacy', 'Pharmacy', now())`,
    [`dept_${suffix}`, ORG, `dept_foreign_${suffix}`, FOREIGN_ORG]
  );
  await owner.query(
    `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt") VALUES
       ($1, $5, 'Allocator', $6, 'ADMIN', 'pharmacy', 'Pharmacist', now()),
       ($2, $5, 'Approver', $7, 'EMPLOYEE', 'pharmacy', 'Manager', now()),
       ($3, $5, 'Witness', $8, 'EMPLOYEE', 'pharmacy', 'Driver', now()),
       ($4, $9, 'Foreign', $10, 'EMPLOYEE', 'pharmacy', 'Other', now())`,
    [
      ALLOCATOR,
      APPROVER,
      WITNESS,
      FOREIGN_USER,
      ORG,
      `alloc-${suffix}@wha1603.invalid`,
      `appr-${suffix}@wha1603.invalid`,
      `witness-${suffix}@wha1603.invalid`,
      FOREIGN_ORG,
      `foreign-${suffix}@wha1603.invalid`,
    ]
  );
  await owner.query('COMMIT');

  deps = {
    withTenantDb: (await import('@/lib/tenancy/scoped-db')).withTenantDb,
    router: (await import('./pharmacy-inventory')).pharmacyInventoryRouter,
    ledger: await import('@/lib/pharmacy/stock-ledger'),
    operations: await import('@/lib/pharmacy/inventory-operations'),
  };

  await deps.withTenantDb(ORG, async (db) => {
    for (const [id, code, name] of [
      [BRANCH_A, 'A', 'Saddar'],
      [BRANCH_B, 'B', 'Clifton'],
    ] as const) {
      await db.pharmacyBranch.create({
        data: {
          id,
          organizationId: ORG,
          code: `${code}-${suffix}`,
          name,
          addressLine: '1 Test Road',
          city: 'Karachi',
          provinceCode: 'SD',
        },
      });
    }
    const shelf = await db.pharmacyStockLocation.create({
      data: {
        organizationId: ORG,
        branchId: BRANCH_A,
        code: 'SHELF',
        name: 'Front shelf',
        kind: 'STORE',
      },
    });
    const store = await db.pharmacyStockLocation.create({
      data: {
        organizationId: ORG,
        branchId: BRANCH_B,
        code: 'STORE',
        name: 'Back store',
        kind: 'STORE',
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId: ORG,
        productName: `Amoxicillin 500mg ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId: ORG, presentation: 'Capsule, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId: ORG,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId: ORG,
        medicineId: medicine.id,
        batchNumber: `B-${suffix}`,
        expiresAt: EXPIRES_AT,
        expiryPrecision: 'DAY',
      },
    });
    const received = await deps.ledger.receiveLot(
      db,
      { organizationId: ORG, branchId: BRANCH_A, actorId: ALLOCATOR },
      {
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        stockLocationId: shelf.id,
        unitsPerPack: 10,
        supplierName: 'Indus Pharma',
        supplierInvoiceRef: `INV-${suffix}`,
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        receivedExpiresAt: EXPIRES_AT,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 200,
        idempotencyKey: `receipt-${suffix}`,
        receivedAt: new Date('2026-09-01T00:00:00.000Z'),
      }
    );
    fixture.lotId = received.lot.id;
    fixture.shelfA = shelf.id;
    fixture.storeB = store.id;
  });
}, 60_000);

afterAll(async () => {
  await owner?.end();
});

describeIfDatabase('INV-07 transfers console on PostgreSQL', () => {
  it('walks allocate → approve → dispatch → short receipt and posts the variance once', async () => {
    const before = await balances();
    const transfer = await dispatchedTransfer(30);
    expect(await balances()).toMatchObject({
      [`${BRANCH_A}:AVAILABLE`]: before[`${BRANCH_A}:AVAILABLE`]! - 30,
      [`${BRANCH_A}:IN_TRANSIT`]: 30,
    });

    const result = await as(ALLOCATOR, (caller) =>
      caller.receiveTransferWithVariance({
        branchId: BRANCH_B,
        transferId: transfer.id,
        lines: [{ lineId: transfer.lineId, receivedUnits: 20 }],
        variance: evidence,
        idempotencyKeyPrefix: `close:${transfer.id}`,
      })
    );
    expect(result!.transfer.status).toBe('RECEIVED');

    expect(await balances()).toMatchObject({
      [`${BRANCH_A}:AVAILABLE`]: before[`${BRANCH_A}:AVAILABLE`]! - 30,
      [`${BRANCH_A}:IN_TRANSIT`]: 0,
      [`${BRANCH_B}:AVAILABLE`]: 20,
    });
    expect(await varianceWriteOffs(transfer.id)).toEqual([
      { quantityUnits: -10, branchId: BRANCH_A, custody: 1 },
    ]);

    // Both ends read the same closed, short transfer.
    for (const branchId of [BRANCH_A, BRANCH_B]) {
      const board = await as(ALLOCATOR, (caller) => caller.transferBoard({ branchId }));
      const row = board.find((one) => one.id === transfer.id)!;
      expect(row.direction).toBe(branchId === BRANCH_A ? 'OUTBOUND' : 'INBOUND');
      expect(row.lines[0]).toMatchObject({ receivedUnits: 20, varianceUnits: 10 });
    }
  });

  it('refuses a replayed close and the legacy line receipt once closed, posting nothing', async () => {
    const transfer = await dispatchedTransfer(10);
    const close = {
      branchId: BRANCH_B,
      transferId: transfer.id,
      lines: [{ lineId: transfer.lineId, receivedUnits: 0 }],
      variance: evidence,
      idempotencyKeyPrefix: `close:${transfer.id}`,
    };
    await as(ALLOCATOR, (caller) => caller.receiveTransferWithVariance(close));
    const after = await balances();

    await expect(
      as(ALLOCATOR, (caller) => caller.receiveTransferWithVariance(close))
    ).rejects.toMatchObject({ message: 'INVALID_STATE' });
    await expect(
      as(ALLOCATOR, (caller) =>
        caller.receiveTransferLine({
          branchId: BRANCH_B,
          transferId: transfer.id,
          lineId: transfer.lineId,
          receivedUnits: 1,
          idempotencyKeyPrefix: `late:${transfer.id}`,
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await balances()).toEqual(after);
    expect(await varianceWriteOffs(transfer.id)).toHaveLength(1);
  });

  it('lets exactly one of two racing closing receipts post', async () => {
    const transfer = await dispatchedTransfer(20);
    const close = (received: number) =>
      as(ALLOCATOR, (caller) =>
        caller.receiveTransferWithVariance({
          branchId: BRANCH_B,
          transferId: transfer.id,
          lines: [{ lineId: transfer.lineId, receivedUnits: received }],
          variance: evidence,
          idempotencyKeyPrefix: `race:${received}:${transfer.id}`,
        })
      );

    const outcomes = await Promise.allSettled([close(10), close(20)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ message: 'INVALID_STATE' });

    const posted = await varianceWriteOffs(transfer.id);
    expect(posted.length).toBeLessThanOrEqual(1);
    expect((await balances())[`${BRANCH_A}:IN_TRANSIT`]).toBe(0);
  });

  it('refuses a shortfall witnessed by the receiver or by another tenant’s user', async () => {
    const transfer = await dispatchedTransfer(20);
    const before = await balances();
    for (const witnessId of [ALLOCATOR, FOREIGN_USER]) {
      await expect(
        as(ALLOCATOR, (caller) =>
          caller.receiveTransferWithVariance({
            branchId: BRANCH_B,
            transferId: transfer.id,
            lines: [{ lineId: transfer.lineId, receivedUnits: 10 }],
            variance: { ...evidence, witnessId },
            idempotencyKeyPrefix: `bad-witness:${transfer.id}`,
          })
        )
      ).rejects.toMatchObject({ message: 'COAUTH_REQUIRED' });
    }
    expect(await balances()).toEqual(before);
    expect(await varianceWriteOffs(transfer.id)).toEqual([]);
  });

  // The existing line receipt removes a normalised arrangement from transit, so
  // loose units cannot come out of a strip that travelled sealed. Refused up
  // front with a domain reason instead of a CHECK violation mid-transaction.
  it('refuses a receipt that would open a sealed pack in transit, posting nothing', async () => {
    const transfer = await dispatchedTransfer(10);
    const before = await balances();
    await expect(
      as(ALLOCATOR, (caller) =>
        caller.receiveTransferWithVariance({
          branchId: BRANCH_B,
          transferId: transfer.id,
          lines: [{ lineId: transfer.lineId, receivedUnits: 5 }],
          variance: evidence,
          idempotencyKeyPrefix: `split:${transfer.id}`,
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'INVALID_ARRANGEMENT' });
    expect(await balances()).toEqual(before);
  });

  it('hides the transfer from another tenant naming its ids directly', async () => {
    const transfer = await dispatchedTransfer(10);
    await expect(
      as(
        FOREIGN_USER,
        (caller) =>
          caller.receiveTransferWithVariance({
            branchId: BRANCH_B,
            transferId: transfer.id,
            lines: [{ lineId: transfer.lineId, receivedUnits: 10 }],
            idempotencyKeyPrefix: `foreign:${transfer.id}`,
          }),
        FOREIGN_ORG
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CROSS_BRANCH_REFERENCE' });
    const board = await as(
      FOREIGN_USER,
      (caller) => caller.transferBoard({ branchId: BRANCH_B }),
      FOREIGN_ORG
    );
    expect(board).toEqual([]);
  });
});
