/**
 * DEV-936 — central purchasing honours the branch assignment, against migrated PostgreSQL
 * with FORCE row level security, as the NOSUPERUSER/NOBYPASSRLS runtime role.
 *
 * An organization-wide central grant says *what* a buyer may do; the receiving branch of a
 * central order and every destination branch of a central allocation still need an active
 * assignment, or the live owner exception. A refused request writes nothing: no order, no
 * transfer, no allocation evidence. Real router, real ABAC; only the tRPC audit-log writer
 * is stubbed.
 *
 * Skipped unless TEST_DATABASE_URL names the runtime role on a migrated disposable database.
 */
import { randomBytes } from 'node:crypto';
import { hashSync } from 'bcryptjs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (databaseUrl) {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!/(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i.test(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must name a dedicated disposable database (test, e2e, tmp, or disposable).'
    );
  }
  process.env.DATABASE_URL = databaseUrl;
}
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type PurchasingRouter = (typeof import('./pharmacy-purchasing'))['pharmacyPurchasingRouter'];
type PurchasingApi = ReturnType<PurchasingRouter['createCaller']>;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let purchasingRouter: PurchasingRouter;
let disconnect: (() => Promise<void>) | null = null;

const suffix = randomBytes(5).toString('hex');
/** Synthetic PIN for the direct-purchase approver; this database is disposable. */
const APPROVER_PIN = '2468';
const OUTSIDE_SCOPE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };

const X = {
  org: `org_dev936_${suffix}`,
  central: `br936_central_${suffix}`,
  north: `br936_north_${suffix}`,
  south: `br936_south_${suffix}`,
  owner: `u936_owner_${suffix}`,
  buyer: `u936_buyer_${suffix}`,
  approver: `u936_approver_${suffix}`,
  supplier: `s936_${suffix}`,
  medicine: `med936_${suffix}`,
  packLevel: `pack936_${suffix}`,
};
const storeOf = (branchId: string) => `loc_${branchId}`;
const roleIdOf = (key: string) => `${X.org}_role_${key}`;

type Actor = { userId: string; tenantRole: 'ADMIN' | 'EMPLOYEE' };
const OWNER: Actor = { userId: X.owner, tenantRole: 'ADMIN' };
const BUYER: Actor = { userId: X.buyer, tenantRole: 'EMPLOYEE' };

