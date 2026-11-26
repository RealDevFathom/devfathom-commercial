/**
 * DEV-950 — a pharmacist working alone signs the RX-03 review of a prescription line they rang up,
 * under the solo rule: only with their own PIN re-entered at that moment, only when nobody else at
 * the branch with a working PIN holds the dispensing right, never for a controlled medicine, and
 * always with an audit entry marked self-approved that the database requires. Everything else the
 * database rule refused before is still refused.
 * Real routers and persisted roles, PostgreSQL as a NOSUPERUSER NOBYPASSRLS role.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { workspaceToday } from '@/lib/timezone';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import {
  pharmacyRegulatoryFixture,
  retirePharmacyRegulatoryRules,
} from '@/lib/test-support/pharmacy-regulatory';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomBytes(6).toString('hex');
const ids = {
  org: `org_d950_${suffix}`,
  branch: `br_d950_${suffix}`,
  otherBranch: `br_d950_other_${suffix}`,
  /** The opt-in Pharmacist and cashier role, working alone at the branch. */
  solo: `user_d950_solo_${suffix}`,
  /** The shipped Cashier role: no dispensing right. */
  cashier: `user_d950_cashier_${suffix}`,
  /**
   * A second pharmacist. Unassigned from this branch except in the second-person tests, where they
   * work here first without a PIN, then with one.
   */
  colleague: `user_d950_colleague_${suffix}`,
  /** A pharmacist with a PIN, assigned only to another branch: never counts here. */
  elsewhere: `user_d950_elsewhere_${suffix}`,
};
const PINS = { solo: '4826', colleague: '7391', elsewhere: '5063' };
const WRONG_PIN = '9157';
const templateGrants = (key: string): Array<[string, 'ALLOW' | 'DENY']> =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities.map((capability) => [
    capability,
    'ALLOW',
  ]);
