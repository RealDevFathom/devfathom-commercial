/**
 * DEV-955 — a prescription check (the RX-03 review of a counter sale line) is decided (signed,
 * overridden, verified or any other decision) only by a person who may act at that sale's branch:
 * an active assignment to the branch, or an organisation admin, the counter's branch rule. A
 * person on leave is not available: they may not decide a check and the solo rule does not count
 * them. The solo rule's "who else could sign here" (`otherRxReviewSigners`) is exactly the set
 * `decideReview` accepts, apart from the requester.
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
  org: `org_d955_${suffix}`,
  foreignOrg: `org_d955_foreign_${suffix}`,
  branch: `br_d955_${suffix}`,
  otherBranch: `br_d955_other_${suffix}`,
  foreignBranch: `br_d955_foreign_${suffix}`,
  /** Rings up the prescription sales; the requester of every review. */
  seller: `user_d955_seller_${suffix}`,
  /** A pharmacist assigned to this branch. */
  here: `user_d955_here_${suffix}`,
  /** A pharmacist assigned only to another branch of the same organisation. */
  elsewhere: `user_d955_elsewhere_${suffix}`,
  /** An organisation admin holding the dispensing right, assigned to no branch. */
  owner: `user_d955_owner_${suffix}`,
  admittedAdmin: `user_d955_admitted_${suffix}`,
  admin: `user_d955_admin_${suffix}`,
  /** A pharmacist assigned here, marked on leave. */
  onLeave: `user_d955_leave_${suffix}`,
  /** A pharmacist assigned here, made inactive. */
  inactive: `user_d955_inactive_${suffix}`,
  /** A custom role granting only the dispensing right, assigned here. */
  customAllow: `user_d955_custom_allow_${suffix}`,
  /** A custom role with the pharmacist's other grants and a dispensing DENY, assigned here. */
  customDeny: `user_d955_custom_deny_${suffix}`,
  /** The pharmacist role, assigned here, with a personal dispensing DENY override. */
  overrideDeny: `user_d955_override_deny_${suffix}`,
  /** The shipped Cashier role, assigned here: no dispensing right. */
  cashier: `user_d955_cashier_${suffix}`,
  /** A pharmacist assigned here whose staff profile (the PIN identity) is suspended. */
  suspendedProfile: `user_d955_suspended_${suffix}`,
  /** A pharmacist of another organisation. */
  foreign: `user_d955_foreign_${suffix}`,
};

type Status = 'ACTIVE' | 'ON_LEAVE' | 'INACTIVE';
type Person = {
  id: string;
  org: string;
  role: 'ADMIN' | 'EMPLOYEE';
  status: Status;
  grants: Array<[string, 'ALLOW' | 'DENY']>;
  branchId: string | null;
};
const template = (key: string): Array<[string, 'ALLOW' | 'DENY']> =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities.map((capability) => [
    capability,
    'ALLOW',
  ]);
const person = (id: string, over: Partial<Person> = {}): Person => ({
  id,
  org: ids.org,
  role: 'EMPLOYEE',
  status: 'ACTIVE',
  grants: template('pharmacist'),
  branchId: ids.branch,
  ...over,
});
const PEOPLE: Person[] = [
  person(ids.seller, { grants: template('pharmacist-cashier') }),
  person(ids.here),
  person(ids.elsewhere, { branchId: ids.otherBranch }),
  person(ids.admin, { role: 'ADMIN', grants: [['pharmacy:dispense', 'ALLOW']], branchId: null }),
  person(ids.owner, {
    role: 'ADMIN',
    grants: [...template('pharmacist'), ['*', 'ALLOW']],
    branchId: null,
  }),
  person(ids.admittedAdmin, { role: 'ADMIN', grants: [['pharmacy:dispense', 'ALLOW']] }),
  person(ids.onLeave, { status: 'ON_LEAVE' }),
  person(ids.inactive, { status: 'INACTIVE' }),
  person(ids.customAllow, { grants: [['pharmacy:dispense', 'ALLOW']] }),
  person(ids.customDeny, {
    grants: [
      ...template('pharmacist').filter(([capability]) => capability !== 'pharmacy:dispense'),
      ['pharmacy:dispense', 'DENY'],
    ],
  }),
  person(ids.overrideDeny),
  person(ids.cashier, { grants: template('cashier') }),
  person(ids.suspendedProfile),
  person(ids.foreign, { org: ids.foreignOrg, branchId: ids.foreignBranch }),
];
const byId = (id: string) => PEOPLE.find((entry) => entry.id === id)!;
/** Everyone the decision rule and the solo rule are compared over: all but the requester. */
const CANDIDATES = PEOPLE.filter((entry) => entry.id !== ids.seller);
/** Who may decide this branch's checks (and so who the solo rule counts). */
const ACCEPTED = [
  ids.here,
  ids.owner,
  ids.admittedAdmin,
  ids.customAllow,
  ids.suspendedProfile,
].sort();

