/**
 * DEV-960 — "One pharmacist per shift": a per-branch owner setting, off by default. With it on, the
 * pharmacist who rang up a prescription line may sign its check alone, with their own fresh PIN and
 * the declaration "I am the only pharmacist on duty now", even with other pharmacists on the
 * branch's staff list. Each such sign-off writes the same self-approved, PIN-verified audit entry
 * the database requires (20261118124600) plus the declared marker and the others on the list, and
 * the owner lists them. Only the owner, with a fresh PIN and the accepted statement, turns it on;
 * the database refuses any other writer and keeps every change. Controlled medicines stay refused,
 * a cashier still cannot sign, the branch rule (DEV-955) still applies, and with the setting off
 * nothing changes.
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
  org: `org_d960_${suffix}`,
  branch: `br_d960_${suffix}`,
  otherBranch: `br_d960_other_${suffix}`,
  /** The tenant owner: the system `owner` role, not on any branch's staff list. */
  owner: `user_d960_owner_${suffix}`,
  /** A manager: may not change the setting. */
  manager: `user_d960_manager_${suffix}`,
  /** The opt-in Pharmacist and cashier role, working alone at the branch. */
  solo: `user_d960_solo_${suffix}`,
  /** The shipped Cashier role: no dispensing right. */
  cashier: `user_d960_cashier_${suffix}`,
  /** A second pharmacist on this branch's staff list, working another shift. */
  colleague: `user_d960_colleague_${suffix}`,
  /** A pharmacist with a PIN, assigned only to another branch: never counts here. */
  elsewhere: `user_d960_elsewhere_${suffix}`,
};
const PINS = { solo: '4826', colleague: '7391', elsewhere: '5063', owner: '2580' };
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
    mayDeclareSolo: boolean;
    askName: string | null;
  }>;
  pin: { state: string; locked: boolean } | null;
};
type Declaration = { onlyPharmacistOnDuty: true; version: string };
type DispensingCaller = {
  counterSignStatus: (input: {
    branchId: string;
    saleId: string;
  }) => Promise<SignStatus & { declaration?: { version: string; text: string } }>;
  selfSignReview: (input: {
    reviewItemId: string;
    pin: string;
    declaration?: Declaration;
  }) => Promise<{ decisionId: string }>;
  decideReview: (input: { reviewItemId: string; kind: string }) => Promise<{ id: string }>;
};
type PolicyCaller = ReturnType<
  (typeof import('./pharmacy-rx-solo-shift'))['pharmacyRxSoloShiftRouter']['createCaller']
>;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let pharmacyDispensingRouter: typeof import('./pharmacy-dispensing').pharmacyDispensingRouter;
let pharmacyRxSoloShiftRouter: typeof import('./pharmacy-rx-solo-shift').pharmacyRxSoloShiftRouter;
let DECLARATION: Declaration;
let STATEMENT_VERSION: string;
let statementRecord: string;
let ownPin: typeof import('@/lib/pharmacy/own-pin');
let disconnect: (() => Promise<void>) | null = null;
let patientId: string;
let prescriptionLineId: string;
let controlledPrescriptionLineId: string;
type Medicine = { medicineId: string; presentationId: string; packLevelId: string };
let rx: Medicine;
let laterControlled: Medicine;

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