const rulesId = pharmacyRegulatoryFixture(ids.branch).rules.id;
const businessDate = new Date(`${workspaceToday('UTC')}T00:00:00.000Z`);
const deviceFor = (userId: string) => `device-${userId}`;
const key = () => randomBytes(8).toString('hex');
const SIGN_REQUIRED = { code: 'BAD_REQUEST', message: 'A signed pharmacist decision is required.' };

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Cart = { status: string; totals: { netMinor: number; tenderedMinor: number } };
type SalesCaller = {
  create: (input: { branchId: string; deviceId: string }) => Promise<{ id: string }>;
  addLine: (input: Record<string, unknown>) => Promise<{ line: { id: string } }>;
  counterCart: (input: { branchId: string; saleId: string }) => Promise<Cart>;
  openDrawer: (input: Record<string, unknown>) => Promise<unknown>;
  tender: (input: Record<string, unknown>) => Promise<{ settled: boolean }>;
};
type SignStatus = {
  lines: Array<{
    reviewItemId: string;
    saleLineId: string;
    controlled: boolean;
    rungUpByYou: boolean;
    maySelfSign: boolean;
    askName: string | null;
  }>;
  pin: { state: string; locked: boolean } | null;
};
type DispensingCaller = {
  counterSignStatus: (input: { branchId: string; saleId: string }) => Promise<SignStatus>;
  selfSignReview: (input: {
    reviewItemId: string;
    pin: string;
    reason?: string;
  }) => Promise<{ decisionId: string }>;
  decideReview: (input: { reviewItemId: string; kind: string }) => Promise<{ id: string }>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let pharmacyDispensingRouter: typeof import('./pharmacy-dispensing').pharmacyDispensingRouter;
let ownPin: typeof import('@/lib/pharmacy/own-pin');
let disconnect: (() => Promise<void>) | null = null;
let patientId: string;
let prescriptionLineId: string;
let controlledPrescriptionLineId: string;
type Medicine = { medicineId: string; presentationId: string; packLevelId: string };
let rx: Medicine;
let laterControlled: Medicine;
let controlledAtSale: Medicine;
let checkedRxLineId: string;
let completedMedicine: Medicine;
let completedRxLineId: string;

function context(userId: string) {
  return {
    entitlements: {
      organizationId: ids.org,
      enabledModules: ['pharmacy-counter', 'pharmacy-dispensing'],
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
    audit: { detail: {} },
  };
}

function sales<T>(userId: string, run: (api: SalesCaller, db: ScopedDb) => Promise<T>) {
  return withTenantDb(
    ids.org,
    (db) =>
      run(
        pharmacySalesRouter.createCaller({
          db,
          ...context(userId),
        } as never) as unknown as SalesCaller,
        db
      ),
    { timeout: 60_000, userId }
  );
}

function dispensing<T>(userId: string, run: (api: DispensingCaller) => Promise<T>) {
  return withTenantDb(
    ids.org,
    (db) =>
      run(
        pharmacyDispensingRouter.createCaller({
          db,
          ...context(userId),
        } as never) as unknown as DispensingCaller
      ),
    { timeout: 60_000, userId }
  );
}

const tenant = <T>(run: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(ids.org, run, { userId: ids.solo });

/** A sale the user rang up holding one prescription line; addLine queued its review. */
async function ringUp(userId = ids.solo, medicine: Medicine = rx, rxLineId = prescriptionLineId) {
  return sales(userId, async (api, db) => {
    const sale = await api.create({ branchId: ids.branch, deviceId: deviceFor(userId) });
    const added = await api.addLine({
      branchId: ids.branch,
      saleId: sale.id,
      ...medicine,
      saleUnit: 'STRIP',
      quantity: 1,
      canonicalUnitsPerSaleUnit: 10,
      prescription: { prescriptionLineId: rxLineId, patientId },
      idempotencyKey: key(),
    });
    const review = await db.pharmacyPharmacistReviewItem.findFirstOrThrow({
      where: { saleLineId: added.line.id },
    });
    const bill = await api.counterCart({ branchId: ids.branch, saleId: sale.id });
    return {
      saleId: sale.id,
      saleLineId: added.line.id,
      reviewItemId: review.id,
      requestedByUserId: review.requestedByUserId,
      netMinor: bill.totals.netMinor,
    };
  });
}

const payInCash = (userId: string, sale: { saleId: string; netMinor: number }) =>
  sales(userId, (api) =>
    api.tender({
      branchId: ids.branch,
      saleId: sale.saleId,
      deviceId: deviceFor(userId),
      businessDate,
      type: 'CASH',
      amountMinor: sale.netMinor,
      cashReceivedMinor: sale.netMinor,
      idempotencyKey: key(),
    })
  );

const signDecisions = (reviewItemId: string) =>
  tenant((db) =>
    db.pharmacyPharmacistReviewDecision.findMany({
      where: { reviewItemId, kind: 'SIGN' },
      select: { actorUserId: true, signedAt: true, selfApprovalAuditId: true },
    })
  );

const soloCredential = () =>
  tenant((db) =>
    db.restaurantOperatorCredential.findFirstOrThrow({
      where: { type: 'PIN', revokedAt: null, staffProfile: { userId: ids.solo } },
      select: { failedAttempts: true, lockedUntil: true },
    })
  );

/** A raw SIGN insert as the restricted runtime role, outside every application check. */
const rawSign = (reviewItemId: string, actorUserId: string, marker: string | null) =>
  tenant((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO pharmacy_pharmacist_review_decisions
         (id, "organizationId", "reviewItemId", kind, "actorUserId", "signedAt", "selfApprovalAuditId")
       VALUES ($1, $2, $3, 'SIGN', $4, now(), $5)`,
      `raw_${key()}`,
      ids.org,
      reviewItemId,
      actorUserId,
      marker
    )
  );

/** An audit entry written straight to the table that claims everything the marker needs. */
const forgedSelfApproval = (sale: { saleId: string; saleLineId: string; reviewItemId: string }) =>
  tenant(async (db) => {
    const row = await db.auditLog.create({
      data: {
        organizationId: ids.org,
        actorId: ids.solo,
        source: 'TRPC',
        category: 'PHARMACY',
        operation: 'EXECUTE',
        action: 'pharmacyDispensing.selfSignReview',
        outcome: 'SUCCESS',
        targetType: 'PharmacyPharmacistReviewItem',
        targetId: sale.reviewItemId,
        metadata: {
          selfApproved: true,
          pinVerified: true,
          reviewItemId: sale.reviewItemId,
          saleId: sale.saleId,
          saleLineId: sale.saleLineId,
        },
      },
      select: { id: true },
    });
    return row.id;
  });

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const salesModule = await import('./pharmacy-sales');
  const dispensingModule = await import('./pharmacy-dispensing');
  const ledger = await import('@/lib/pharmacy/stock-ledger');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  ownPin = await import('@/lib/pharmacy/own-pin');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  pharmacySalesRouter = salesModule.pharmacySalesRouter;
  pharmacyDispensingRouter = dispensingModule.pharmacyDispensingRouter;
  disconnect = () => db.$disconnect();
  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  const { rules, profile } = pharmacyRegulatoryFixture(ids.branch);
  await withPlatformDb((tx) => tx.jurisdictionRuleSet.create({ data: rules }));
  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      // DEV-961: these approvals use PINs, which apply while the authenticator for approvals is off.
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt", "requireApprovalAuthenticator")
       VALUES ($1, $1, 'Solo Rx', 'Solo Rx', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now(), false)`,
      ids.org
    )
  );
  await withTenantDb(ids.org, async (tx) => {
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    for (const [id, code] of [
      [ids.branch, 'SOLO'],
      [ids.otherBranch, 'OTHER'],
    ] as const)
      await tx.pharmacyBranch.create({
        data: { id, code, name: code, addressLine: '1 Road', city: 'Lahore', provinceCode: 'PB' },
      });
    await tx.branchRegulatoryProfile.create({
      data: { ...profile, premises: { addressLine: '1 Road', city: 'Lahore' } },
    });
    const users: Array<{ id: string; template: string; branchId: string; active?: boolean }> = [
      { id: ids.solo, template: 'pharmacist-cashier', branchId: ids.branch },
      { id: ids.cashier, template: 'cashier', branchId: ids.branch },
      { id: ids.colleague, template: 'pharmacist', branchId: ids.branch, active: false },
      { id: ids.elsewhere, template: 'pharmacist-cashier', branchId: ids.otherBranch },
    ];
    for (const user of users) {
      await tx.organizationRole.create({
        data: {
          id: `role_${user.id}`,
          key: `role_${user.id}`,
          name: user.id,
          permissions: {
            create: templateGrants(user.template).map(([capability, effect]) => ({
              capability,
              effect,
            })),
          },
        },
      });
      await tx.user.create({
        data: {
          id: user.id,
          name: user.id,
          email: `${user.id}@example.test`,
          department: 'LEADERSHIP',
          title: 'Counter',
          organizationRoleId: `role_${user.id}`,
        },
      });
      await tx.pharmacyBranchAssignment.create({
        data: { userId: user.id, branchId: user.branchId, active: user.active ?? true },
      });
    }
    // The lone pharmacist and the pharmacist of another branch have their own PINs.
    for (const userId of [ids.solo, ids.elsewhere])
      await ownPin.saveOwnPin(tx, {
        organizationId: ids.org,
        userId,
        pin: userId === ids.solo ? PINS.solo : PINS.elsewhere,
      });
    const location = await tx.pharmacyStockLocation.create({
      data: { branchId: ids.branch, code: `MAIN-${suffix}`, name: 'Main', kind: 'STORE' },
    });
    const stocked = async (name: string): Promise<Medicine> => {
      const medicine = await tx.medicine.create({
        data: {
          productName: `${name} ${suffix}`,
          productFamily: 'PHARMACEUTICAL',
          rx: true,
          saleable: true,
          presentations: { create: { presentation: 'Capsule, 10 per strip' } },
        },
        include: { presentations: true },
      });
      const packLevel = await tx.packLevel.create({
        data: {
          presentationId: medicine.presentations[0]!.id,
          versionGroupId: `strip-${name}-${suffix}`,
          version: 1,
          level: 'STRIP',
          unitsPerParent: 10,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const batch = await tx.pharmacyManufacturingBatch.create({
        data: {
          medicineId: medicine.id,
          batchNumber: `B-${name}-${suffix}`,
          expiresAt: new Date('2028-10-01T00:00:00.000Z'),
          expiryPrecision: 'DAY',
        },
      });
      await ledger.receiveLot(
        tx,
        { organizationId: ids.org, branchId: ids.branch, actorId: ids.solo },
        {
          manufacturingBatchId: batch.id,
          packLevelId: packLevel.id,
          stockLocationId: location.id,
          unitsPerPack: 10,
          supplierName: 'Distributor Ltd',
          supplierInvoiceRef: `INV-${name}-${suffix}`,
          unitCostMinor: 100,
          printedMrpMinor: 2000,
          receivedExpiresAt: new Date('2028-10-01T00:00:00.000Z'),
          receivedExpiryPrecision: 'DAY',
          quantityUnits: 500,
          idempotencyKey: `receipt-${name}-${suffix}`,
          receivedAt: new Date('2026-02-01T00:00:00.000Z'),
        }
      );
      return {
        medicineId: medicine.id,
        presentationId: medicine.presentations[0]!.id,
        packLevelId: packLevel.id,
      };
    };
    rx = await stocked('Amoxicillin');
    laterControlled = await stocked('Tramadol');
    controlledAtSale = await stocked('Synthetic controlled test');
    completedMedicine = await stocked('Synthetic historical sale');
    await tx.medicine.update({
      where: { id: controlledAtSale.medicineId },
      data: { controlled: true },
    });
    const patient = await tx.pharmacyPatient.create({
      data: {
        displayName: 'Synthetic patient',
        address: '12 Synthetic Street',
        cnic: '0000000000000',
      },
    });
    await tx.patientConsent.create({
      data: {
        patientId: patient.id,
        purpose: 'DISPENSING',
        channel: 'IN_PERSON',
        granted: true,
        version: 1,
        recordedByUserId: ids.solo,
      },
    });

    patientId = patient.id;
    const prescriber = await tx.pharmacyPrescriber.create({
      data: { name: 'Dr Synthetic', registrationNumber: `PMDC-${suffix}` },
    });
    const prescription = await tx.prescription.create({
      data: {
        patientId,
        prescriberId: prescriber.id,
        sourceKind: 'PAPER_IMAGE',
        sourceFileRef: `paper:${suffix}`,
        validFrom: new Date(Date.now() - 30 * 86_400_000),
        validUntil: new Date(Date.now() + 365 * 86_400_000),
        authorizedRepeats: 100,
        capturedByUserId: ids.solo,
        lines: {
          create: [rx, laterControlled, controlledAtSale, completedMedicine].map(
            (medicine, index) => ({
              lineNumber: index + 1,
              medicineId: medicine.medicineId,
              presentationId: medicine.presentationId,
              authorizedCanonicalUnits: 100_000,
              directions: 'One capsule three times a day',
            })
          ),
        },
      },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });
    prescriptionLineId = prescription.lines[0]!.id;
    controlledPrescriptionLineId = prescription.lines[1]!.id;
    checkedRxLineId = prescription.lines[2]!.id;
    completedRxLineId = prescription.lines[3]!.id;
  });
  for (const userId of [ids.solo, ids.cashier])
    await sales(userId, (api) =>
      api.openDrawer({
        branchId: ids.branch,
        deviceId: deviceFor(userId),
        businessDate,
        openingFloatMinor: 0,
      })
    );
}, 120_000);

afterAll(async () => {
  if (databaseUrl) await retirePharmacyRegulatoryRules(withPlatformDb, [rulesId]);
  await disconnect?.();
});

describeIfDatabase('solo pharmacist self-signs a prescription review (DEV-950)', () => {
  it('requires a pharmacist for the controlled item on the same cashier bill with both switches OFF', async () => {
    const owner = 'owner_' + suffix;
    await tenant(async (db) => {
      const role = await db.organizationRole.create({
        data: { key: 'owner', name: 'Synthetic owner', isSystem: true },
      });
      await db.user.create({
        data: {
          id: owner,
          name: owner,
          email: owner + '@example.test',
          department: 'LEADERSHIP',
          title: 'Owner',
          organizationRoleId: role.id,
        },
      });
    });
    const { writePharmacistCheckPolicy } = await import('@/lib/pharmacy/pharmacist-check-policy');
    const { PHARMACIST_CHECK_DISCLAIMER } = await import('@/lib/pharmacy/pharmacist-check');
    const setPolicy = (enabled: boolean, expectedVersion: number) =>
      withTenantDb(
        ids.org,
        (db) =>
          writePharmacistCheckPolicy(
            db,
            { organizationId: ids.org, actorId: owner },
            {
              enabled,
              expectedVersion,
              disclaimer: { accepted: true, version: PHARMACIST_CHECK_DISCLAIMER.version },
            }
          ),
        { userId: owner }
      );
    const off = await setPolicy(false, 0);
    try {
      const sale = await sales(ids.cashier, (api) =>
        api.create({ branchId: ids.branch, deviceId: deviceFor(ids.cashier) })
      );
      const base = {
        branchId: ids.branch,
        saleId: sale.id,
        saleUnit: 'STRIP',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 10,
      };
      const ordinary = await sales(ids.cashier, (api) =>
        api.addLine({ ...base, ...rx, idempotencyKey: key() })
      );
      expect(ordinary.line.id).toBeTruthy();
      const controlled = { ...base, ...controlledAtSale, idempotencyKey: key() };
      await expect(sales(ids.cashier, (api) => api.addLine(controlled))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'A pharmacist must approve this controlled medicine.',
      });
      const own = await tenant((db) =>
        db.restaurantStaffProfile.findFirstOrThrow({ where: { userId: ids.solo } })
      );
      const approved = await sales(ids.solo, (api) =>
        api.addLine({
          ...controlled,
          controlledAuthorization: {
            selfApproval: true,
            staffProfileId: own.id,
            pin: PINS.solo,
            patientId,
            patientAddress: 'Synthetic address for approval',
            prescriptionLineId: checkedRxLineId,
            emergency: false,
            rxSerialWritten: true,
          },
        })
      );
      const reg = await tenant((db) =>
        db.pharmacyControlledRegisterEntry.findFirstOrThrow({
          where: { prescriptionLineId: checkedRxLineId },
        })
      );
      expect(reg).toMatchObject({
        recordedByUserId: ids.solo,
        witnessedByUserId: null,
        witnessStatement: 'No witness: dispensed by one pharmacist',
        patientId,
      });
      expect(approved.line.id).toBeTruthy();
    } finally {
      await setPolicy(true, off.policy.version);
    }
  });

  it('still refuses payment until the line is signed', async () => {
    const sale = await ringUp();
    expect(sale.requestedByUserId).toBe(ids.solo);
    await expect(payInCash(ids.solo, sale)).rejects.toMatchObject(SIGN_REQUIRED);
  });

  it('refuses a cashier without the dispensing right', async () => {
    const sale = await ringUp();
    await expect(
      dispensing(ids.cashier, (api) =>
        api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.solo })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      dispensing(ids.cashier, (api) =>
        api.counterSignStatus({ branchId: ids.branch, saleId: sale.saleId })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await signDecisions(sale.reviewItemId)).toEqual([]);
  });

  it('refuses every self-signature written without the audited marker, at the database', async () => {
    const sale = await ringUp();
    // No marker at all.
    await expect(rawSign(sale.reviewItemId, ids.solo, null)).rejects.toThrow(
      /requesting cashier cannot approve pharmacist-required line/
    );
    // A marker naming no audit entry.
    await expect(rawSign(sale.reviewItemId, ids.solo, `audit_${key()}`)).rejects.toThrow(
      /requesting cashier cannot approve pharmacist-required line/
    );
    // A marker naming an audit entry that does not record a self-approval of this line.
    const unrelated = await tenant((db) =>
      db.auditLog.create({
        data: {
          organizationId: ids.org,
          actorId: ids.solo,
          source: 'TRPC',
          category: 'PHARMACY',
          operation: 'EXECUTE',
          action: 'pharmacyDispensing.selfSignReview',
          outcome: 'SUCCESS',
          targetId: sale.reviewItemId,
          metadata: { selfApproved: false, reviewItemId: sale.reviewItemId },
        },
        select: { id: true },
      })
    );
    await expect(rawSign(sale.reviewItemId, ids.solo, unrelated.id)).rejects.toThrow(
      /requesting cashier cannot approve pharmacist-required line/
    );
    // The requester's other decisions stay refused, marker or not.
    await expect(
      tenant((db) =>
        db.pharmacyPharmacistReviewDecision.create({
          data: { reviewItemId: sale.reviewItemId, kind: 'VERIFY', actorUserId: ids.solo },
        })
      )
    ).rejects.toThrow(/requesting cashier cannot approve pharmacist-required line/);
    // The marker never rides on someone else's signature.
    await expect(rawSign(sale.reviewItemId, ids.colleague, unrelated.id)).rejects.toThrow(
      /self-approval marker is only for the requester/
    );
    expect(await signDecisions(sale.reviewItemId)).toEqual([]);
    await expect(payInCash(ids.solo, sale)).rejects.toMatchObject(SIGN_REQUIRED);
  });

  it('lets the lone pharmacist sign with their own fresh PIN, audited, then take payment', async () => {
    const sale = await ringUp();
    // The pharmacist of another branch, with a PIN, does not count at this one.
    const status = await dispensing(ids.solo, (api) =>
      api.counterSignStatus({ branchId: ids.branch, saleId: sale.saleId })
    );
    expect(status).toMatchObject({
      lines: [
        {
          reviewItemId: sale.reviewItemId,
          saleLineId: sale.saleLineId,
          rungUpByYou: true,
          maySelfSign: true,
          askName: null,
        },
      ],
      pin: { state: 'SET', locked: false },
    });
    const before = new Date(Date.now() - 1000);
    await dispensing(ids.solo, (api) =>
      api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.solo })
    );
    const [decision] = await signDecisions(sale.reviewItemId);
    expect(decision).toMatchObject({ actorUserId: ids.solo, signedAt: expect.any(Date) });
    expect(decision!.selfApprovalAuditId).toEqual(expect.any(String));
    const audit = await tenant((db) =>
      db.auditLog.findUniqueOrThrow({ where: { id: decision!.selfApprovalAuditId! } })
    );
    expect(audit).toMatchObject({
      organizationId: ids.org,
      actorId: ids.solo,
      action: 'pharmacyDispensing.selfSignReview',
      outcome: 'SUCCESS',
      targetId: sale.reviewItemId,
      metadata: expect.objectContaining({
        selfApproved: true,
        pinVerified: true,
        approverId: ids.solo,
        initiatedById: ids.solo,
        reviewItemId: sale.reviewItemId,
        saleId: sale.saleId,
        saleLineId: sale.saleLineId,
        branchId: ids.branch,
      }),
    });
    expect(audit.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    // Signed once only; the line is no longer waiting.
    await expect(
      dispensing(ids.solo, (api) =>
        api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.solo })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await dispensing(ids.solo, (api) =>
        api.counterSignStatus({ branchId: ids.branch, saleId: sale.saleId })
      )
    ).toEqual({ lines: [], pin: null });
    await expect(payInCash(ids.solo, sale)).resolves.toMatchObject({ settled: true });
    // One audit entry vouches for one signature only.
    const second = await ringUp();
    await expect(
      rawSign(second.reviewItemId, ids.solo, decision!.selfApprovalAuditId)
    ).rejects.toThrow(/requesting cashier cannot approve pharmacist-required line/);
  });

  it('refuses a wrong PIN, keeps its lockout strike and writes nothing', async () => {
    const sale = await ringUp();
    await expect(
      dispensing(ids.solo, (api) =>
        api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: WRONG_PIN })
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'That PIN was not accepted. Enter your own PIN to sign.',
    });
    expect(await soloCredential()).toMatchObject({ failedAttempts: 1, lockedUntil: null });
    expect(await signDecisions(sale.reviewItemId)).toEqual([]);
    const refusals = await tenant((db) =>
      db.auditLog.count({
        where: {
          actorId: ids.solo,
          action: 'pharmacyDispensing.selfSignReview',
          outcome: 'FAILURE',
          errorCode: 'RX_SELF_SIGN_PIN_REFUSED',
        },
      })
    );
    expect(refusals).toBeGreaterThanOrEqual(1);
    await expect(payInCash(ids.solo, sale)).rejects.toMatchObject(SIGN_REQUIRED);
    // The right PIN then signs, and clears the strike.
    await dispensing(ids.solo, (api) =>
      api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.solo })
    );
    expect(await soloCredential()).toMatchObject({ failedAttempts: 0 });
    await expect(payInCash(ids.solo, sale)).resolves.toMatchObject({ settled: true });
  });

  describe('when another pharmacist works at this branch', () => {
    const colleagueAt = (data: { assigned: boolean; status: 'ACTIVE' | 'INACTIVE' }) =>
      tenant(async (db) => {
        await db.pharmacyBranchAssignment.updateMany({
          where: { userId: ids.colleague, branchId: ids.branch },
          data: { active: data.assigned },
        });
        await db.user.update({ where: { id: ids.colleague }, data: { status: data.status } });
      });
    /** Self-signature refused before any PIN is checked, naming the colleague who signs. */
    async function expectColleagueNamed() {
      const sale = await ringUp();
      expect(
        await dispensing(ids.solo, (api) =>
          api.counterSignStatus({ branchId: ids.branch, saleId: sale.saleId })
        )
      ).toMatchObject({
        lines: [{ rungUpByYou: true, maySelfSign: false, askName: ids.colleague }],
        pin: null,
      });
      await expect(
        dispensing(ids.solo, (api) =>
          api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: WRONG_PIN })
        )
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining(`Ask ${ids.colleague} to sign it`),
      });
      // Refused before the PIN check: no strike was spent.
      expect(await soloCredential()).toMatchObject({ failedAttempts: 0, lockedUntil: null });
      await expect(
        dispensing(ids.solo, (api) =>
          api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.solo })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await signDecisions(sale.reviewItemId)).toEqual([]);
      return sale;
    }
    /** The solo rule applies again: the lone pharmacist signs with their PIN and is paid. */
    async function expectSelfSignAllowed() {
      const sale = await ringUp();
      expect(
        await dispensing(ids.solo, (api) =>
          api.counterSignStatus({ branchId: ids.branch, saleId: sale.saleId })
        )
      ).toMatchObject({ lines: [{ maySelfSign: true, askName: null }] });
      await dispensing(ids.solo, (api) =>
        api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.solo })
      );
      expect(await signDecisions(sale.reviewItemId)).toEqual([
        {
          actorUserId: ids.solo,
          signedAt: expect.any(Date),
          selfApprovalAuditId: expect.any(String),
        },
      ]);
      await expect(payInCash(ids.solo, sale)).resolves.toMatchObject({ settled: true });
    }

    beforeAll(async () => {
      if (databaseUrl) await colleagueAt({ assigned: true, status: 'ACTIVE' });
    });

    it('counts a second pharmacist without a PIN, who could sign from the queue', async () => {
      // No PIN at all: they still sign normally, so the seller may not sign alone.
      expect(
        await tenant((db) => ownPin.readOwnPinState(db, ids.org, ids.colleague))
      ).toMatchObject({ state: 'NOT_SET' });
      const sale = await expectColleagueNamed();
      await dispensing(ids.colleague, (api) =>
        api.decideReview({ reviewItemId: sale.reviewItemId, kind: 'SIGN' })
      );
      expect(await signDecisions(sale.reviewItemId)).toEqual([
        { actorUserId: ids.colleague, signedAt: expect.any(Date), selfApprovalAuditId: null },
      ]);
      await expect(payInCash(ids.solo, sale)).resolves.toMatchObject({ settled: true });
    });

    it('counts them with a PIN too, and they sign as before but never self-sign', async () => {
      await tenant((db) =>
        ownPin.saveOwnPin(db, {
          organizationId: ids.org,
          userId: ids.colleague,
          pin: PINS.colleague,
        })
      );
      await expectColleagueNamed();
      const sale = await ringUp();
      await expect(
        dispensing(ids.colleague, (api) =>
          api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.colleague })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await dispensing(ids.colleague, (api) =>
        api.decideReview({ reviewItemId: sale.reviewItemId, kind: 'SIGN' })
      );
      expect(await signDecisions(sale.reviewItemId)).toEqual([
        { actorUserId: ids.colleague, signedAt: expect.any(Date), selfApprovalAuditId: null },
      ]);
      await expect(payInCash(ids.solo, sale)).resolves.toMatchObject({ settled: true });
    });

    it('no longer counts them once they are made inactive', async () => {
      await colleagueAt({ assigned: true, status: 'INACTIVE' });
      await expectSelfSignAllowed();
    });

    it('no longer counts them once they are unassigned from this branch', async () => {
      await colleagueAt({ assigned: false, status: 'ACTIVE' });
      await expectSelfSignAllowed();
      // Assigned again, they count again.
      await colleagueAt({ assigned: true, status: 'ACTIVE' });
      await expectColleagueNamed();
    });

    afterAll(async () => {
      // Back to a pharmacist working alone at this branch.
      if (databaseUrl) await colleagueAt({ assigned: false, status: 'ACTIVE' });
    });
  });

  it('records a reclassified line once with a fresh pharmacist approval and a late-entry reason', async () => {
    const sale = await ringUp(ids.solo, laterControlled, controlledPrescriptionLineId);
    // The medicine is controlled by the time the review is signed.
    await tenant((db) =>
      db.medicine.update({ where: { id: laterControlled.medicineId }, data: { controlled: true } })
    );
    const status = await dispensing(ids.solo, (api) =>
      api.counterSignStatus({ branchId: ids.branch, saleId: sale.saleId })
    );
    expect(status.lines).toMatchObject([{ controlled: true, maySelfSign: false }]);
    await expect(
      dispensing(ids.solo, (api) =>
        api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.solo })
      )
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'A controlled medicine needs an independent pharmacist’s signature. It cannot be self-signed.',
    });
    // Even an audit entry claiming everything the marker needs does not admit it.
    const forged = await forgedSelfApproval(sale);
    await expect(rawSign(sale.reviewItemId, ids.solo, forged)).rejects.toThrow(
      /controlled medicine needs an independent pharmacist signature/
    );
    expect(await signDecisions(sale.reviewItemId)).toEqual([]);
    const reason = 'The classification was updated after this sale line was recorded.';
    const request = { reviewItemId: sale.reviewItemId, pin: PINS.solo, reason };
    await expect(
      dispensing(ids.cashier, (api) => api.selfSignReview(request))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      dispensing(ids.elsewhere, (api) => api.selfSignReview({ ...request, pin: PINS.elsewhere }))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      dispensing(ids.solo, (api) => api.selfSignReview({ ...request, pin: WRONG_PIN }))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await soloCredential()).toMatchObject({ failedAttempts: 1 });
    const original = await tenant((db) =>
      db.pharmacySaleLine.findUniqueOrThrow({ where: { id: sale.saleLineId } })
    );
    await expect(payInCash(ids.solo, sale)).rejects.toMatchObject({
      message: 'A pharmacist must approve this controlled medicine.',
    });
    const { readPharmacyOwnerCommandCentre } = await import('@/lib/pharmacy/reports');
    const attention = () =>
      tenant(
        async (db) =>
          (
            await readPharmacyOwnerCommandCentre(db, {
              branchIds: [ids.branch],
              from: workspaceToday('UTC'),
              to: workspaceToday('UTC'),
            })
          ).metrics.safetyQueue
      );
    const pendingCount = await attention();
    const signed = await dispensing(ids.solo, (api) => api.selfSignReview(request));
    expect(await dispensing(ids.solo, (api) => api.selfSignReview(request))).toMatchObject({
      decisionId: signed.decisionId,
    });
    const rows = await tenant((db) =>
      db.pharmacyControlledRegisterEntry.findMany({
        where: { prescriptionLineId: controlledPrescriptionLineId },
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lateSaleLineId: original.id,
      originalSaleAt: original.createdAt,
      lateEntryReason: reason,
      witnessedByUserId: null,
      recordedByUserId: ids.solo,
      patientId,
      quantityCanonicalUnits: original.canonicalUnits,
      signatureRef: signed.decisionId,
    });
    expect(rows[0]!.createdAt.getTime()).toBeGreaterThan(original.createdAt.getTime());
    // The signed review leaves the queue while the late register item stays on the owner's count.
    expect(await attention()).toBe(pendingCount);
    const decisions = await signDecisions(sale.reviewItemId);
    expect(decisions).toHaveLength(1);
    expect(
      await tenant((db) =>
        db.auditLog.findUniqueOrThrow({ where: { id: decisions[0]!.selfApprovalAuditId! } })
      )
    ).toMatchObject({
      actorId: ids.solo,
      targetId: sale.reviewItemId,
      metadata: expect.objectContaining({ reason, pinVerified: true, saleLineId: original.id }),
    });
    await expect(payInCash(ids.solo, sale)).resolves.toMatchObject({ settled: true });
  });

  it('records an already completed sale at its receipt time even when the branch requires two pharmacists on new sales', async () => {
    const sale = await ringUp(ids.solo, completedMedicine, completedRxLineId);
    await dispensing(ids.solo, (api) =>
      api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.solo })
    );
    await payInCash(ids.solo, sale);
    const receipt = await tenant((db) =>
      db.pharmacySale.findUniqueOrThrow({ where: { id: sale.saleId } })
    );
    expect(receipt.completedAt).toBeInstanceOf(Date);
    await tenant(async (db) => {
      await db.medicine.update({
        where: { id: completedMedicine.medicineId },
        data: { controlled: true },
      });
      await db.pharmacyBranch.update({
        where: { id: ids.branch },
        data: { requireSecondPharmacist: true },
      });
    });
    try {
      const status = await dispensing(ids.solo, (api) =>
        api.counterSignStatus({ branchId: ids.branch, saleId: sale.saleId })
      );
      expect(status.lines).toMatchObject([
        { reviewItemId: sale.reviewItemId, maySelfSign: false, mayRecordLate: true },
      ]);
      const request = {
        reviewItemId: sale.reviewItemId,
        pin: PINS.solo,
        reason: 'Classification updated after the receipt was issued.',
      };
      const [first, retry] = await Promise.all([
        dispensing(ids.solo, (api) => api.selfSignReview(request)),
        dispensing(ids.solo, (api) => api.selfSignReview(request)),
      ]);
      expect(retry.decisionId).toBe(first.decisionId);
      const rows = await tenant((db) =>
        db.pharmacyControlledRegisterEntry.findMany({ where: { lateSaleLineId: sale.saleLineId } })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        originalSaleAt: receipt.completedAt,
        recordedByUserId: ids.solo,
        lateEntryReason: request.reason,
        signatureRef: first.decisionId,
      });
      expect(
        await tenant((db) =>
          db.prescriptionFill.count({ where: { prescriptionLineId: completedRxLineId } })
        )
      ).toBe(1);
      expect(
        await tenant((db) => db.pharmacySale.findUniqueOrThrow({ where: { id: sale.saleId } }))
      ).toEqual(receipt);
    } finally {
      await tenant((db) =>
        db.pharmacyBranch.update({
          where: { id: ids.branch },
          data: { requireSecondPharmacist: false },
        })
      );
    }
  });
  it('refuses the right PIN once it is locked out (the shared lockout)', async () => {
    const sale = await ringUp();
    for (let attempt = 1; attempt < 5; attempt++)
      await expect(
        dispensing(ids.solo, (api) =>
          api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: WRONG_PIN })
        )
      ).rejects.toMatchObject({
        message: 'That PIN was not accepted. Enter your own PIN to sign.',
      });
    const LOCKED = {
      code: 'FORBIDDEN',
      message:
        'Your PIN is locked after too many wrong tries. Wait until the lock ends, then try again.',
    };
    await expect(
      dispensing(ids.solo, (api) =>
        api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: WRONG_PIN })
      )
    ).rejects.toMatchObject(LOCKED);
    expect((await soloCredential()).lockedUntil).toEqual(expect.any(Date));
    await expect(
      dispensing(ids.solo, (api) =>
        api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.solo })
      )
    ).rejects.toMatchObject(LOCKED);
    expect(
      await dispensing(ids.solo, (api) =>
        api.counterSignStatus({ branchId: ids.branch, saleId: sale.saleId })
      )
    ).toMatchObject({ pin: { state: 'SET', locked: true } });
    expect(await signDecisions(sale.reviewItemId)).toEqual([]);
    await expect(payInCash(ids.solo, sale)).rejects.toMatchObject(SIGN_REQUIRED);
  });
});