function context(db: ScopedDb, actor: Actor) {
  return {
    db,
    entitlements: {
      organizationId: X.org,
      enabledModules: ['pharmacy-procurement'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 3,
    },
    session: {
      expires: 'later',
      user: {
        id: actor.userId,
        role: actor.tenantRole,
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: X.org,
      },
    },
    organization: { id: X.org, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
}

/** One request, in its own tenant transaction, the way the tRPC route runs it. */
function as<T>(actor: Actor, run: (api: PurchasingApi) => Promise<T>) {
  return withTenantDb(
    X.org,
    (db) => run(purchasingRouter.createCaller(context(db, actor) as never)),
    { userId: actor.userId, timeout: 60_000 }
  );
}

function read<T>(run: (db: ScopedDb) => Promise<T>) {
  return withTenantDb(X.org, run, { userId: X.owner, timeout: 60_000 });
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );

function centralOrder(receivingBranchId: string, reference: string) {
  return {
    reference,
    supplierId: X.supplier,
    receivingBranchId,
    lines: [
      {
        medicineId: X.medicine,
        packLevelId: X.packLevel,
        orderedPacks: 3,
        canonicalUnitsPerPack: 10,
        listPricePerPackMinor: 10_000,
      },
    ],
  };
}

/** A posted direct-purchase receipt of 20 units at the central branch. */
async function postedCentralReceipt(label: string) {
  const draft = await as(BUYER, (api) =>
    api.createGoodsReceipt({
      reference: `GRN-${label}-${suffix}`,
      branchId: X.central,
      supplierId: X.supplier,
      supplierInvoiceRef: `INV-${label}-${suffix}`,
      supplierInvoiceDate: new Date(),
      warrantyEvidenceRef: `WARRANTY-${label}-${suffix}`,
      receivedAt: new Date(),
      directPurchase: {
        reason: 'Central buy for the chain, allocated on arrival.',
        approvedByUserId: X.approver,
        pin: APPROVER_PIN,
      },
      lines: [
        {
          medicineId: X.medicine,
          packLevelId: X.packLevel,
          batchNumber: `B-${label}-${suffix}`,
          printedExpiry: new Date('2028-06-01T00:00:00.000Z'),
          expiryPrecision: 'DAY',
          printedMrpMinor: 25_000,
          canonicalUnitsPerPack: 10,
          receivedPacks: 2,
          invoicedPricePerPackMinor: 10_000,
          stockLocationId: storeOf(X.central),
        },
      ],
    })
  );
  if (!draft || typeof draft !== 'object' || !('id' in draft)) {
    throw new Error(`Goods receipt was not drafted: ${JSON.stringify(draft)}`);
  }
  await as(BUYER, (api) =>
    api.postGoodsReceipt({ branchId: X.central, goodsReceiptId: draft.id as string })
  );
  const receipt = await read((db) =>
    db.pharmacyGoodsReceipt.findFirstOrThrow({
      where: { id: draft.id as string },
      include: { lines: true },
    })
  );
  expect(receipt.status).toBe('POSTED');
  expect(receipt.lines).toHaveLength(1);
  expect(receipt.lines[0]!.acceptedCanonicalUnits).toBe(20);
  expect(receipt.lines[0]!.inventoryLotId).toBeTruthy();
  return {
    goodsReceiptId: receipt.id,
    lineId: receipt.lines[0]!.id,
    lotId: receipt.lines[0]!.inventoryLotId!,
  };
}

function allocation(receipt: { goodsReceiptId: string; lineId: string }, split: string[]) {
  const quantityUnits = 20 / split.length;
  return {
    goodsReceiptId: receipt.goodsReceiptId,
    allocations: split.map((destinationBranchId) => ({
      goodsReceiptLineId: receipt.lineId,
      destinationBranchId,
      destinationStockLocationId: storeOf(destinationBranchId),
      quantityUnits,
    })),
  };
}

function writtenFor(receipt: { lineId: string; lotId: string }) {
  return read(async (db) => ({
    allocations: await db.pharmacyCentralPurchaseAllocation.count({
      where: { goodsReceiptLineId: receipt.lineId },
    }),
    transferLines: await db.pharmacyInterbranchTransferLine.count({
      where: { sourceLotId: receipt.lotId },
    }),
  }));
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const purchasing = await import('./pharmacy-purchasing');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  purchasingRouter = purchasing.pharmacyPurchasingRouter;
  disconnect = () => db.$disconnect();
  // With SUPERUSER or BYPASSRLS this suite would pass for the wrong reason.
  await assertRlsEnforcingRole(withPlatformDb);

  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      X.org
    )
  );
  await withTenantDb(
    X.org,
    async (tx) => {
      await seedDepartments(tx, [X.org], ['LEADERSHIP']);
      const roles = [
        { key: 'owner', isSystem: true, grants: ['pharmacy:*', 'reports:financial'] },
        { key: 'procurement', isSystem: true, grants: ['pharmacy:procurement'] },
        {
          key: 'procurement-approver',
          isSystem: false,
          grants: ['pharmacy:procurement', 'pharmacy:procurement-approve'],
        },
      ];
      for (const role of roles) {
        await tx.organizationRole.create({
          data: {
            id: roleIdOf(role.key),
            key: role.key,
            name: role.key,
            isSystem: role.isSystem,
            permissions: {
              create: role.grants.map((capability) => ({ capability, effect: 'ALLOW' as const })),
            },
          },
        });
      }
      const people = [
        { id: X.owner, role: 'owner', tenantRole: 'ADMIN' as const },
        { id: X.buyer, role: 'procurement', tenantRole: 'EMPLOYEE' as const },
        { id: X.approver, role: 'procurement-approver', tenantRole: 'EMPLOYEE' as const },
      ];
      for (const person of people) {
        await tx.user.create({
          data: {
            id: person.id,
            name: person.id,
            email: `${person.id}@example.test`,
            department: 'LEADERSHIP',
            title: 'Pharmacy staff',
            role: person.tenantRole,
            status: 'ACTIVE',
            organizationRoleId: roleIdOf(person.role),
          },
        });
      }
      const address = { addressLine: '1 Mall Road', city: 'Lahore', provinceCode: 'PB' };
      for (const [id, code] of [
        [X.central, 'CEN'],
        [X.north, 'NOR'],
        [X.south, 'SOU'],
      ] as const) {
        await tx.pharmacyBranch.create({
          data: { id, code: `${code}-${suffix}`, name: `DEV-936 ${code}`, ...address },
        });
        await tx.pharmacyStockLocation.create({
          data: {
            id: storeOf(id),
            branchId: id,
            code: `MAIN-${code}-${suffix}`,
            name: 'Main',
            kind: 'STORE',
          },
        });
      }
      // The buyer holds an organization-wide central grant but works at two branches only.
      await tx.pharmacyCentralPurchasingAccess.create({
        data: { userId: X.buyer, branchId: null, grantedById: X.owner },
      });
      await tx.pharmacyBranchAssignment.createMany({
        data: [
          { userId: X.buyer, branchId: X.central },
          { userId: X.buyer, branchId: X.north },
          { userId: X.approver, branchId: X.central },
        ],
      });
      await tx.restaurantStaffProfile.create({
        data: {
          userId: X.approver,
          displayName: 'DEV-936 Approver',
          credentials: { create: { type: 'PIN', credentialHash: hashSync(APPROVER_PIN, 4) } },
        },
      });
      await tx.pharmacySupplier.create({
        data: { id: X.supplier, name: `Distributor ${suffix}`, authorized: true },
      });
      await tx.pharmacySupplierLicence.create({
        data: {
          supplierId: X.supplier,
          licenceType: 'DRUG_SALE',
          licenceNumber: `DSL-936-${suffix}`,
          issuingAuthority: 'DRAP',
          issuedAt: new Date('2025-01-01T00:00:00.000Z'),
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          verifiedAt: new Date('2025-01-02T00:00:00.000Z'),
        },
      });
      const medicine = await tx.medicine.create({
        data: {
          id: X.medicine,
          productName: `Amoxicillin ${suffix}`,
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          controlled: false,
          presentations: { create: { presentation: 'Tablet, 10 per strip' } },
        },
        include: { presentations: true },
      });
      await tx.packLevel.create({
        data: {
          id: X.packLevel,
          presentationId: medicine.presentations[0]!.id,
          versionGroupId: `strip-${X.packLevel}`,
          version: 1,
          level: 'STRIP',
          unitsPerParent: 10,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
    },
    { userId: X.owner, timeout: 60_000 }
  );
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('DEV-936 central purchasing branch assignment (runtime role, RLS on)', () => {
  describe('createCentralPurchaseOrder', () => {
    it('refuses a branch-limited buyer for an unassigned receiving branch and writes nothing', async () => {
      const reference = `CPO-REFUSED-${suffix}`;
      const outcome = await settle(
        as(BUYER, (api) => api.createCentralPurchaseOrder(centralOrder(X.south, reference)))
      );
      expect(outcome).toMatchObject({ ok: false, error: OUTSIDE_SCOPE });
      await expect(
        read((db) => db.pharmacyPurchaseOrder.count({ where: { reference } }))
      ).resolves.toBe(0);
    });

    it('lets the buyer order for a branch they are assigned to', async () => {
      const order = await as(BUYER, (api) =>
        api.createCentralPurchaseOrder(centralOrder(X.north, `CPO-NORTH-${suffix}`))
      );
      expect(order).toMatchObject({ branchId: X.north, createdByUserId: X.buyer });
    });

    it('still lets the owner order for a branch they hold no assignment for', async () => {
      const order = await as(OWNER, (api) =>
        api.createCentralPurchaseOrder(centralOrder(X.south, `CPO-OWNER-${suffix}`))
      );
      expect(order).toMatchObject({ branchId: X.south, createdByUserId: X.owner });
    });
  });

  describe('allocateCentralReceipt', () => {
    it('refuses when any destination branch is unassigned and moves no stock', async () => {
      const receipt = await postedCentralReceipt('refused');
      for (const split of [[X.south], [X.north, X.south]]) {
        const outcome = await settle(
          as(BUYER, (api) => api.allocateCentralReceipt(allocation(receipt, split)))
        );
        expect(outcome).toMatchObject({ ok: false, error: OUTSIDE_SCOPE });
      }
      await expect(writtenFor(receipt)).resolves.toEqual({ allocations: 0, transferLines: 0 });
    });

    it('lets the buyer allocate to a branch they are assigned to', async () => {
      const receipt = await postedCentralReceipt('north');
      const result = await as(BUYER, (api) =>
        api.allocateCentralReceipt(allocation(receipt, [X.north]))
      );
      expect(result).toHaveLength(1);
      expect(result![0]!.allocation).toMatchObject({ destinationBranchId: X.north });
    });

    it('still lets the owner allocate to branches they hold no assignment for', async () => {
      const receipt = await postedCentralReceipt('owner');
      const result = await as(OWNER, (api) =>
        api.allocateCentralReceipt(allocation(receipt, [X.north, X.south]))
      );
      expect(result).toHaveLength(2);
      const written = await read((db) =>
        db.pharmacyCentralPurchaseAllocation.findMany({
          where: { goodsReceiptLineId: receipt.lineId },
          select: { destinationBranchId: true, allocatedById: true },
          orderBy: { destinationBranchId: 'asc' },
        })
      );
      expect(written).toEqual(
        [X.north, X.south]
          .sort()
          .map((destinationBranchId) => ({ destinationBranchId, allocatedById: X.owner }))
      );
    });
  });
});
