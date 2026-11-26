/**
 * @vitest-environment node
 *
 * DEV-965: six pharmacy reads and writes that checked only "is this person on the
 * branch's staff list" (or less), against a REAL migrated PostgreSQL through the real
 * routers, each call in its own tenant transaction the way each HTTP request runs. For
 * each one a branch staff member without the fitting permission is refused and a
 * person holding it still gets exactly what they got before:
 *
 *   1. customerSnapshot  — the counter permission family (pharmacy:counter or
 *                          pharmacy:dispense) and the branch assignment.
 *   2. nearExpiryBoard   — the PKR value at risk only with reports:financial.
 *   3. recallTrace       — pharmacy:safety, and only the person's branches; a head-office
 *                          ADMIN with inventory reach still sees every branch.
 *   4. pharmacyMarketing — admin:access through can(): an explicit DENY refuses an
 *                          ADMIN, an explicit ALLOW admits a non-ADMIN.
 *   5. authenticatePack  — the counter permission family; a refused scan writes no row.
 *   6. stockSignalDigest — only the digest's owner, or an administrator.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first), so row
 * level security applies to every fixture write and every read. Without it the suite
 * reports itself skipped rather than passing vacuously.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// `@/lib/db` reads DATABASE_URL on first use; everything that reaches it is
// imported inside the suite, after this line.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `perm_gaps_a_${suffix}`;
const OTHER_ORG = `perm_gaps_b_${suffix}`;
const MAIN = `perm_gaps_main_${suffix}`;
const DHA = `perm_gaps_dha_${suffix}`;
const FOREIGN = `perm_gaps_foreign_${suffix}`;

/** Who is who. Every EMPLOYEE below is actively assigned to Main Branch only. */
const P = {
  cashier: `perm_gaps_cashier_${suffix}`, // Cashier template: pharmacy:counter, pharmacy:orders
  pharmacist: `perm_gaps_rph_${suffix}`, // Pharmacist template: pharmacy:dispense, ...
  stock: `perm_gaps_stock_${suffix}`, // Inventory template: pharmacy:inventory only
  safety: `perm_gaps_safety_${suffix}`, // pharmacy:safety only
  finance: `perm_gaps_finance_${suffix}`, // Finance template: reports:*
  granted: `perm_gaps_granted_${suffix}`, // Inventory + an explicit admin:access ALLOW
  owner: `perm_gaps_owner_${suffix}`, // ADMIN, Owner template, no branch assignment
  deniedOwner: `perm_gaps_denied_${suffix}`, // ADMIN, Owner template, admin:access DENY
};
type Role = 'ADMIN' | 'EMPLOYEE';
const roleOf = (id: string): Role =>
  id === P.owner || id === P.deniedOwner ? 'ADMIN' : 'EMPLOYEE';

const PERMISSION = { code: 'FORBIDDEN', message: 'You do not have permission for this action.' };
const OUTSIDE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };
const OWNER_REQUIRED = {
  code: 'FORBIDDEN',
  message: 'An owner account is required. Ask a workspace owner to open Marketing.',
};
const DIGEST_REFUSAL = {
  code: 'FORBIDDEN',
  message: 'Only the owner of this digest or an administrator can read it.',
};

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
let routers: {
  sales: (typeof import('./pharmacy-sales'))['pharmacySalesRouter'];
  inventory: (typeof import('./pharmacy-inventory'))['pharmacyInventoryRouter'];
  medicine: (typeof import('./pharmacy-medicine'))['pharmacyMedicineRouter'];
  warehouse: (typeof import('./pharmacy-warehouse'))['pharmacyWarehouseRouter'];
  marketing: (typeof import('./pharmacy-marketing'))['pharmacyMarketingRouter'];
};