const rulesId = pharmacyRegulatoryFixture(ids.branch).rules.id;
const businessDate = new Date(`${workspaceToday('UTC')}T00:00:00.000Z`);
const key = () => randomBytes(8).toString('hex');
const BRANCH_REFUSAL = {
  code: 'FORBIDDEN',
  message:
    'You are not assigned to this branch. Only a pharmacist assigned to this branch can sign or decide its prescription checks.',
};
const ON_LEAVE_REFUSAL = {
  code: 'FORBIDDEN',
  message: 'You are on leave or not active, so you cannot sign or decide a prescription check.',
};

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type SalesCaller = {
  create: (input: { branchId: string; deviceId: string }) => Promise<{ id: string }>;
  addLine: (input: Record<string, unknown>) => Promise<{ line: { id: string } }>;
  openDrawer: (input: Record<string, unknown>) => Promise<unknown>;
};
type Decision = { reviewItemId: string; kind: string; reason?: string };
type DispensingCaller = {
  decideReview: (input: Decision) => Promise<{ id: string }>;
  selfSignReview: (input: { reviewItemId: string; pin: string }) => Promise<unknown>;
};

type DispensingWrites = {
  enqueueReview: (input: { prescriptionLineId: string; saleLineId: string }) => Promise<unknown>;
  recordSubstitution: (input: Record<string, string>) => Promise<unknown>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let pharmacyDispensingRouter: typeof import('./pharmacy-dispensing').pharmacyDispensingRouter;
let otherRxReviewSigners: typeof import('@/lib/pharmacy/rx-review-self-sign').otherRxReviewSigners;
let disconnect: (() => Promise<void>) | null = null;
let patientId: string;
let prescriptionLineId: string;
let rx: { medicineId: string; presentationId: string; packLevelId: string };

/** The session the app would hold for this person (role and status as stored). */
function context(entry: Person) {
  return {
    entitlements: {
      organizationId: entry.org,
      enabledModules: ['pharmacy-counter', 'pharmacy-dispensing'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: entry.id,
        role: entry.role,
        department: 'LEADERSHIP',
        status: entry.status,
        organizationId: entry.org,
      },
    },
    organization: { id: entry.org, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
}

function dispensing<T>(userId: string, run: (api: DispensingCaller) => Promise<T>) {
  const entry = byId(userId);
  return withTenantDb(
    entry.org,
    (db) =>
      run(
        pharmacyDispensingRouter.createCaller({
          db,
          ...context(entry),
        } as never) as unknown as DispensingCaller
      ),
    { timeout: 60_000, userId }
  );
}

const decide = (userId: string, decision: Decision) =>
  dispensing(userId, (api) => api.decideReview(decision));

const tenant = <T>(run: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(ids.org, run, { userId: ids.seller });

/** A sale the seller rang up holding one prescription line; addLine queued its review. */
function ringUp() {
  return withTenantDb(
    ids.org,
    async (db) => {
      const api = pharmacySalesRouter.createCaller({
        db,
        ...context(byId(ids.seller)),
      } as never) as unknown as SalesCaller;
      const sale = await api.create({ branchId: ids.branch, deviceId: `device-${ids.seller}` });
      const added = await api.addLine({
        branchId: ids.branch,
        saleId: sale.id,
        ...rx,
        saleUnit: 'STRIP',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 10,
        prescription: { prescriptionLineId, patientId },
        idempotencyKey: key(),
      });
      const review = await db.pharmacyPharmacistReviewItem.findFirstOrThrow({
        where: { saleLineId: added.line.id },
      });
      return { saleId: sale.id, saleLineId: added.line.id, reviewItemId: review.id };
    },
    { timeout: 60_000, userId: ids.seller }
  );
}

const decisions = (reviewItemId: string) =>
  tenant((db) =>
    db.pharmacyPharmacistReviewDecision.findMany({
      where: { reviewItemId },
      orderBy: { createdAt: 'asc' },
      select: { actorUserId: true, kind: true, signedAt: true },
    })
  );

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const salesModule = await import('./pharmacy-sales');
  const dispensingModule = await import('./pharmacy-dispensing');
  const selfSign = await import('@/lib/pharmacy/rx-review-self-sign');
  const ledger = await import('@/lib/pharmacy/stock-ledger');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  pharmacySalesRouter = salesModule.pharmacySalesRouter;
  pharmacyDispensingRouter = dispensingModule.pharmacyDispensingRouter;
  otherRxReviewSigners = selfSign.otherRxReviewSigners;
  disconnect = () => db.$disconnect();
  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  const { rules, profile } = pharmacyRegulatoryFixture(ids.branch);
  await withPlatformDb((tx) => tx.jurisdictionRuleSet.create({ data: rules }));
  for (const org of [ids.org, ids.foreignOrg])
    await withPlatformDb((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, 'Branch Rx', 'Branch Rx', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
        org
      )
    );
  const branches: Array<[string, string, string]> = [
    [ids.org, ids.branch, 'HERE'],
    [ids.org, ids.otherBranch, 'OTHER'],
    [ids.foreignOrg, ids.foreignBranch, 'FOREIGN'],
  ];
  for (const org of [ids.org, ids.foreignOrg])
    await withTenantDb(org, async (tx) => {
      await seedDepartments(tx, [org], ['LEADERSHIP']);
      for (const [branchOrg, id, code] of branches)
        if (branchOrg === org)
          await tx.pharmacyBranch.create({
            data: {
              id,
              code,
              name: code,
              addressLine: '1 Road',
              city: 'Lahore',
              provinceCode: 'PB',
            },
          });
      for (const entry of PEOPLE.filter((candidate) => candidate.org === org)) {
        await tx.organizationRole.create({
          data: {
            id: `role_${entry.id}`,
            key: entry.id === ids.owner ? 'owner' : `role_${entry.id}`,
            isSystem: entry.id === ids.owner,
            name: entry.id,
            permissions: {
              create: entry.grants.map(([capability, effect]) => ({ capability, effect })),
            },
          },
        });
        await tx.user.create({
          data: {
            id: entry.id,
            name: entry.id,
            email: `${entry.id}@example.test`,
            department: 'LEADERSHIP',
            title: 'Counter',
            role: entry.role,
            status: entry.status,
            organizationRoleId: `role_${entry.id}`,
          },
        });
        if (entry.branchId)
          await tx.pharmacyBranchAssignment.create({
            data: { userId: entry.id, branchId: entry.branchId, active: true },
          });
      }
    });
  await tenant(async (tx) => {
    await tx.branchRegulatoryProfile.create({
      data: { ...profile, premises: { addressLine: '1 Road', city: 'Lahore' } },
    });
    await tx.userPermissionOverride.create({
      data: {
        userId: ids.overrideDeny,
        capability: 'pharmacy:dispense',
        effect: 'DENY',
        reason: 'DEV-955 test: dispensing withdrawn',
      },
    });
    await tx.restaurantStaffProfile.create({
      data: { userId: ids.suspendedProfile, displayName: 'Suspended', status: 'SUSPENDED' },
    });
    const location = await tx.pharmacyStockLocation.create({
      data: { branchId: ids.branch, code: `MAIN-${suffix}`, name: 'Main', kind: 'STORE' },
    });
    const medicine = await tx.medicine.create({
      data: {
        productName: `Amoxicillin ${suffix}`,
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
        versionGroupId: `strip-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const batch = await tx.pharmacyManufacturingBatch.create({
      data: {
        medicineId: medicine.id,
        batchNumber: `B-${suffix}`,
        expiresAt: new Date('2028-10-01T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    });
    await ledger.receiveLot(
      tx,
      { organizationId: ids.org, branchId: ids.branch, actorId: ids.seller },
      {
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: `INV-${suffix}`,
        unitCostMinor: 100,
        printedMrpMinor: 2000,
        receivedExpiresAt: new Date('2028-10-01T00:00:00.000Z'),
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 500,
        idempotencyKey: `receipt-${suffix}`,
        receivedAt: new Date('2026-02-01T00:00:00.000Z'),
      }
    );
    rx = {
      medicineId: medicine.id,
      presentationId: medicine.presentations[0]!.id,
      packLevelId: packLevel.id,
    };
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
        capturedByUserId: ids.seller,
        lines: {
          create: {
            lineNumber: 1,
            medicineId: rx.medicineId,
            presentationId: rx.presentationId,
            authorizedCanonicalUnits: 100_000,
            directions: 'One capsule three times a day',
          },
        },
      },
      include: { lines: true },
    });
    prescriptionLineId = prescription.lines[0]!.id;
  });
  await withTenantDb(
    ids.org,
    (db) =>
      (
        pharmacySalesRouter.createCaller({
          db,
          ...context(byId(ids.seller)),
        } as never) as unknown as SalesCaller
      ).openDrawer({
        branchId: ids.branch,
        deviceId: `device-${ids.seller}`,
        businessDate,
        openingFloatMinor: 0,
      }),
    { timeout: 60_000, userId: ids.seller }
  );
}, 120_000);

afterAll(async () => {
  if (databaseUrl) await retirePharmacyRegulatoryRules(withPlatformDb, [rulesId]);
  await disconnect?.();
});

describeIfDatabase('prescription checks are decided only at the signer’s branch (DEV-955)', () => {
  it('requires an active branch assignment for a non-owner administrator to decide a review', async () => {
    const sale = await ringUp();
    const decision = { reviewItemId: sale.reviewItemId, kind: 'VERIFY' };
    await expect(decide(ids.admin, decision)).rejects.toMatchObject(BRANCH_REFUSAL);
    expect(await decisions(sale.reviewItemId)).toEqual([]);
    const assignment = await tenant((db) =>
      db.pharmacyBranchAssignment.create({
        data: { userId: ids.admin, branchId: ids.branch, active: true },
      })
    );
    try {
      await expect(decide(ids.admin, decision)).resolves.toMatchObject({ id: expect.any(String) });
    } finally {
      await tenant((db) => db.pharmacyBranchAssignment.delete({ where: { id: assignment.id } }));
    }
  });

  it('refuses both sale-line writes when the sale belongs to another business', async () => {
    const sale = await ringUp();
    const api = (run: (dispense: DispensingWrites) => Promise<unknown>) =>
      dispensing(ids.foreign, (dispense) => run(dispense as unknown as DispensingWrites));
    const missing = { code: 'NOT_FOUND', message: 'This sale line was not found.' };
    await expect(
      api((caller) => caller.enqueueReview({ prescriptionLineId, saleLineId: sale.saleLineId }))
    ).rejects.toMatchObject(missing);
    await expect(
      api((caller) =>
        caller.recordSubstitution({
          prescriptionLineId,
          saleLineId: sale.saleLineId,
          prescribedPresentationId: rx.presentationId,
          suppliedPresentationId: rx.presentationId,
          equivalenceBasis: 'Same presentation',
          patientCommunication: 'Discussed with patient',
          jurisdictionRuleRef: 'RX-04',
        })
      )
    ).rejects.toMatchObject(missing);
  });

  it('refuses a pharmacist of another branch to sign, override or verify, and writes nothing', async () => {
    const sale = await ringUp();
    for (const decision of [
      { kind: 'SIGN' },
      { kind: 'OVERRIDE', reason: 'Dose confirmed with the prescriber.' },
      { kind: 'VERIFY' },
      { kind: 'REFUSE', reason: 'Not for this patient.' },
    ])
      await expect(
        decide(ids.elsewhere, { reviewItemId: sale.reviewItemId, ...decision })
      ).rejects.toMatchObject(BRANCH_REFUSAL);
    expect(await decisions(sale.reviewItemId)).toEqual([]);
  });

  it('refuses a pharmacist of another branch to queue a review or record a substitution here', async () => {
    const sale = await ringUp();
    const api = (run: (dispense: DispensingWrites) => Promise<unknown>) =>
      dispensing(ids.elsewhere, (dispense) => run(dispense as unknown as DispensingWrites));
    await expect(
      api((dispense) => dispense.enqueueReview({ prescriptionLineId, saleLineId: sale.saleLineId }))
    ).rejects.toMatchObject(BRANCH_REFUSAL);
    await expect(
      api((dispense) =>
        dispense.recordSubstitution({
          prescriptionLineId,
          saleLineId: sale.saleLineId,
          prescribedPresentationId: rx.presentationId,
          suppliedPresentationId: rx.presentationId,
          equivalenceBasis: 'Same ingredient, strength, form and route',
          patientCommunication: 'Explained to the patient, who agreed.',
          jurisdictionRuleRef: 'RX-04',
        })
      )
    ).rejects.toMatchObject(BRANCH_REFUSAL);
    expect(
      await tenant((db) =>
        db.pharmacySubstitutionRecord.count({ where: { saleLineId: sale.saleLineId } })
      )
    ).toBe(0);
  });

  it('accepts a pharmacist assigned to the branch, as before', async () => {
    const sale = await ringUp();
    await decide(ids.here, { reviewItemId: sale.reviewItemId, kind: 'VERIFY' });
    await decide(ids.here, {
      reviewItemId: sale.reviewItemId,
      kind: 'OVERRIDE',
      reason: 'Dose confirmed with the prescriber.',
    });
    await decide(ids.here, { reviewItemId: sale.reviewItemId, kind: 'SIGN' });
    expect(await decisions(sale.reviewItemId)).toEqual([
      { actorUserId: ids.here, kind: 'VERIFY', signedAt: null },
      { actorUserId: ids.here, kind: 'OVERRIDE', signedAt: null },
      { actorUserId: ids.here, kind: 'SIGN', signedAt: expect.any(Date) },
    ]);
  });

  it('allows an admitted administrator and a System Owner to sign, and refuses an unassigned administrator', async () => {
    const sale = await ringUp();
    const decision = { reviewItemId: sale.reviewItemId, kind: 'SIGN' };
    await expect(decide(ids.admin, decision)).rejects.toMatchObject(BRANCH_REFUSAL);
    expect(await decisions(sale.reviewItemId)).toEqual([]);
    for (const userId of [ids.admittedAdmin, ids.owner]) {
      const check = await ringUp();
      await decide(userId, { reviewItemId: check.reviewItemId, kind: 'SIGN' });
      expect(await decisions(check.reviewItemId)).toEqual([
        { actorUserId: userId, kind: 'SIGN', signedAt: expect.any(Date) },
      ]);
    }
  });

  it('refuses a pharmacist on leave, although assigned here', async () => {
    const sale = await ringUp();
    await expect(
      decide(ids.onLeave, { reviewItemId: sale.reviewItemId, kind: 'SIGN' })
    ).rejects.toMatchObject(ON_LEAVE_REFUSAL);
    expect(await decisions(sale.reviewItemId)).toEqual([]);
  });

  it('refuses another organisation, which cannot see the check at all', async () => {
    const sale = await ringUp();
    await expect(
      decide(ids.foreign, { reviewItemId: sale.reviewItemId, kind: 'SIGN' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await decisions(sale.reviewItemId)).toEqual([]);
  });

  it('refuses a self-signature by a requester on leave before any PIN is checked', async () => {
    const sale = await ringUp();
    await tenant((db) =>
      db.user.update({ where: { id: ids.seller }, data: { status: 'ON_LEAVE' } })
    );
    const seller = byId(ids.seller);
    seller.status = 'ON_LEAVE';
    try {
      await expect(
        dispensing(ids.seller, (api) =>
          api.selfSignReview({ reviewItemId: sale.reviewItemId, pin: '4826' })
        )
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message:
          'Only a pharmacist with the dispensing permission at this branch can sign this line.',
      });
    } finally {
      seller.status = 'ACTIVE';
      await tenant((db) =>
        db.user.update({ where: { id: ids.seller }, data: { status: 'ACTIVE' } })
      );
    }
    expect(await decisions(sale.reviewItemId)).toEqual([]);
  });

  it('counts admitted administrators and System Owners as signers and excludes an unassigned administrator', async () => {
    const sale = await ringUp();
    const counted = (
      await tenant((db) =>
        otherRxReviewSigners(db, {
          organizationId: ids.org,
          branchId: ids.branch,
          actorId: ids.seller,
        })
      )
    )
      .map((signer) => signer.id)
      .sort();
    const accepted: string[] = [];
    for (const candidate of CANDIDATES) {
      try {
        await decide(candidate.id, { reviewItemId: sale.reviewItemId, kind: 'COUNSEL' });
        accepted.push(candidate.id);
      } catch (error) {
        if (candidate.id === ids.admin) expect(error).toMatchObject(BRANCH_REFUSAL);
        expect(error).toMatchObject({
          code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND|UNAUTHORIZED)$/),
        });
      }
    }
    accepted.sort();
    expect(counted).toEqual(accepted);
    // Own branch, admitted administrator, system Owner, a custom role granting the right and a suspended staff profile (which
    // governs only the PIN) are in; another branch, on leave, inactive, a custom role or a personal
    // override denying the right, a cashier and another organisation are out.
    expect(accepted).toEqual(ACCEPTED);
    expect((await decisions(sale.reviewItemId)).map((row) => row.actorUserId).sort()).toEqual(
      ACCEPTED
    );
  });
});

describeIfDatabase('branch-scoped clinical reads (DEV-1010)', () => {
  it('checks admission and tenant ownership before opening a return queue', async () => {
    await tenant(async (db) => {
      const queue = (who: string, branchId: string) =>
        pharmacyDispensingRouter
          .createCaller({ db, ...context(byId(who)) } as never)
          .returnVerificationQueue({ branchId });
      const missing = { code: 'NOT_FOUND', message: 'This branch is unavailable.' };
      await expect(queue(ids.here, ids.branch)).resolves.toEqual([]);
      await expect(queue(ids.here, ids.otherBranch)).rejects.toMatchObject(missing);
      await expect(queue(ids.admin, ids.branch)).rejects.toMatchObject(missing);
      await db.user.update({
        where: { id: ids.admin },
        data: { organizationRoleId: `role_${ids.owner}` },
      });
      try {
        await expect(queue(ids.admin, ids.otherBranch)).resolves.toEqual([]);
        await expect(queue(ids.admin, ids.foreignBranch)).rejects.toMatchObject(missing);
      } finally {
        await db.user.update({
          where: { id: ids.admin },
          data: { organizationRoleId: `role_${ids.admin}` },
        });
      }
    });
  });

  it('counts an unsigned review only for report readers admitted to its branch', async () => {
    const { pharmacyReportsRouter } = await import('./pharmacy-reports');
    const report = (userId: string, branchId?: string) => {
      const entry = byId(userId);
      return withTenantDb(
        entry.org,
        async (db) => {
          const ctx = context(entry);
          ctx.entitlements.enabledModules.push('pharmacy-reports');
          const api = pharmacyReportsRouter.createCaller({ ...ctx, db } as never);
          return (await api.commandCentre({ branchId, from: '2026-11-01', to: '2026-11-01' }))
            .metrics.safetyQueue;
        },
        { userId }
      );
    };
    for (const id of [ids.here, ids.elsewhere, ids.admin, ids.foreign]) {
      await withTenantDb(byId(id).org, (db) =>
        db.userPermissionOverride.create({
          data: {
            userId: id,
            capability: 'reports:operational',
            effect: 'ALLOW',
            reason: 'Synthetic report reader',
          },
        })
      );
    }
    await ringUp();
    const count = await report(ids.here);
    expect(count).toBeGreaterThan(0);
    expect(await report(ids.elsewhere)).toBe(0);
    expect(await report(ids.admin)).toBeNull();
    await expect(report(ids.foreign, ids.branch)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'One or more branches are outside your report scope.',
    });
    await tenant((db) =>
      db.user.update({
        where: { id: ids.admin },
        data: { organizationRoleId: `role_${ids.owner}` },
      })
    );
    try {
      expect(await report(ids.admin, ids.branch)).toBe(count);
      expect(await report(ids.admin, ids.otherBranch)).toBe(0);
    } finally {
      await tenant((db) =>
        db.user.update({
          where: { id: ids.admin },
          data: { organizationRoleId: `role_${ids.admin}` },
        })
      );
    }
  });

  it('filters both reads by the reviewed sale line and protects the safety-only projection', async () => {
    const first = await ringUp();
    await tenant(async (db) => {
      // The same prescription at a second branch must not make both sales visible.
      const otherSale = await db.pharmacySale.create({
        data: { branchId: ids.otherBranch, createdByUserId: ids.elsewhere },
      });
      const otherLine = await db.pharmacySaleLine.create({
        data: {
          branchId: ids.otherBranch,
          saleId: otherSale.id,
          ...rx,
          saleUnit: 'STRIP',
          quantity: 1,
          canonicalUnitsPerSaleUnit: 10,
          canonicalUnits: 10,
          unitPriceMinor: 100,
          grossMinor: 100,
          proRataCeilingMinor: 100,
          unitCostMinor: 50,
          idempotencyKey: key(),
          prescriptionLineId,
          prescriptionPatientId: patientId,
        },
      });
      const other = await db.pharmacyPharmacistReviewItem.create({
        data: { prescriptionLineId, saleLineId: otherLine.id, requestedByUserId: ids.elsewhere },
      });
      const read = (userId: string) =>
        pharmacyDispensingRouter.createCaller({ db, ...context(byId(userId)) } as never);
      for (const [userId, expected, hidden] of [
        [ids.here, first.reviewItemId, other.id],
        [ids.elsewhere, other.id, first.reviewItemId],
      ] as const) {
        const api = read(userId);
        const queue = await api.reviewQueue();
        const workspace = await api.substitutionWorkspace();
        for (const rows of [queue.items, workspace.lines]) {
          expect(rows.map((row) => row.id)).toContain(expected);
          expect(rows.map((row) => row.id)).not.toContain(hidden);
        }
      }
      // Dispense ordinarily includes prescriptions; an explicit DENY takes precedence.
      const rxDenial = await db.userPermissionOverride.create({
        data: {
          userId: ids.customAllow,
          capability: 'pharmacy:prescriptions',
          effect: 'DENY',
          reason: 'Clinical reads fixture',
        },
      });
      const dispenseOnly = await read(ids.customAllow).reviewQueue();
      const restricted = dispenseOnly.items.find((row) => row.id === first.reviewItemId);
      expect(restricted?.line.prescription.patient).toEqual({ displayName: null });
      expect(JSON.stringify(dispenseOnly)).not.toContain(patientId);
      expect(JSON.stringify(dispenseOnly)).not.toContain(`paper:${suffix}`);

      await db.userPermissionOverride.delete({ where: { id: rxDenial.id } });
      await db.pharmacyBranchAssignment.create({
        data: { branchId: ids.otherBranch, userId: ids.here, active: false },
      });
      for (const rows of [
        (await read(ids.here).reviewQueue()).items,
        (await read(ids.here).substitutionWorkspace()).lines,
      ])
        expect(rows.map((row) => row.id)).not.toContain(other.id);

      const admin = read(ids.admin);
      expect((await admin.reviewQueue()).items).toEqual([]);
      expect((await admin.substitutionWorkspace()).lines).toEqual([]);

      // A role change is visible to the same caller. Keep the fixture's
      // dispensing-only admin for the separate decision tests.
      await db.user.update({
        where: { id: ids.admin },
        data: { organizationRoleId: `role_${ids.owner}` },
      });
      for (const rows of [
        (await admin.reviewQueue()).items,
        (await admin.substitutionWorkspace()).lines,
      ])
        expect(rows.map((row) => row.id)).toEqual(
          expect.arrayContaining([first.reviewItemId, other.id])
        );
      await db.user.update({
        where: { id: ids.admin },
        data: { organizationRoleId: `role_${ids.admin}` },
      });

      const safety = await db.userPermissionOverride.create({
        data: {
          userId: ids.cashier,
          capability: 'pharmacy:safety',
          effect: 'ALLOW',
          reason: 'Clinical reads fixture',
        },
      });
      const workspace = await read(ids.cashier).substitutionWorkspace();
      expect(workspace.canRecord).toBe(false);
      expect(workspace.canViewPatients).toBe(false);
      const item = workspace.lines.find((row) => row.id === first.reviewItemId);
      expect(item?.line).not.toHaveProperty('directions');
      expect(JSON.stringify(workspace)).not.toContain('One capsule three times a day');
      expect(item?.line.prescription).toEqual({ id: expect.any(String), patient: null });
      expect(JSON.stringify(workspace)).not.toContain(patientId);
      expect(JSON.stringify(workspace)).not.toContain(`paper:${suffix}`);
      expect(workspace.lines.map((row) => row.id)).not.toContain(other.id);
      await db.userPermissionOverride.delete({ where: { id: safety.id } });
    });
  });
});