function settings<T>(userId: string, run: (api: PolicyCaller) => Promise<T>) {
  return withTenantDb(
    ids.org,
    (db) => run(pharmacyRxSoloShiftRouter.createCaller({ db, ...context(userId) } as never)),
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

/**
 * An audit entry written straight to the table that claims everything the marker needs, with
 * optional extra metadata (for example the declared solo marker). No signature names it.
 */
const forgedSelfApproval = (
  sale: { saleId: string; saleLineId: string; reviewItemId: string },
  extra: Record<string, unknown> = {}
) =>
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
          ...extra,
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
  const policyModule = await import('./pharmacy-rx-solo-shift');
  const words = await import('@/lib/pharmacy/rx-solo-shift');
  pharmacyRxSoloShiftRouter = policyModule.pharmacyRxSoloShiftRouter;
  DECLARATION = { onlyPharmacistOnDuty: true, version: words.RX_ON_DUTY_DECLARATION.version };
  STATEMENT_VERSION = words.RX_SOLO_SHIFT_DISCLAIMER.version;
  statementRecord = words.rxSoloShiftDisclaimerRecord();
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
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Shift Rx', 'Shift Rx', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
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
    const users: Array<{
      id: string;
      template: string;
      branchId: string | null;
      active?: boolean;
      system?: string;
    }> = [
      { id: ids.solo, template: 'pharmacist-cashier', branchId: ids.branch },
      { id: ids.cashier, template: 'cashier', branchId: ids.branch },
      { id: ids.colleague, template: 'pharmacist', branchId: ids.branch },
      { id: ids.elsewhere, template: 'pharmacist-cashier', branchId: ids.otherBranch },
      { id: ids.manager, template: 'manager', branchId: ids.branch, system: 'manager' },
      // The owner holds the system owner role and is on no branch's staff list.
      { id: ids.owner, template: 'owner', branchId: null, system: 'owner' },
    ];
    for (const user of users) {
      await tx.organizationRole.create({
        data: {
          id: `role_${user.id}`,
          key: user.system ?? `role_${user.id}`,
          isSystem: Boolean(user.system),
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
      if (user.branchId)
        await tx.pharmacyBranchAssignment.create({
          data: { userId: user.id, branchId: user.branchId, active: user.active ?? true },
        });
    }
    for (const [userId, pin] of [
      [ids.solo, PINS.solo],
      [ids.colleague, PINS.colleague],
      [ids.elsewhere, PINS.elsewhere],
      [ids.owner, PINS.owner],
    ] as const)
      await ownPin.saveOwnPin(tx, { organizationId: ids.org, userId, pin });
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
    const patient = await tx.pharmacyPatient.create({ data: { displayName: 'Synthetic patient' } });
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
          create: [rx, laterControlled].map((medicine, index) => ({
            lineNumber: index + 1,
            medicineId: medicine.medicineId,
            presentationId: medicine.presentationId,
            authorizedCanonicalUnits: 100_000,
            directions: 'One capsule three times a day',
          })),
        },
      },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });
    prescriptionLineId = prescription.lines[0]!.id;
    controlledPrescriptionLineId = prescription.lines[1]!.id;
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

const policyRows = () =>
  tenant((db) =>
    db.$queryRawUnsafe<
      Array<{
        enabled: boolean;
        version: number;
        disclaimerVersion: string | null;
        acknowledgement: string | null;
        actorUserId: string;
      }>
    >(
      `SELECT enabled, version, "disclaimerVersion", acknowledgement, "actorUserId"
         FROM pharmacy_rx_solo_shift_policy_changes
        WHERE "organizationId" = $1 AND "branchId" = $2
        ORDER BY version`,
      ids.org,
      ids.branch
    )
  );

/** A raw policy row as the restricted runtime role, signed in as `userId`. */
const rawPolicy = (userId: string, enabled: boolean, acknowledgement: string | null) =>
  withTenantDb(
    ids.org,
    (db) =>
      db.$executeRawUnsafe(
        `INSERT INTO pharmacy_rx_solo_shift_policy_changes
           ("organizationId", "branchId", enabled, "disclaimerVersion", acknowledgement, "actorUserId")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ids.org,
        ids.branch,
        enabled,
        acknowledgement ? 'raw@1' : null,
        acknowledgement,
        userId
      ),
    { userId }
  );

const turn = (enabled: boolean, pin = PINS.owner) =>
  settings(ids.owner, async (api) => {
    const overview = await api.overview();
    const branch = overview.branches.find((row) => row.branchId === ids.branch)!;
    return api.setPolicy({
      branchId: ids.branch,
      enabled,
      expectedVersion: branch.version,
      pin,
      ...(enabled ? { disclaimer: { accepted: true, version: STATEMENT_VERSION } } : {}),
    });
  });

const status = (sale: { saleId: string }, userId = ids.solo) =>
  dispensing(userId, (api) => api.counterSignStatus({ branchId: ids.branch, saleId: sale.saleId }));

const declaredSign = (sale: { reviewItemId: string }, pin = PINS.solo, userId = ids.solo) =>
  dispensing(userId, (api) =>
    api.selfSignReview({ reviewItemId: sale.reviewItemId, pin, declaration: DECLARATION })
  );

describeIfDatabase('one pharmacist per shift (DEV-960)', () => {
  it('is off by default: with a colleague on the list, nothing changes', async () => {
    expect(await policyRows()).toEqual([]);
    const sale = await ringUp();
    const read = await status(sale);
    expect(read).toEqual({
      lines: [
        expect.objectContaining({
          rungUpByYou: true,
          maySelfSign: false,
          mayDeclareSolo: false,
          askName: ids.colleague,
        }),
      ],
      pin: null,
    });
    // A declaration is refused exactly as a self-signature, before the PIN check.
    await expect(declaredSign(sale, WRONG_PIN)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining(`Ask ${ids.colleague} to sign it`),
    });
    expect(await soloCredential()).toMatchObject({ failedAttempts: 0, lockedUntil: null });
    await expect(declaredSign(sale)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await signDecisions(sale.reviewItemId)).toEqual([]);
    await expect(payInCash(ids.solo, sale)).rejects.toMatchObject(SIGN_REQUIRED);
    // The colleague still signs from the queue as before.
    await dispensing(ids.colleague, (api) =>
      api.decideReview({ reviewItemId: sale.reviewItemId, kind: 'SIGN' })
    );
    await expect(payInCash(ids.solo, sale)).resolves.toMatchObject({ settled: true });
  });

  it('lets only the owner change it, in the router and at the database', async () => {
    for (const userId of [ids.manager, ids.solo, ids.cashier])
      await expect(
        settings(userId, (api) =>
          api.setPolicy({
            branchId: ids.branch,
            enabled: true,
            expectedVersion: 0,
            pin: userId === ids.solo ? PINS.solo : PINS.owner,
            disclaimer: { accepted: true, version: STATEMENT_VERSION },
          })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(settings(ids.manager, (api) => api.declaredSignOffs())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await settings(ids.solo, (api) => api.overview())).toMatchObject({
      canManage: false,
      branches: [],
    });
    // The restricted runtime role, writing the row itself, is refused for anyone but the owner.
    await expect(rawPolicy(ids.manager, true, 'accepted')).rejects.toThrow(
      /RX_SOLO_SHIFT_POLICY_OWNER_REQUIRED/
    );
    await expect(rawPolicy(ids.solo, true, 'accepted')).rejects.toThrow(
      /RX_SOLO_SHIFT_POLICY_OWNER_REQUIRED/
    );
    // Even the owner needs the statement, and cannot write as somebody else.
    await expect(rawPolicy(ids.owner, true, null)).rejects.toThrow(
      /RX_SOLO_SHIFT_POLICY_DISCLAIMER_REQUIRED|pharmacy_rx_solo_shift_policy_changes_ack_check/
    );
    await expect(
      withTenantDb(
        ids.org,
        (db) =>
          db.$executeRawUnsafe(
            `INSERT INTO pharmacy_rx_solo_shift_policy_changes
               ("organizationId", "branchId", enabled, "disclaimerVersion", acknowledgement, "actorUserId")
             VALUES ($1, $2, true, 'raw@1', 'accepted', $3)`,
            ids.org,
            ids.branch,
            ids.owner
          ),
        { userId: ids.manager }
      )
    ).rejects.toThrow(/RX_SOLO_SHIFT_POLICY_ACTOR_REQUIRED/);
    // Turning off what is already off is no change.
    await expect(rawPolicy(ids.owner, false, null)).rejects.toThrow(
      /RX_SOLO_SHIFT_POLICY_UNCHANGED/
    );
    // A wrong owner PIN changes nothing.
    await expect(turn(true, WRONG_PIN)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await policyRows()).toEqual([]);
  });

  describe('with the setting on at the branch', () => {
    beforeAll(async () => {
      if (!databaseUrl) return;
      await expect(turn(true)).resolves.toEqual({ changed: true, enabled: true, version: 1 });
    });

    it('stores the owner, the statement version and its exact text, append-only', async () => {
      expect(await policyRows()).toEqual([
        {
          enabled: true,
          version: 1,
          disclaimerVersion: STATEMENT_VERSION,
          acknowledgement: statementRecord,
          actorUserId: ids.owner,
        },
      ]);
      await expect(
        tenant((db) =>
          db.$executeRawUnsafe(
            `UPDATE pharmacy_rx_solo_shift_policy_changes SET enabled = false WHERE "organizationId" = $1`,
            ids.org
          )
        )
      ).rejects.toThrow(/append-only/);
      await expect(
        tenant((db) =>
          db.$executeRawUnsafe(
            `DELETE FROM pharmacy_rx_solo_shift_policy_changes WHERE "organizationId" = $1`,
            ids.org
          )
        )
      ).rejects.toThrow(/append-only/);
      const history = await settings(ids.owner, (api) => api.history());
      expect(history).toMatchObject([
        { branchId: ids.branch, enabled: true, version: 1, actorName: ids.owner },
      ]);
    });

    it('lets the pharmacist on duty sign their own line with the declaration and a fresh PIN', async () => {
      const sale = await ringUp();
      const read = await status(sale);
      expect(read).toMatchObject({
        lines: [{ maySelfSign: false, mayDeclareSolo: true, askName: ids.colleague }],
        pin: { state: 'SET', locked: false },
        declaration: {
          version: DECLARATION.version,
          text: 'I am the only pharmacist on duty now.',
        },
      });
      // Still not without the declaration.
      await expect(
        dispensing(ids.solo, (api) =>
          api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: PINS.solo })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // A wrong PIN keeps its strike and signs nothing.
      await expect(declaredSign(sale, WRONG_PIN)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'That PIN was not accepted. Enter your own PIN to sign.',
      });
      expect(await soloCredential()).toMatchObject({ failedAttempts: 1 });
      expect(await signDecisions(sale.reviewItemId)).toEqual([]);
      await declaredSign(sale);
      const [decision] = await signDecisions(sale.reviewItemId);
      expect(decision).toMatchObject({ actorUserId: ids.solo, signedAt: expect.any(Date) });
      const audit = await tenant((db) =>
        db.auditLog.findUniqueOrThrow({ where: { id: decision!.selfApprovalAuditId! } })
      );
      expect(audit).toMatchObject({
        actorId: ids.solo,
        action: 'pharmacyDispensing.selfSignReview',
        outcome: 'SUCCESS',
        targetType: 'PharmacyPharmacistReviewItem',
        targetId: sale.reviewItemId,
        metadata: expect.objectContaining({
          selfApproved: true,
          pinVerified: true,
          reviewItemId: sale.reviewItemId,
          saleId: sale.saleId,
          saleLineId: sale.saleLineId,
          branchId: ids.branch,
          declaredSolo: true,
          soloBasis: 'DECLARED_ON_DUTY',
          declarationVersion: DECLARATION.version,
          soloShiftPolicyVersion: 1,
          otherEligibleSigners: [{ id: ids.colleague, name: ids.colleague }],
        }),
      });
      await expect(payInCash(ids.solo, sale)).resolves.toMatchObject({ settled: true });
      // The owner's list shows who, when, which sale and line, and who else was on the list.
      const list = await settings(ids.owner, (api) => api.declaredSignOffs());
      expect(list).toContainEqual(
        expect.objectContaining({
          auditId: audit.id,
          signerId: ids.solo,
          signerName: ids.solo,
          branchId: ids.branch,
          branchName: 'SOLO',
          saleId: sale.saleId,
          saleLineId: sale.saleLineId,
          productName: `Amoxicillin ${suffix}`,
          otherSigners: [{ id: ids.colleague, name: ids.colleague }],
        })
      );
      // An audit entry written straight to the table, with no signature naming it, is not listed.
      const forged = await forgedSelfApproval(sale);
      // Nor is one that carries the full declared marker, so it passes every filter on the audit
      // entry itself, but has no real signature behind it: neither on a review still waiting for
      // one, nor on this review, whose signature names its own, real entry.
      const declaredMarker = {
        policy: 'PHARMACY_RX_REVIEW_SOLO_SELF_SIGN_PIN',
        soloRule: true,
        approverId: ids.solo,
        initiatedById: ids.solo,
        branchId: ids.branch,
        declaredSolo: true,
        soloBasis: 'DECLARED_ON_DUTY',
        declaration: 'I am the only pharmacist on duty now.',
        declarationVersion: DECLARATION.version,
        soloShiftPolicyVersion: 1,
        otherEligibleSigners: [{ id: ids.colleague, name: ids.colleague }],
      };
      const unsigned = await ringUp();
      const forgedUnsigned = await forgedSelfApproval(unsigned, declaredMarker);
      const forgedOnSigned = await forgedSelfApproval(sale, declaredMarker);
      expect(await signDecisions(unsigned.reviewItemId)).toEqual([]);
      // The forged entries really do match the audit-side filters the list applies.
      const matching = await tenant((db) =>
        db.auditLog.findMany({
          where: {
            id: { in: [forgedUnsigned, forgedOnSigned] },
            action: 'pharmacyDispensing.selfSignReview',
            outcome: 'SUCCESS',
            targetType: 'PharmacyPharmacistReviewItem',
            AND: [
              { metadata: { path: ['declaredSolo'], equals: true } },
              { metadata: { path: ['policy'], equals: 'PHARMACY_RX_REVIEW_SOLO_SELF_SIGN_PIN' } },
              { metadata: { path: ['branchId'], equals: ids.branch } },
            ],
          },
          select: { id: true },
        })
      );
      expect(matching.map((row) => row.id).sort()).toEqual([forgedUnsigned, forgedOnSigned].sort());
      const again = await settings(ids.owner, (api) => api.declaredSignOffs());
      const listed = again.map((row) => row.auditId);
      expect(listed).toContain(audit.id);
      expect(listed).not.toContain(forged);
      expect(listed).not.toContain(forgedUnsigned);
      expect(listed).not.toContain(forgedOnSigned);
      // Filtered to the branch, the same holds.
      const byBranch = await settings(ids.owner, (api) =>
        api.declaredSignOffs({ branchId: ids.branch, limit: 200 })
      );
      expect(byBranch.map((row) => row.auditId)).toEqual([audit.id]);
    });

    it('refuses a cashier without the dispensing right', async () => {
      const sale = await ringUp();
      await expect(declaredSign(sale, PINS.solo, ids.cashier)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(await signDecisions(sale.reviewItemId)).toEqual([]);
    });

    it('keeps the branch rule: a pharmacist no longer assigned here cannot sign', async () => {
      const sale = await ringUp();
      const assignment = (active: boolean) =>
        tenant((db) =>
          db.pharmacyBranchAssignment.updateMany({
            where: { userId: ids.solo, branchId: ids.branch },
            data: { active },
          })
        );
      await assignment(false);
      try {
        await expect(declaredSign(sale)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      } finally {
        await assignment(true);
      }
      expect(await signDecisions(sale.reviewItemId)).toEqual([]);
    });

    it('never self-signs a controlled medicine', async () => {
      const sale = await ringUp(ids.solo, laterControlled, controlledPrescriptionLineId);
      await tenant((db) =>
        db.medicine.update({
          where: { id: laterControlled.medicineId },
          data: { controlled: true },
        })
      );
      try {
        expect((await status(sale)).lines).toMatchObject([
          { controlled: true, maySelfSign: false, mayDeclareSolo: false },
        ]);
        await expect(declaredSign(sale)).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message:
            'A controlled medicine needs an independent pharmacist’s signature. It cannot be self-signed.',
        });
        expect(await signDecisions(sale.reviewItemId)).toEqual([]);
      } finally {
        await tenant((db) =>
          db.medicine.update({
            where: { id: laterControlled.medicineId },
            data: { controlled: false },
          })
        );
      }
    });

    it('stops at once when the owner turns it off, and keeps the list', async () => {
      const sale = await ringUp();
      await expect(turn(false)).resolves.toEqual({ changed: true, enabled: false, version: 2 });
      expect((await status(sale)).lines).toMatchObject([
        { maySelfSign: false, mayDeclareSolo: false },
      ]);
      await expect(declaredSign(sale)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining(`Ask ${ids.colleague} to sign it`),
      });
      expect(await signDecisions(sale.reviewItemId)).toEqual([]);
      expect((await policyRows()).map((row) => [row.enabled, row.version])).toEqual([
        [true, 1],
        [false, 2],
      ]);
      expect((await settings(ids.owner, (api) => api.declaredSignOffs())).length).toBe(1);
    });
  });
});