function context(db: ScopedDb, userId: string, procurementLicensed = false) {
  return {
    db,
    entitlements: {
      organizationId: ORG,
      enabledModules: [
        'pharmacy-core',
        'pharmacy-counter',
        'pharmacy-inventory',
        'pharmacy-crm',
        ...(procurementLicensed ? ['pharmacy-procurement'] : []),
      ],
      modules: [],
      limits: {},
      seatLimit: 20,
      activeSeats: 8,
    },
    session: {
      expires: 'later',
      user: {
        id: userId,
        role: roleOf(userId),
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: ORG,
      },
    },
    organization: { id: ORG, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never;
}

type Callers = {
  sales: ReturnType<(typeof routers)['sales']['createCaller']>;
  inventory: ReturnType<(typeof routers)['inventory']['createCaller']>;
  medicine: ReturnType<(typeof routers)['medicine']['createCaller']>;
  warehouse: ReturnType<(typeof routers)['warehouse']['createCaller']>;
  marketing: ReturnType<(typeof routers)['marketing']['createCaller']>;
};

/** One request by `userId`, in ORG's tenant transaction. */
function as<T>(
  userId: string,
  run: (api: Callers) => Promise<T>,
  procurementLicensed = false
): Promise<T> {
  return withTenantDb(
    ORG,
    (db) => {
      const ctx = context(db, userId, procurementLicensed);
      return run({
        sales: routers.sales.createCaller(ctx),
        inventory: routers.inventory.createCaller(ctx),
        medicine: routers.medicine.createCaller(ctx),
        warehouse: routers.warehouse.createCaller(ctx),
        marketing: routers.marketing.createCaller(ctx),
      });
    },
    { userId, timeout: 60_000 }
  );
}

const fixture = {
  customerId: '',
  noticeId: '',
  medicineId: '',
  mainLotId: '',
  dhaLotId: '',
};

/** Rows the pack scans wrote at Main Branch, read as the tenant. */
function packScanCount() {
  return withTenantDb(ORG, (db) =>
    db.pharmacyPackAuthenticationScan.count({ where: { organizationId: ORG, branchId: MAIN } })
  );
}

describeIfDatabase('DEV-965 pharmacy permission gaps, against PostgreSQL with RLS', () => {
  beforeAll(async () => {
    const scoped = await import('@/lib/tenancy/scoped-db');
    withTenantDb = scoped.withTenantDb;
    withPlatformDb = scoped.withPlatformDb;
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    const { seedDepartments } = await import('@/lib/test-support/departments');
    const ledger = await import('@/lib/pharmacy/stock-ledger');
    const operations = await import('@/lib/pharmacy/inventory-operations');
    routers = {
      sales: (await import('./pharmacy-sales')).pharmacySalesRouter,
      inventory: (await import('./pharmacy-inventory')).pharmacyInventoryRouter,
      medicine: (await import('./pharmacy-medicine')).pharmacyMedicineRouter,
      warehouse: (await import('./pharmacy-warehouse')).pharmacyWarehouseRouter,
      marketing: (await import('./pharmacy-marketing')).pharmacyMarketingRouter,
    };
    await assertRlsEnforcingRole(withPlatformDb);
    await withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id`,
        [ORG, OTHER_ORG]
      )
    );
    const address = { addressLine: '1 Synthetic Road', city: 'Lahore', provinceCode: 'PB' };
    await withTenantDb(OTHER_ORG, (db) =>
      db.pharmacyBranch.create({ data: { id: FOREIGN, code: 'F', name: 'Foreign', ...address } })
    );
    await withTenantDb(ORG, async (db) => {
      await seedDepartments(db, [ORG], ['LEADERSHIP']);
      await db.pharmacyBranch.createMany({
        data: [
          { id: MAIN, code: 'MAIN', name: 'Main Branch', ...address },
          { id: DHA, code: 'DHA', name: 'DHA Branch', ...address },
        ],
      });
      const roles: Record<string, string[]> = {
        cashier: ['pharmacy:counter', 'pharmacy:orders'],
        pharmacist: ['pharmacy:dispense', 'pharmacy:catalogue-review', 'pharmacy:close'],
        inventory: ['pharmacy:inventory'],
        safety: ['pharmacy:safety'],
        finance: ['reports:operational', 'reports:financial'],
        owner: ['pharmacy:*', 'reports:operational', 'reports:financial', 'pharmacy:safety'],
      };
      const roleId: Record<string, string> = {};
      for (const [key, capabilities] of Object.entries(roles)) {
        roleId[key] = `perm_gaps_role_${key}_${suffix}`;
        await db.organizationRole.create({
          data: {
            id: roleId[key],
            key: `${key}-${suffix}`,
            name: key,
            permissions: {
              create: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
            },
          },
        });
      }
      const people: Array<[string, string]> = [
        [P.cashier, 'cashier'],
        [P.pharmacist, 'pharmacist'],
        [P.stock, 'inventory'],
        [P.safety, 'safety'],
        [P.finance, 'finance'],
        [P.granted, 'inventory'],
        [P.owner, 'owner'],
        [P.deniedOwner, 'owner'],
      ];
      for (const [id, key] of people) {
        await db.user.create({
          data: {
            id,
            name: id,
            email: `${id}@example.test`,
            department: 'LEADERSHIP',
            title: key,
            role: roleOf(id),
            organizationRoleId: roleId[key],
          },
        });
      }
      await db.userPermissionOverride.createMany({
        data: [
          {
            userId: P.deniedOwner,
            capability: 'admin:access',
            effect: 'DENY',
            reason: 'DEV-965 explicit deny',
          },
          {
            userId: P.granted,
            capability: 'admin:access',
            effect: 'ALLOW',
            reason: 'DEV-965 explicit grant',
          },
        ],
      });
      await db.pharmacyBranchAssignment.createMany({
        data: [P.cashier, P.pharmacist, P.stock, P.safety, P.finance, P.granted].map((userId) => ({
          userId,
          branchId: MAIN,
        })),
      });

      // A customer with a credit limit, for the counter snapshot.
      const patient = await db.pharmacyPatient.create({
        data: { organizationId: ORG, displayName: 'Synthetic customer' },
      });
      const customer = await db.pharmacyCustomer.create({
        data: {
          organizationId: ORG,
          patientId: patient.id,
          displayName: 'Synthetic customer',
          phoneLast4: '0000',
          creditLimitMinor: 500_000,
        },
      });
      fixture.customerId = customer.id;

      // One batch, expiring in ten days, received at both branches, then recalled.
      const medicine = await db.medicine.create({
        data: {
          organizationId: ORG,
          productName: `Synthetic tablet ${suffix}`,
          productFamily: 'PHARMACEUTICAL',
          presentations: { create: { organizationId: ORG, presentation: 'Tablet, 10 per strip' } },
        },
        include: { presentations: true },
      });
      fixture.medicineId = medicine.id;
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
      const expiresAt = new Date(Date.now() + 10 * 86_400_000);
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: ORG,
          medicineId: medicine.id,
          batchNumber: `B-${suffix}`,
          expiresAt,
          expiryPrecision: 'DAY',
        },
      });
      for (const [branchId, units] of [
        [MAIN, 20],
        [DHA, 30],
      ] as const) {
        const location = await db.pharmacyStockLocation.create({
          data: {
            organizationId: ORG,
            branchId,
            code: `S-${branchId}`,
            name: 'Store',
            kind: 'STORE',
          },
        });
        const { lot } = await ledger.receiveLot(
          db,
          { organizationId: ORG, branchId, actorId: P.owner },
          {
            manufacturingBatchId: batch.id,
            packLevelId: packLevel.id,
            stockLocationId: location.id,
            unitsPerPack: 10,
            supplierName: 'Distributor Ltd',
            supplierInvoiceRef: `INV-${branchId}`,
            unitCostMinor: 1_200,
            printedMrpMinor: 2_000,
            receivedExpiresAt: expiresAt,
            receivedExpiryPrecision: 'DAY',
            quantityUnits: units,
            idempotencyKey: `receipt-${branchId}`,
            receivedAt: new Date(),
          }
        );
        if (branchId === MAIN) fixture.mainLotId = lot.id;
        else fixture.dhaLotId = lot.id;
      }
      const notice = await operations.createRecall(
        db,
        { organizationId: ORG, actorId: P.owner },
        { batchId: batch.id, reference: `RC-${suffix}`, reason: 'Synthetic regulator notice' }
      );
      fixture.noticeId = notice.id;
    });
  }, 180_000);

  // ── 1. customerSnapshot ───────────────────────────────────────────────────
  describe('customerSnapshot', () => {
    const snapshot = (api: Callers, branchId = MAIN) =>
      api.sales.customerSnapshot({ branchId, customerId: fixture.customerId });

    it.each([
      ['stock clerk (inventory only)', P.stock],
      ['safety officer', P.safety],
      ['finance user', P.finance],
    ])('refuses a %s assigned to the branch', async (_who, userId) => {
      await expect(as(userId, snapshot)).rejects.toMatchObject(PERMISSION);
    });

    it.each([
      ['cashier', P.cashier],
      ['pharmacist', P.pharmacist],
    ])('shows the %s the customer at their branch', async (_who, userId) => {
      const result = (await as(userId, snapshot)) as {
        customer: { displayName: string; creditLimitMinor: number };
      };
      expect(result.customer).toMatchObject({
        displayName: 'Synthetic customer',
        creditLimitMinor: 500_000,
      });
    });

    it('still refuses the cashier at a branch they are not assigned to', async () => {
      await expect(as(P.cashier, (api) => snapshot(api, DHA))).rejects.toMatchObject(OUTSIDE);
    });

    it('lets the owner (ADMIN, Owner template) read it at any branch', async () => {
      await expect(as(P.owner, (api) => snapshot(api, DHA))).resolves.toMatchObject({
        customer: { displayName: 'Synthetic customer' },
      });
    });
  });

  // ── 5. authenticatePack ───────────────────────────────────────────────────
  describe('authenticatePack', () => {
    const scan = (api: Callers) => api.sales.authenticatePack({ branchId: MAIN, payload: '0100' });

    it('refuses a stock clerk assigned to the branch and writes no scan row', async () => {
      const before = await packScanCount();
      await expect(as(P.stock, scan)).rejects.toMatchObject(PERMISSION);
      await expect(as(P.finance, scan)).rejects.toMatchObject(PERMISSION);
      expect(await packScanCount()).toBe(before);
    });

    it.each([
      ['cashier', P.cashier],
      ['pharmacist', P.pharmacist],
    ])('records the %s’s scan as before', async (_who, userId) => {
      const before = await packScanCount();
      await expect(as(userId, scan)).resolves.toBeDefined();
      expect(await packScanCount()).toBe(before + 1);
    });
  });

  // ── 2. nearExpiryBoard ────────────────────────────────────────────────────
  describe('nearExpiryBoard', () => {
    type Bucket = { bucketDays: number; units: number; valueAtRiskMinor: number | null };
    const board = (userId: string) =>
      as(userId, (api) => api.inventory.nearExpiryBoard({ branchId: MAIN })) as Promise<Bucket[]>;

    it('gives a branch member without financial reports the units but no value at risk', async () => {
      for (const userId of [P.stock, P.cashier]) {
        const buckets = await board(userId);
        expect(buckets.map((bucket) => bucket.bucketDays)).toEqual([30, 60, 90, 180]);
        expect(buckets.every((bucket) => bucket.valueAtRiskMinor === null)).toBe(true);
        expect(buckets.find((bucket) => bucket.bucketDays === 30)!.units).toBe(20);
      }
    });

    it('still gives financial reports holders the PKR value at risk', async () => {
      for (const userId of [P.finance, P.owner]) {
        const buckets = await board(userId);
        // Main Branch holds 20 units of the batch expiring in ten days, at 1,200 paisa each.
        expect(buckets.find((bucket) => bucket.bucketDays === 30)).toMatchObject({
          units: 20,
          valueAtRiskMinor: 24_000,
        });
        expect(buckets.every((bucket) => typeof bucket.valueAtRiskMinor === 'number')).toBe(true);
      }
    });

    it('returns the same units with and without financial reports', async () => {
      const withCost = await board(P.finance);
      const withoutCost = await board(P.stock);
      expect(withoutCost.map((bucket) => bucket.units)).toEqual(
        withCost.map((bucket) => bucket.units)
      );
    });
  });

  // ── 3. recallTrace ────────────────────────────────────────────────────────
  describe('recallTrace', () => {
    type Row = { branchId: string; inventoryLotId: string; units: number };
    const trace = (userId: string) =>
      as(userId, (api) =>
        api.inventory.recallTrace({ recallNoticeId: fixture.noticeId })
      ) as Promise<Row[]>;

    it.each([
      ['stock clerk', P.stock],
      ['cashier', P.cashier],
      ['finance user', P.finance],
    ])('refuses a %s without the safety permission', async (_who, userId) => {
      await expect(trace(userId)).rejects.toMatchObject(PERMISSION);
    });

    it('shows a safety holder assigned to Main Branch only Main Branch', async () => {
      const rows = await trace(P.safety);
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.branchId))).toEqual(new Set([MAIN]));
      expect(rows.map((row) => row.inventoryLotId)).not.toContain(fixture.dhaLotId);
    });

    it('shows the head-office owner every branch', async () => {
      const rows = await trace(P.owner);
      expect(new Set(rows.map((row) => row.branchId))).toEqual(new Set([MAIN, DHA]));
      expect(rows.map((row) => row.inventoryLotId)).toEqual(
        expect.arrayContaining([fixture.mainLotId, fixture.dhaLotId])
      );
    });
  });

  describe('Warehouse safety scope', () => {
    it('admits assigned safety reviewers to the quality desk while keeping inventory and other premises protected', async () => {
      const orgMedicines = await withTenantDb(ORG, async (db) => {
        const medicines = [];
        for (const coldChain of [true, false]) {
          medicines.push(
            await db.medicine.create({
              data: {
                organizationId: ORG,
                productFamily: 'PHARMACEUTICAL',
                productName: `Desk lookup ${suffix} ${coldChain ? 'cold' : 'ambient'}`,
                coldChain,
                saleable: true,
              },
            })
          );
        }
        for (const [branchId, lotId] of [
          [MAIN, fixture.mainLotId],
          [DHA, fixture.dhaLotId],
        ]) {
          const balance = await db.pharmacyStockBalance.findFirstOrThrow({
            where: { organizationId: ORG, branchId, inventoryLotId: lotId },
          });
          await db.pharmacyWarehouseQualityIncident.create({
            data: {
              organizationId: ORG,
              branchId,
              inventoryLotId: lotId,
              stockLocationId: balance.stockLocationId,
              quantityUnits: 1,
              reason: 'Inspection required',
              sourceKey: `desk-${branchId}`,
              createdById: P.safety,
            },
          });
        }
        return medicines;
      });
      await expect(as(P.cashier, (api) => api.warehouse.sites())).rejects.toMatchObject(PERMISSION);
      const assigned = await as(P.safety, (api) => api.warehouse.sites());
      expect(assigned).toEqual([
        { id: MAIN, name: expect.any(String), warehouseEnabled: false, accessMode: 'quality' },
      ]);
      expect(
        (await as(P.stock, (api) => api.warehouse.sites())).map((row) => row.accessMode)
      ).toEqual(['inventory']);
      expect(
        (await as(P.owner, (api) => api.warehouse.sites())).map((row) => row.id).sort()
      ).toEqual([MAIN, DHA].sort());
      const incident = await as(P.safety, (api) => api.warehouse.quality({ branchId: MAIN }));
      expect(incident.map((row) => row.inventoryLotId)).toEqual([fixture.mainLotId]);
      expect(incident[0]).not.toHaveProperty('quarantineUnits');
      const search = { branchId: MAIN, query: `Desk lookup ${suffix}` };
      expect(
        (await as(P.safety, (api) => api.warehouse.searchMedicines(search))).map((row) => row.id)
      ).toEqual([orgMedicines[0]!.id]);
      expect(
        (await as(P.stock, (api) => api.warehouse.searchMedicines(search)))
          .map((row) => row.id)
          .sort()
      ).toEqual(orgMedicines.map((row) => row.id).sort());
      await expect(
        as(P.safety, (api) => api.warehouse.quality({ branchId: DHA }))
      ).rejects.toMatchObject(OUTSIDE);
      await expect(
        as(P.safety, (api) => api.warehouse.searchMedicines({ ...search, branchId: DHA }))
      ).rejects.toMatchObject(OUTSIDE);
      await expect(
        as(P.safety, (api) => api.warehouse.setup({ branchId: MAIN }))
      ).rejects.toMatchObject(PERMISSION);
      await expect(
        as(P.safety, (api) => api.warehouse.overview({ branchId: MAIN }))
      ).rejects.toMatchObject(PERMISSION);
      await expect(
        as(P.safety, (api) => api.warehouse.requestQueue({ branchId: MAIN }))
      ).rejects.toMatchObject(PERMISSION);
    });

    it('links warehouse staff to supplier returns only with licensed procurement and financial access', async () => {
      const setup = (api: Callers) => api.warehouse.setup({ branchId: MAIN });
      expect(await as(P.owner, setup)).toMatchObject({
        canPurchase: false,
        canSupplierReturn: false,
      });
      expect(await as(P.owner, setup, true)).toMatchObject({
        canPurchase: true,
        canSupplierReturn: true,
      });
      expect(await as(P.stock, setup, true)).toMatchObject({
        canPurchase: false,
        canSupplierReturn: false,
      });
      await withTenantDb(ORG, (db) =>
        db.userPermissionOverride.create({
          data: {
            userId: P.granted,
            capability: 'pharmacy:procurement',
            effect: 'ALLOW',
            reason: 'Warehouse procurement',
          },
        })
      );
      expect(await as(P.granted, setup, true)).toMatchObject({
        canPurchase: true,
        canSupplierReturn: false,
      });
    });

    it('keeps a labelled storage change pending until an authorized catalogue reviewer approves', async () => {
      const proposal = { branchId: MAIN, medicineId: fixture.medicineId, minimumC: 2, maximumC: 8 };
      const live = () =>
        withTenantDb(ORG, (db) =>
          db.medicine.findUniqueOrThrow({
            where: { id: fixture.medicineId },
            select: { minimumStorageTemperatureC: true, maximumStorageTemperatureC: true },
          })
        );
      await expect(
        as(P.stock, (api) => api.warehouse.proposeProductTemperatures(proposal))
      ).rejects.toMatchObject(PERMISSION);
      await expect(
        as(P.safety, (api) =>
          api.warehouse.proposeProductTemperatures({ ...proposal, branchId: DHA })
        )
      ).rejects.toMatchObject(OUTSIDE);
      await expect(
        as(P.safety, (api) =>
          api.warehouse.proposeProductTemperatures({ ...proposal, minimumC: 12 })
        )
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      const [pending, retry] = await Promise.all([
        as(P.safety, (api) => api.warehouse.proposeProductTemperatures(proposal)),
        as(P.safety, (api) => api.warehouse.proposeProductTemperatures(proposal)),
      ]);
      expect(retry.proposalId).toBe(pending.proposalId);
      const different = await as(P.safety, (api) =>
        api.warehouse.proposeProductTemperatures({ ...proposal, minimumC: 3 })
      );
      expect(different.proposalId).not.toBe(pending.proposalId);
      expect(pending.status).toBe('PENDING');
      expect(await live()).toEqual({
        minimumStorageTemperatureC: null,
        maximumStorageTemperatureC: null,
      });
      const approve = { editId: pending.proposalId, decision: 'APPROVE' as const };
      await expect(
        as(P.safety, (api) => api.medicine.decideCatalogueEdit(approve))
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await as(P.pharmacist, (api) => api.medicine.decideCatalogueEdit(approve));
      expect(await live()).toEqual({
        minimumStorageTemperatureC: 2,
        maximumStorageTemperatureC: 8,
      });
    });

    it('keeps a closed premises in the head-office recall and consults assigned premises for branch staff', async () => {
      const request = { branchId: MAIN, noticeId: fixture.noticeId };
      await withTenantDb(ORG, (db) =>
        db.pharmacyBranch.update({ where: { id: DHA }, data: { active: false } })
      );
      try {
        await expect(
          as(P.stock, (api) => api.warehouse.recallTrace(request))
        ).rejects.toMatchObject(PERMISSION);
        const local = await as(P.safety, (api) => api.warehouse.recallTrace(request));
        expect(new Set(local.bins.map((row) => row.branchId))).toEqual(new Set([MAIN]));
        const headOffice = await as(P.owner, (api) => api.warehouse.recallTrace(request));
        expect(new Set(headOffice.bins.map((row) => row.branchId))).toEqual(new Set([MAIN, DHA]));
        expect(headOffice.receipts.map((row) => row.inventoryLotId)).toContain(fixture.dhaLotId);
      } finally {
        await withTenantDb(ORG, (db) =>
          db.pharmacyBranch.update({ where: { id: DHA }, data: { active: true } })
        );
      }
    });
  });

  // ── 4. pharmacyMarketing ──────────────────────────────────────────────────
  describe('pharmacyMarketing', () => {
    const history = (userId: string) =>
      as(userId, (api) => api.marketing.history({ branchId: MAIN }));
    const branches = (userId: string) => as(userId, (api) => api.marketing.branches());

    it('refuses an ADMIN whose admin permission is explicitly denied', async () => {
      await expect(history(P.deniedOwner)).rejects.toMatchObject(OWNER_REQUIRED);
      await expect(branches(P.deniedOwner)).rejects.toMatchObject(OWNER_REQUIRED);
    });

    it('refuses branch staff without the admin permission', async () => {
      for (const userId of [P.cashier, P.stock, P.finance])
        await expect(history(userId)).rejects.toMatchObject(OWNER_REQUIRED);
    });

    it('admits a member explicitly granted the admin permission', async () => {
      await expect(history(P.granted)).resolves.toBeDefined();
      await expect(branches(P.granted)).resolves.toEqual([
        { id: DHA, name: 'DHA Branch' },
        { id: MAIN, name: 'Main Branch' },
      ]);
    });

    it('still admits the owner', async () => {
      await expect(history(P.owner)).resolves.toBeDefined();
    });
  });

  // ── 6. stockSignalDigest ──────────────────────────────────────────────────
  describe('stockSignalDigest', () => {
    const digest = (userId: string, ownerUserId: string) =>
      as(userId, (api) => api.inventory.stockSignalDigest({ branchId: MAIN, ownerUserId }));

    it("refuses a branch member reading a colleague's digest", async () => {
      await expect(digest(P.stock, P.cashier)).rejects.toMatchObject(DIGEST_REFUSAL);
      await expect(digest(P.cashier, P.owner)).rejects.toMatchObject(DIGEST_REFUSAL);
    });

    it('refuses an ADMIN whose admin permission is explicitly denied', async () => {
      // No branch assignment: the inventory ADMIN exception admits them to the branch
      // (pharmacy:* covers pharmacy:inventory); the digest rule then refuses.
      await expect(digest(P.deniedOwner, P.stock)).rejects.toMatchObject(DIGEST_REFUSAL);
    });

    it('lets each person read their own digest', async () => {
      for (const userId of [P.stock, P.cashier, P.deniedOwner])
        await expect(digest(userId, userId)).resolves.toBeDefined();
    });

    it("lets an administrator read another person's digest", async () => {
      await expect(digest(P.owner, P.stock)).resolves.toBeDefined();
      await expect(digest(P.granted, P.stock)).resolves.toBeDefined();
    });

    it('keeps the branch rule first: an unassigned branch is still outside scope', async () => {
      await expect(
        as(P.stock, (api) =>
          api.inventory.stockSignalDigest({ branchId: DHA, ownerUserId: P.stock })
        )
      ).rejects.toMatchObject(OUTSIDE);
    });
  });
});
