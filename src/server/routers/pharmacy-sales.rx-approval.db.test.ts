/**
 * #341 — the counter's working path for a pharmacist to approve a prescription-only
 * (non-controlled) line: a recorded, append-only approval with a reason that clears the line's
 * POS-09 prescription block. It never widens the #518 gate: only the exact pharmacy:dispense
 * grant approves, and only that grant adds, pays for or completes the line.
 * Real router, persisted roles and overrides, PostgreSQL as a NOSUPERUSER NOBYPASSRLS role.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = databaseUrl ? describe : describe.skip;

// Request audit, router, authorization, stock, settlement and database are real.

const suffix = randomBytes(6).toString('hex');
const ids = {
  org: `org_r341_${suffix}`,
  branch: `br_r341_${suffix}`,
  otherBranch: `br_r341_other_${suffix}`,
  foreignOrg: `org_r341_foreign_${suffix}`,
  foreignBranch: `br_r341_foreign_${suffix}`,
  cashier: `user_r341_cashier_${suffix}`,
  pharmacist: `user_r341_pharm_${suffix}`,
  /** Role grants pharmacy:dispense; a user override DENYs it. */
  userDenied: `user_r341_udeny_${suffix}`,
};
const businessDate = new Date('2026-10-22T00:00:00.000Z');
const key = () => randomBytes(8).toString('hex');
const RX_DENIED = {
  code: 'FORBIDDEN',
  message:
    'Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission.',
};

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Medicine = { medicineId: string; presentationId: string; packLevelId: string };
type Cart = {
  status: string;
  lines: Array<{ saleLineId: string; rxApproved?: boolean }>;
  totals: { netMinor: number };
};
type AuditDetail = { category?: string; action?: string; targetId?: string; metadata?: unknown };
type SalesCaller = {
  create: (input: { branchId: string }) => Promise<{ id: string }>;
  addLine: (input: Record<string, unknown>) => Promise<{ line: { id: string } }>;
  counterCart: (input: { branchId: string; saleId: string }) => Promise<Cart>;
  openDrawer: (input: Record<string, unknown>) => Promise<unknown>;
  tender: (input: Record<string, unknown>) => Promise<{ settled: boolean }>;
  rxApprovalAccess: (input: { branchId: string }) => Promise<{ canApprove: boolean }>;
  approveRxLine: (input: {
    branchId: string;
    saleId: string;
    saleLineId: string;
    reason: string;
  }) => Promise<{ saleLineId: string; approvedAt: Date; replayed: boolean }>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;
let rx: Medicine;
let otc: Medicine;
let patientId: string;
let prescriptionLineId: string;

function act<T>(
  userId: string,
  run: (api: SalesCaller, db: ScopedDb) => Promise<T>,
  audit: { detail: AuditDetail } = { detail: {} }
) {
  return withTenantDb(
    ids.org,
    (db) =>
      run(
        pharmacySalesRouter.createCaller({
          db,
          entitlements: {
            organizationId: ids.org,
            enabledModules: ['pharmacy-counter'],
            modules: [],
            limits: {},
            seatLimit: 10,
            activeSeats: 1,
          },
          session: {
            expires: 'later',
            user: {
              id: userId,
              role: 'EMPLOYEE',
              department: 'LEADERSHIP',
              status: 'ACTIVE',
              organizationId: ids.org,
            },
          },
          organization: { id: ids.org, vertical: 'PHARMACY' },
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit,
        } as never) as unknown as SalesCaller,
        db
      ),
    { timeout: 60_000, userId }
  );
}

const line = (saleId: string, medicine: Medicine, extra: Record<string, unknown> = {}) => ({
  branchId: ids.branch,
  saleId,
  medicineId: medicine.medicineId,
  presentationId: medicine.presentationId,
  packLevelId: medicine.packLevelId,
  saleUnit: 'STRIP',
  quantity: 1,
  canonicalUnitsPerSaleUnit: 10,
  idempotencyKey: key(),
  ...extra,
});
/** A bill holding one line the pharmacist added. */
async function pharmacistBill(medicine: Medicine, extra: Record<string, unknown> = {}) {
  return act(ids.pharmacist, async (api) => {
    const sale = await api.create({ branchId: ids.branch });
    const added = await api.addLine(line(sale.id, medicine, extra));
    return { saleId: sale.id, saleLineId: added.line.id };
  });
}
const cartOf = (saleId: string) =>
  act(ids.pharmacist, (api) => api.counterCart({ branchId: ids.branch, saleId }));
const approve = (
  userId: string,
  bill: { saleId: string; saleLineId: string },
  reason = 'Prescription seen: Dr Khan, 22 Oct'
) =>
  act(userId, (api) =>
    api.approveRxLine({
      branchId: ids.branch,
      saleId: bill.saleId,
      saleLineId: bill.saleLineId,
      reason,
    })
  );
const approvalsFor = (saleLineId: string) =>
  withTenantDb(ids.org, (tx) =>
    tx.$queryRawUnsafe<Array<{ pharmacistUserId: string; reason: string }>>(
      `SELECT "pharmacistUserId", reason FROM pharmacy_rx_line_approvals
        WHERE "organizationId" = $1 AND "saleLineId" = $2`,
      ids.org,
      saleLineId
    )
  );
const payInCash = (userId: string, saleId: string, amountMinor: number) =>
  act(userId, (api) =>
    api.tender({
      branchId: ids.branch,
      saleId,
      deviceId: `device-${userId}`,
      businessDate,
      type: 'CASH',
      amountMinor,
      cashReceivedMinor: amountMinor,
      idempotencyKey: key(),
    })
  );

/** A boundary-only synthetic bill; fulfillment tests continue to use the actual stock path. */
async function boundaryBill(organizationId: string, branchId: string, controlled = false) {
  return withTenantDb(organizationId, async (db) => {
    await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branchId);
    const medicine = await db.medicine.create({
      data: {
        productName: `Boundary Rx ${key()}`,
        productFamily: 'PHARMACEUTICAL',
        rx: true,
        controlled,
        presentations: { create: { presentation: 'Tablet strip' } },
      },
      include: { presentations: true },
    });
    const presentationId = medicine.presentations[0]!.id;
    const pack = await db.packLevel.create({
      data: {
        presentationId,
        versionGroupId: `rx-boundary-${key()}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const sale = await db.pharmacySale.create({
      data: { organizationId, branchId, createdByUserId: `synthetic-${key()}` },
    });
    const saleLine = await db.pharmacySaleLine.create({
      data: {
        organizationId,
        branchId,
        saleId: sale.id,
        medicineId: medicine.id,
        presentationId,
        packLevelId: pack.id,
        saleUnit: 'STRIP',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 10,
        canonicalUnits: 10,
        unitPriceMinor: 2000,
        proRataCeilingMinor: 2000,
        unitCostMinor: 100,
        idempotencyKey: key(),
      },
    });
    return { saleId: sale.id, saleLineId: saleLine.id };
  });
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const sales = await import('./pharmacy-sales');
  const ledger = await import('@/lib/pharmacy/stock-ledger');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  pharmacySalesRouter = sales.pharmacySalesRouter;
  disconnect = () => db.$disconnect();
  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Rx approval', 'Rx approval', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.org
    )
  );

  async function medicineIn(tx: ScopedDb, name: string, rxOnly: boolean): Promise<Medicine> {
    const medicine = await tx.medicine.create({
      data: {
        productName: `${name} ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        rx: rxOnly,
        saleable: true,
        presentations: { create: { presentation: 'Capsule, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await tx.packLevel.create({
      data: {
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${medicine.id}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await tx.pharmacyStockLocation.create({
      data: { branchId: ids.branch, code: `MAIN-${medicine.id}`, name: 'Main', kind: 'STORE' },
    });
    const batch = await tx.pharmacyManufacturingBatch.create({
      data: {
        medicineId: medicine.id,
        batchNumber: `B-${medicine.id}`,
        expiresAt: new Date('2028-10-01T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    });
    await ledger.receiveLot(
      tx,
      { organizationId: ids.org, branchId: ids.branch, actorId: ids.pharmacist },
      {
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: `INV-${medicine.id}`,
        unitCostMinor: 100,
        printedMrpMinor: 2000,
        receivedExpiresAt: new Date('2028-10-01T00:00:00.000Z'),
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 300,
        idempotencyKey: `receipt-${medicine.id}`,
        receivedAt: new Date('2026-02-01T00:00:00.000Z'),
      }
    );
    return {
      medicineId: medicine.id,
      presentationId: medicine.presentations[0]!.id,
      packLevelId: packLevel.id,
    };
  }

  await withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt") VALUES ($1, $2, 'Foreign Rx synthetic', 'Foreign Rx synthetic', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.foreignOrg,
      `rx-foreign-${suffix}`
    )
  );
  await withTenantDb(ids.foreignOrg, (db) =>
    db.pharmacyBranch.create({
      data: {
        id: ids.foreignBranch,
        code: 'FOREIGN341',
        name: 'Foreign synthetic',
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    })
  );
  await withTenantDb(ids.org, (db) =>
    db.pharmacyBranch.create({
      data: {
        id: ids.otherBranch,
        code: 'OTHER341',
        name: 'Unassigned synthetic',
        addressLine: '2 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    })
  );
  await withTenantDb(ids.org, async (tx) => {
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    await tx.pharmacyBranch.create({
      data: {
        id: ids.branch,
        code: 'RX',
        name: 'Rx counter',
        addressLine: '1 Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    for (const [userId, capabilities, override] of [
      [ids.cashier, ['pharmacy:counter', 'pharmacy:orders'], null],
      [ids.pharmacist, ['pharmacy:dispense', 'pharmacy:counter'], null],
      [ids.userDenied, ['pharmacy:dispense', 'pharmacy:counter'], 'DENY'],
    ] as const) {
      await tx.organizationRole.create({
        data: {
          id: `role_${userId}`,
          key: `role_${userId}`,
          name: userId,
          permissions: {
            create: capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const })),
          },
        },
      });
      await tx.user.create({
        data: {
          id: userId,
          name: userId,
          email: `${userId}@example.test`,
          department: 'LEADERSHIP',
          title: 'Counter',
          organizationRoleId: `role_${userId}`,
        },
      });
      if (override)
        await tx.userPermissionOverride.create({
          data: {
            userId,
            capability: 'pharmacy:dispense',
            effect: override,
            reason: 'Set by the #341 test',
          },
        });
      await tx.pharmacyBranchAssignment.create({ data: { userId, branchId: ids.branch } });
    }
    rx = await medicineIn(tx, 'Amoxicillin 500mg', true);
    otc = await medicineIn(tx, 'Paracetamol 500mg', false);
    patientId = (await tx.pharmacyPatient.create({ data: { displayName: 'Ayesha Khan' } })).id;
    const prescriber = await tx.pharmacyPrescriber.create({
      data: { name: 'Dr Sana Malik', registrationNumber: `PMDC-${suffix}` },
    });
    const prescription = await tx.prescription.create({
      data: {
        organizationId: ids.org,
        patientId,
        prescriberId: prescriber.id,
        sourceKind: 'PAPER_IMAGE',
        sourceFileRef: `paper:${suffix}`,
        validFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        authorizedRepeats: 3,
        capturedByUserId: ids.pharmacist,
        lines: {
          create: {
            lineNumber: 1,
            medicineId: rx.medicineId,
            presentationId: rx.presentationId,
            authorizedCanonicalUnits: 40,
            directions: 'One capsule three times a day',
          },
        },
      },
      include: { lines: true },
    });
    prescriptionLineId = prescription.lines[0]!.id;
  });
  for (const userId of [ids.cashier, ids.pharmacist])
    await act(userId, (api) =>
      api.openDrawer({
        branchId: ids.branch,
        deviceId: `device-${userId}`,
        businessDate,
        openingFloatMinor: 0,
      })
    );
}, 120_000);

afterEach(async () => {
  if (databaseUrl) await (await import('@/server/audit')).flushAuditWritesForTest();
});
afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('pharmacist approval of prescription-only counter lines (#341)', () => {
  it('tells the counter who may approve: the exact dispense grant, DENY winning', async () => {
    const access = (userId: string) =>
      act(userId, (api) => api.rxApprovalAccess({ branchId: ids.branch }));
    await expect(access(ids.pharmacist)).resolves.toEqual({ canApprove: true });
    await expect(access(ids.cashier)).resolves.toEqual({ canApprove: false });
    // With the central precedence fix (6b120a50) the counter-access check already refuses a
    // user holding an explicit DENY on a receipt capability; either way they cannot approve.
    const denied = await access(ids.userDenied).then(
      (result) => result.canApprove,
      (error: { code?: string }) => error.code
    );
    expect([false, 'FORBIDDEN']).toContain(denied);
  });

  it('records a pharmacist approval once, shows it on the cart, and audits it', async () => {
    const bill = await pharmacistBill(rx);
    expect((await cartOf(bill.saleId)).lines).toEqual([
      expect.objectContaining({ saleLineId: bill.saleLineId, rxApproved: false }),
    ]);
    const audit = { detail: {} as AuditDetail };
    await expect(
      act(
        ids.pharmacist,
        (api) =>
          api.approveRxLine({
            branchId: ids.branch,
            saleId: bill.saleId,
            saleLineId: bill.saleLineId,
            reason: '  Prescription seen: Dr Khan, 22 Oct  ',
          }),
        audit
      )
    ).resolves.toMatchObject({ saleLineId: bill.saleLineId, replayed: false });
    expect(audit.detail).toMatchObject({
      category: 'PHARMACY_SAFETY',
      action: 'rx_line_approval',
      targetId: bill.saleLineId,
    });
    expect((await cartOf(bill.saleId)).lines).toEqual([
      expect.objectContaining({ saleLineId: bill.saleLineId, rxApproved: true }),
    ]);
    await expect(approve(ids.pharmacist, bill, 'Second click')).resolves.toMatchObject({
      replayed: true,
    });
    expect(await approvalsFor(bill.saleLineId)).toEqual([
      { pharmacistUserId: ids.pharmacist, reason: 'Prescription seen: Dr Khan, 22 Oct' },
    ]);
  });

  it('lets only a dispense holder approve, an explicit DENY winning, and writes nothing otherwise', async () => {
    const bill = await pharmacistBill(rx);
    await expect(approve(ids.cashier, bill)).rejects.toMatchObject(RX_DENIED);
    await expect(approve(ids.userDenied, bill)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await approvalsFor(bill.saleLineId)).toEqual([]);
    expect((await cartOf(bill.saleId)).lines[0]!.rxApproved).toBe(false);
  });

  it('never lets a cashier sell an approved line; the pharmacist completes it', async () => {
    const bill = await pharmacistBill(rx);
    await approve(ids.pharmacist, bill);
    const { totals } = await cartOf(bill.saleId);
    await expect(payInCash(ids.cashier, bill.saleId, totals.netMinor)).rejects.toMatchObject(
      RX_DENIED
    );
    await expect(
      act(ids.cashier, async (api) =>
        api.addLine(line((await api.create({ branchId: ids.branch })).id, rx))
      )
    ).rejects.toMatchObject(RX_DENIED);
    await expect(payInCash(ids.pharmacist, bill.saleId, totals.netMinor)).resolves.toMatchObject({
      settled: true,
    });
    expect((await cartOf(bill.saleId)).status).toBe('COMPLETED');
  });

  it('refuses an OTC line, a line from another bill, and a closed bill', async () => {
    const otcBill = await pharmacistBill(otc);
    await expect(approve(ids.pharmacist, otcBill)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message:
        'Only a prescription-only or restricted, non-controlled line takes a pharmacist approval.',
    });
    const rxBill = await pharmacistBill(rx);
    await expect(
      approve(ids.pharmacist, { saleId: otcBill.saleId, saleLineId: rxBill.saleLineId })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'That line is not on this bill at this branch.',
    });
    const { totals } = await cartOf(rxBill.saleId);
    await payInCash(ids.pharmacist, rxBill.saleId, totals.netMinor);
    await expect(approve(ids.pharmacist, rxBill)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This bill is no longer open, so its lines cannot be approved.',
    });
    expect(await approvalsFor(rxBill.saleLineId)).toEqual([]);
  });

  it('shows a validated pending prescription as approved without consuming an early fill', async () => {
    const bill = await pharmacistBill(rx, { prescription: { prescriptionLineId, patientId } });
    expect((await cartOf(bill.saleId)).lines).toEqual([
      expect.objectContaining({ saleLineId: bill.saleLineId, rxApproved: true }),
    ]);
    expect(await approvalsFor(bill.saleLineId)).toEqual([]);
  });

  it('refuses controlled drugs, blank reasons and foreign tenant/branch references without approval writes', async () => {
    const controlled = await boundaryBill(ids.org, ids.branch, true);
    await expect(approve(ids.pharmacist, controlled)).rejects.toMatchObject({
      message:
        'Only a prescription-only or restricted, non-controlled line takes a pharmacist approval.',
    });
    expect(await approvalsFor(controlled.saleLineId)).toEqual([]);
    const bill = await pharmacistBill(rx);
    await expect(approve(ids.pharmacist, bill, '  ')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await approvalsFor(bill.saleLineId)).toEqual([]);
    for (const [organizationId, branchId] of [
      [ids.org, ids.otherBranch],
      [ids.foreignOrg, ids.foreignBranch],
    ]) {
      const foreign = await boundaryBill(organizationId, branchId);
      await expect(
        act(ids.pharmacist, (api) =>
          api.approveRxLine({ branchId, ...foreign, reason: 'Must not cross this boundary' })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(approve(ids.pharmacist, foreign)).rejects.toMatchObject({
        message: 'That line is not on this bill at this branch.',
      });
      const rows = await withTenantDb(organizationId, (db) =>
        db.$queryRawUnsafe<Array<{ saleLineId: string }>>(
          'SELECT "saleLineId" FROM pharmacy_rx_line_approvals WHERE "saleLineId" = $1',
          foreign.saleLineId
        )
      );
      expect(rows).toEqual([]);
    }
  });

  it('serializes concurrent approval, preserves one append-only row and persists actual request audits', async () => {
    const bill = await pharmacistBill(rx);
    const results = await Promise.all([
      approve(ids.pharmacist, bill, 'Concurrent prescription check A'),
      approve(ids.pharmacist, bill, 'Concurrent prescription check B'),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.approvedAt).toEqual(results[1]!.approvedAt);
    const approvals = await approvalsFor(bill.saleLineId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ pharmacistUserId: ids.pharmacist });
    expect(['Concurrent prescription check A', 'Concurrent prescription check B']).toContain(
      approvals[0]!.reason
    );
    await (await import('@/server/audit')).flushAuditWritesForTest();
    const audits = await withTenantDb(ids.org, (db) =>
      db.auditLog.findMany({
        where: {
          action: 'rx_line_approval',
          targetId: bill.saleLineId,
          outcome: 'SUCCESS',
        },
        orderBy: { createdAt: 'asc' },
      })
    );
    expect(audits).toHaveLength(2);
    for (const audit of audits)
      expect(audit).toMatchObject({
        organizationId: ids.org,
        actorId: ids.pharmacist,
        source: 'TRPC',
        metadata: expect.objectContaining({ branchId: ids.branch, saleId: bill.saleId }),
      });
  });

  it('keeps approvals append-only', async () => {
    const bill = await pharmacistBill(rx);
    await approve(ids.pharmacist, bill);
    for (const statement of [
      `UPDATE pharmacy_rx_line_approvals SET reason = 'edited' WHERE "saleLineId" = $1`,
      `DELETE FROM pharmacy_rx_line_approvals WHERE "saleLineId" = $1`,
    ])
      await expect(
        withTenantDb(ids.org, (tx) => tx.$executeRawUnsafe(statement, bill.saleLineId))
      ).rejects.toThrow();
    expect(await approvalsFor(bill.saleLineId)).toHaveLength(1);
  });
});
