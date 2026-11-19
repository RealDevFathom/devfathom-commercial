/**
 * DEV-941 — refill reminders and refill cycles follow the branch rule prescription checks use
 * (DEV-955): a pharmacist sees and approves refills only at a branch they are assigned to, an
 * organisation admin at every branch of the organisation, and another organisation nowhere.
 *
 *   - Viewing: the prescriptions workspace offers only the caller's branches, refuses another
 *     branch plainly (and the refusal is logged), and never shows another branch's reminder
 *     record, not even inside the prescription list.
 *   - Approving: the PIN that approves a refill cycle must belong to a pharmacist assigned to
 *     the cycle's branch (or an organisation admin). Another branch's pharmacist is refused
 *     plainly, logged, and the cycle stays held. The screen offers only those pharmacists.
 *
 * Real routers, real ABAC and persisted roles, migrated PostgreSQL with FORCE row level
 * security, as the NOSUPERUSER NOBYPASSRLS runtime role. Only the audit-log writer is stubbed,
 * so the refusals it is handed can be checked. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

const suffix = randomBytes(5).toString('hex');
const DAY = 86_400_000;
const X = {
  org: `org_d941_${suffix}`,
  north: `br941_north_${suffix}`,
  south: `br941_south_${suffix}`,
};
const Y = { org: `org_d941_other_${suffix}`, branch: `br941_other_${suffix}` };

type Person = {
  id: string;
  org: string;
  role: 'ADMIN' | 'EMPLOYEE';
  grants: string[];
  branchId: string | null;
  /** The PIN on their staff profile, when they have one. */
  pin: string | null;
};
const PHARMACIST_GRANTS = ['pharmacy:dispense', 'pharmacy:prescriptions', 'pharmacy:orders'];
const P = {
  /** Counter staff at north who opens and presents the refill cycles: no dispensing right. */
  clerk: {
    id: `u941_clerk_${suffix}`,
    org: X.org,
    role: 'EMPLOYEE',
    grants: ['pharmacy:orders'],
    branchId: X.north,
    pin: null,
  },
  north: {
    id: `u941_north_${suffix}`,
    org: X.org,
    role: 'EMPLOYEE',
    grants: PHARMACIST_GRANTS,
    branchId: X.north,
    pin: '413926',
  },
  south: {
    id: `u941_south_${suffix}`,
    org: X.org,
    role: 'EMPLOYEE',
    grants: PHARMACIST_GRANTS,
    branchId: X.south,
    pin: '582047',
  },
  /** An organisation admin with the pharmacist's rights, assigned to no branch. */
  admin: {
    id: `u941_admin_${suffix}`,
    org: X.org,
    role: 'ADMIN',
    grants: PHARMACIST_GRANTS,
    branchId: null,
    pin: '690318',
  },
  /** A pharmacist of another organisation. */
  foreign: {
    id: `u941_foreign_${suffix}`,
    org: Y.org,
    role: 'EMPLOYEE',
    grants: PHARMACIST_GRANTS,
    branchId: Y.branch,
    pin: '735164',
  },
} satisfies Record<string, Person>;
const PEOPLE: Person[] = Object.values(P);
const profiles: Record<string, string> = {};

const VIEW_REFUSAL = {
  code: 'FORBIDDEN',
  message:
    'You are not assigned to this branch. Only a pharmacist assigned to this branch can see its refill reminders.',
};
const APPROVE_REFUSAL = {
  code: 'FORBIDDEN',
  message:
    'This pharmacist is not assigned to this branch. Only a pharmacist assigned to this branch can approve its refills.',
};
const PIN_REFUSAL = {
  code: 'FORBIDDEN',
  message: 'A prescription refill cycle needs a pharmacist to approve it with their PIN.',
};
const OUTSIDE_SCOPE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };

type Reminder = { id: string; branchId: string; prescriptionFillId: string };
type Workspace = {
  branches: { id: string }[];
  selectedBranchId: string | null;
  reminderCaptures: Reminder[];
  prescriptions: {
    lines: { fills: { id: string; reminderCapture: Reminder | null }[] }[];
  }[];
};
type PrescriptionsApi = {
  workspace: (input?: { branchId?: string }) => Promise<Workspace>;
  captureRefillReminder: (input: Record<string, string>) => Promise<Reminder>;
};
type Cycle = { id: string; status: string; approvedByUserId: string | null };
type OrderingApi = {
  createSubscription: (input: Record<string, unknown>) => Promise<{ id: string }>;
  openSubscriptionCycle: (input: { branchId: string; subscriptionId: string }) => Promise<Cycle>;
  approveSubscriptionCycle: (input: {
    branchId: string;
    cycleId: string;
    pharmacistPin: { staffProfileId: string; pin: string };
    prescriptionLineId: string;
  }) => Promise<Cycle>;
  subscriptionCycleApprovers: (input: {
    branchId: string;
  }) => Promise<{ id: string; name: string; self: boolean }[]>;
  refillProgram: (input: { branchId: string }) => Promise<unknown>;
};
type Api = { pharmacyPrescriptions: PrescriptionsApi; pharmacyOrdering: OrderingApi };
type Caller = { createCaller: (ctx: never) => Api };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let recordTrpcAudit: ReturnType<typeof vi.fn>;
let appRouter: Caller;
let disconnect: (() => Promise<void>) | null = null;
let fills: string[] = [];
let northReminder = '';
let southReminder = '';
let customerId = '';
let prescriptionLineId = '';
let rx: { medicineId: string; presentationId: string; packLevelId: string };

function context(db: ScopedDb, entry: Person) {
  return {
    db,
    entitlements: {
      organizationId: entry.org,
      enabledModules: ['pharmacy-counter', 'pharmacy-dispensing'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 4,
    },
    session: {
      expires: 'later',
      user: {
        id: entry.id,
        role: entry.role,
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: entry.org,
      },
    },
    organization: { id: entry.org, vertical: 'PHARMACY', timezone: 'Asia/Karachi' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
}

/** One request, in its own tenant transaction, the way the tRPC route runs it. */
function as<T>(entry: Person, run: (api: Api) => Promise<T>) {
  return withTenantDb(entry.org, (db) => run(appRouter.createCaller(context(db, entry) as never)), {
    userId: entry.id,
    timeout: 60_000,
  });
}

const tenant = <T>(run: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(X.org, run, { userId: P.admin.id, timeout: 60_000 });

async function cycleRow(id: string) {
  return tenant(async (db) => {
    await db.$queryRaw`SELECT set_config('app.current_branch_id', ${X.north}, true)`;
    return db.pharmacyRefillSubscriptionCycle.findFirstOrThrow({
      where: { id },
      select: { status: true, approvedByUserId: true, approvedAt: true },
    });
  });
}

/** A fresh prescription-only cycle at north, opened by the north counter clerk. */
async function openCycle() {
  const subscription = await as(P.clerk, (api) =>
    api.pharmacyOrdering.createSubscription({
      branchId: X.north,
      customerId,
      ...rx,
      packsPerCycle: 1,
      cycleDays: 30,
      reminderLeadDays: 3,
      fulfillment: 'COLLECT',
      paymentMode: 'PREPAY',
      firstDueAt: new Date(Date.now() + 2 * DAY),
    })
  );
  const cycle = await as(P.clerk, (api) =>
    api.pharmacyOrdering.openSubscriptionCycle({
      branchId: X.north,
      subscriptionId: subscription.id,
    })
  );
  expect(cycle.status).toBe('AWAITING_PHARMACIST');
  return cycle.id;
}

const approveWith = (approver: Person, cycleId: string, actor: Person = P.clerk) =>
  as(actor, (api) =>
    api.pharmacyOrdering.approveSubscriptionCycle({
      branchId: X.north,
      cycleId,
      pharmacistPin: { staffProfileId: profiles[approver.id]!, pin: approver.pin! },
      prescriptionLineId,
    })
  );

const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message })
  );

type AuditCall = {
  path: string;
  outcome: string;
  error?: { message?: string };
  ctx: { audit: { detail: unknown } };
};

/** The audit entries the router handed over for this procedure, refusals only. */
function refusalEntries(path: string) {
  return recordTrpcAudit.mock.calls
    .map(([entry]) => entry as AuditCall)
    .filter((entry) => entry.path === path && entry.outcome === 'FAILURE');
}
const loggedRefusals = (path: string) => refusalEntries(path).map((entry) => entry.error?.message);

const allFills = (workspace: Workspace) =>
  workspace.prescriptions.flatMap((prescription) =>
    prescription.lines.flatMap((line) => line.fills)
  );

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { router } = await import('../trpc');
  const { pharmacyPrescriptionsRouter } = await import('./pharmacy-prescriptions');
  const { pharmacyOrderingRouter } = await import('./pharmacy-ordering');
  const audit = await import('@/server/audit');
  const ledger = await import('@/lib/pharmacy/stock-ledger');
  const credentials = await import('@/lib/restaurant/operator-credentials');
  const { seedDepartments, ensurePlatformModule } = await import('@/lib/test-support/departments');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  recordTrpcAudit = audit.recordTrpcAudit as unknown as ReturnType<typeof vi.fn>;
  appRouter = router({
    pharmacyPrescriptions: pharmacyPrescriptionsRouter,
    pharmacyOrdering: pharmacyOrderingRouter,
  }) as unknown as Caller;
  disconnect = () => db.$disconnect();
  // With SUPERUSER or BYPASSRLS this suite would pass for the wrong reason.
  await assertRlsEnforcingRole(withPlatformDb);

  await withPlatformDb(async (tx) => {
    await tx.organization.createMany({
      data: [X.org, Y.org].map((id) => ({
        id,
        slug: id,
        legalName: id,
        displayName: id,
        status: 'ACTIVE' as const,
        vertical: 'PHARMACY' as const,
        timezone: 'Asia/Karachi',
      })),
    });
    const counter = await ensurePlatformModule(tx as never, 'pharmacy-counter', {
      name: 'Pharmacy counter',
      category: 'Pharmacy',
    });
    await tx.organizationModule.createMany({
      data: [X.org, Y.org].map((organizationId) => ({ organizationId, moduleId: counter.id })),
      skipDuplicates: true,
    });
  });
  const address = { addressLine: '1 Mall Road', city: 'Lahore', provinceCode: 'PB' };
  const branches: Array<[string, string, string]> = [
    [X.org, X.north, 'NOR'],
    [X.org, X.south, 'SOU'],
    [Y.org, Y.branch, 'OTH'],
  ];
  for (const org of [X.org, Y.org])
    await withTenantDb(
      org,
      async (tx) => {
        await seedDepartments(tx, [org], ['LEADERSHIP']);
        for (const [branchOrg, id, code] of branches)
          if (branchOrg === org)
            await tx.pharmacyBranch.create({
              data: { id, code: `${code}-${suffix}`, name: `DEV-941 ${code}`, ...address },
            });
        for (const entry of PEOPLE.filter((candidate) => candidate.org === org)) {
          await tx.organizationRole.create({
            data: {
              id: `role_${entry.id}`,
              key: `role_${entry.id}`,
              name: entry.id,
              permissions: {
                create: entry.grants.map((capability) => ({
                  capability,
                  effect: 'ALLOW' as const,
                })),
              },
            },
          });
          await tx.user.create({
            data: {
              id: entry.id,
              name: entry.id,
              email: `${entry.id}@example.test`,
              department: 'LEADERSHIP',
              title: 'Pharmacy staff',
              role: entry.role,
              status: 'ACTIVE',
              organizationRoleId: `role_${entry.id}`,
            },
          });
          if (entry.branchId)
            await tx.pharmacyBranchAssignment.create({
              data: { userId: entry.id, branchId: entry.branchId, active: true },
            });
          if (entry.pin) {
            const profile = await tx.restaurantStaffProfile.create({
              data: { userId: entry.id, displayName: entry.id },
            });
            profiles[entry.id] = profile.id;
            await tx.restaurantOperatorCredential.create({
              data: {
                staffProfileId: profile.id,
                type: 'PIN',
                credentialHash: await credentials.hashOperatorCredential('PIN', entry.pin),
              },
            });
          }
        }
      },
      { userId: PEOPLE.find((entry) => entry.org === org)!.id, timeout: 60_000 }
    );

  await tenant(async (tx) => {
    const patient = await tx.pharmacyPatient.create({ data: { displayName: 'Synthetic patient' } });
    await tx.patientConsent.create({
      data: {
        patientId: patient.id,
        purpose: 'REMINDERS',
        channel: 'SMS',
        version: 1,
        granted: true,
        recordedByUserId: P.north.id,
      },
    });
    const customer = await tx.pharmacyCustomer.create({
      data: { patientId: patient.id, displayName: 'Synthetic patient' },
    });
    customerId = customer.id;
    const prescriber = await tx.pharmacyPrescriber.create({
      data: { name: 'Dr Synthetic', registrationNumber: `PMDC-941-${suffix}` },
    });
    // An over-the-counter medicine, for the reminder records (no pharmacist sign-off needed).
    const otc = await tx.medicine.create({
      data: {
        productName: `Paracetamol ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { presentation: 'Tablet, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const otcPrescription = await tx.prescription.create({
      data: {
        patientId: patient.id,
        prescriberId: prescriber.id,
        sourceKind: 'PAPER_IMAGE',
        sourceFileRef: `paper:otc-${suffix}`,
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validUntil: new Date('2099-01-01T00:00:00.000Z'),
        authorizedRepeats: 5,
        capturedByUserId: P.north.id,
        lines: {
          create: {
            lineNumber: 1,
            medicineId: otc.id,
            presentationId: otc.presentations[0]!.id,
            authorizedCanonicalUnits: 200,
            directions: 'Take one tablet twice a day',
          },
        },
      },
      include: { lines: true },
    });
    fills = [];
    for (let sequence = 1; sequence <= 2; sequence += 1) {
      const fill = await tx.prescriptionFill.create({
        data: {
          // DEV-962: the first fill was dispensed at north, the second at south; each
          // branch records the reminder of its own fill below.
          branchId: sequence === 1 ? X.north : X.south,
          prescriptionLineId: otcPrescription.lines[0]!.id,
          fillSequence: sequence,
          quantityCanonicalUnits: 20,
          dispensedByUserId: P.north.id,
          idempotencyKey: `fill-941-${sequence}-${suffix}`,
        },
      });
      fills.push(fill.id);
    }
    // A prescription-only medicine, stocked at north, for the refill cycles.
    const medicine = await tx.medicine.create({
      data: {
        productName: `Metformin ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        rx: true,
        saleable: true,
        presentations: { create: { presentation: 'Tablet 500 mg' } },
      },
      include: { presentations: true },
    });
    const presentationId = medicine.presentations[0]!.id;
    const pack = await tx.packLevel.create({
      data: {
        presentationId,
        versionGroupId: `strip-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await tx.pharmacyStockLocation.create({
      data: { branchId: X.north, code: `MAIN-${suffix}`, name: 'Main store', kind: 'STORE' },
    });
    const expiresAt = new Date('2029-12-31T00:00:00.000Z');
    const batch = await tx.pharmacyManufacturingBatch.create({
      data: {
        medicineId: medicine.id,
        batchNumber: `B-${suffix}`,
        expiresAt,
        expiryPrecision: 'DAY',
      },
    });
    await ledger.receiveLot(
      tx,
      { organizationId: X.org, branchId: X.north, actorId: P.clerk.id },
      {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: `INV-${suffix}`,
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 500,
        idempotencyKey: `receipt-${suffix}`,
        receivedAt: new Date('2026-02-01T00:00:00.000Z'),
      }
    );
    rx = { medicineId: medicine.id, presentationId, packLevelId: pack.id };
    const rxPrescription = await tx.prescription.create({
      data: {
        patientId: patient.id,
        prescriberId: prescriber.id,
        sourceKind: 'PAPER_IMAGE',
        sourceFileRef: `paper:rx-${suffix}`,
        validFrom: new Date(Date.now() - 30 * DAY),
        validUntil: new Date(Date.now() + 365 * DAY),
        authorizedRepeats: 100,
        capturedByUserId: P.north.id,
        lines: {
          create: {
            lineNumber: 1,
            medicineId: medicine.id,
            presentationId,
            authorizedCanonicalUnits: 100_000,
            directions: 'One tablet twice a day',
          },
        },
      },
      include: { lines: true },
    });
    prescriptionLineId = rxPrescription.lines[0]!.id;
  });

  // One reminder record at each branch, each written by a pharmacist who works there.
  const reminder = (branchId: string, fillId: string) => ({
    branchId,
    fillId,
    channel: 'SMS',
    directionsUrdu: 'Synthetic Urdu directions',
    idempotencyKey: `reminder-${fillId}`,
  });
  northReminder = (
    await as(P.north, (api) =>
      api.pharmacyPrescriptions.captureRefillReminder(reminder(X.north, fills[0]!))
    )
  ).id;
  southReminder = (
    await as(P.south, (api) =>
      api.pharmacyPrescriptions.captureRefillReminder(reminder(X.south, fills[1]!))
    )
  ).id;
}, 180_000);

beforeEach(() => {
  recordTrpcAudit?.mockClear();
});

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('DEV-941 viewing refill reminders follows the branch rule', () => {
  it('shows a pharmacist only their own branch and its reminder records', async () => {
    const workspace = await as(P.north, (api) => api.pharmacyPrescriptions.workspace());
    expect(workspace.branches.map((branch) => branch.id)).toEqual([X.north]);
    expect(workspace.selectedBranchId).toBe(X.north);
    expect(workspace.reminderCaptures.map((capture) => capture.id)).toEqual([northReminder]);
    // The prescription list does not carry the other branch's record either.
    const shown = allFills(workspace);
    expect(shown.find((fill) => fill.id === fills[0])?.reminderCapture?.id).toBe(northReminder);
    expect(shown.find((fill) => fill.id === fills[1])).toMatchObject({ reminderCapture: null });
    expect(JSON.stringify(workspace)).not.toContain(southReminder);
  });

  it('refuses another branch plainly, and logs the refusal against that branch', async () => {
    await expect(
      settle(as(P.north, (api) => api.pharmacyPrescriptions.workspace({ branchId: X.south })))
    ).resolves.toEqual(VIEW_REFUSAL);
    expect(loggedRefusals('pharmacyPrescriptions.workspace')).toEqual([VIEW_REFUSAL.message]);
    const [entry] = refusalEntries('pharmacyPrescriptions.workspace');
    expect(entry!.ctx.audit.detail).toMatchObject({ metadata: { branchId: X.south } });
  });

  it('shows an organisation admin every branch and each branch’s records', async () => {
    const all = await as(P.admin, (api) => api.pharmacyPrescriptions.workspace());
    expect(all.branches.map((branch) => branch.id).sort()).toEqual([X.north, X.south].sort());
    const south = await as(P.admin, (api) =>
      api.pharmacyPrescriptions.workspace({ branchId: X.south })
    );
    expect(south.selectedBranchId).toBe(X.south);
    expect(south.reminderCaptures.map((capture) => capture.id)).toEqual([southReminder]);
    const shown = allFills(south);
    expect(shown.find((fill) => fill.id === fills[0])?.reminderCapture?.id).toBe(northReminder);
    expect(shown.find((fill) => fill.id === fills[1])?.reminderCapture?.id).toBe(southReminder);
  });

  it('gives another organisation nothing of this one', async () => {
    await expect(
      settle(as(P.foreign, (api) => api.pharmacyPrescriptions.workspace({ branchId: X.north })))
    ).resolves.toEqual({ code: 'NOT_FOUND', message: 'Pharmacy branch not found.' });
    const own = await as(P.foreign, (api) => api.pharmacyPrescriptions.workspace());
    expect(own.branches.map((branch) => branch.id)).toEqual([Y.branch]);
    expect(own.reminderCaptures).toEqual([]);
    const text = JSON.stringify(own);
    for (const id of [northReminder, southReminder, ...fills]) expect(text).not.toContain(id);
  });
});

describeIfDatabase('DEV-941 approving a refill cycle follows the branch rule', () => {
  it('offers only pharmacists who may approve at the branch', async () => {
    const approvers = await as(P.clerk, (api) =>
      api.pharmacyOrdering.subscriptionCycleApprovers({ branchId: X.north })
    );
    expect(approvers.map((approver) => approver.id).sort()).toEqual(
      [profiles[P.north.id], profiles[P.admin.id]].sort()
    );
  });

  it('refuses the PIN of a pharmacist of another branch, logs it, and keeps the cycle held', async () => {
    const cycleId = await openCycle();
    await expect(settle(approveWith(P.south, cycleId))).resolves.toEqual(APPROVE_REFUSAL);
    expect(loggedRefusals('pharmacyOrdering.approveSubscriptionCycle')).toEqual([
      APPROVE_REFUSAL.message,
    ]);
    const [entry] = refusalEntries('pharmacyOrdering.approveSubscriptionCycle');
    expect(entry!.ctx.audit.detail).toMatchObject({
      metadata: { approverId: P.south.id, pinVerified: true },
    });
    await expect(cycleRow(cycleId)).resolves.toEqual({
      status: 'AWAITING_PHARMACIST',
      approvedByUserId: null,
      approvedAt: null,
    });
  });

  it('refuses a pharmacist of another branch acting here with their own PIN', async () => {
    const cycleId = await openCycle();
    await expect(settle(approveWith(P.south, cycleId, P.south))).resolves.toEqual(OUTSIDE_SCOPE);
    await expect(
      settle(as(P.south, (api) => api.pharmacyOrdering.refillProgram({ branchId: X.north })))
    ).resolves.toEqual(OUTSIDE_SCOPE);
    await expect(cycleRow(cycleId)).resolves.toMatchObject({ status: 'AWAITING_PHARMACIST' });
  });

  it('refuses the PIN of another organisation’s pharmacist', async () => {
    const cycleId = await openCycle();
    await expect(settle(approveWith(P.foreign, cycleId))).resolves.toEqual(PIN_REFUSAL);
    await expect(cycleRow(cycleId)).resolves.toMatchObject({ status: 'AWAITING_PHARMACIST' });
  });

  it('accepts the PIN of a pharmacist assigned to the branch', async () => {
    const cycleId = await openCycle();
    await expect(approveWith(P.north, cycleId)).resolves.toMatchObject({
      status: 'RESERVED',
      approvedByUserId: P.north.id,
    });
    await expect(cycleRow(cycleId)).resolves.toMatchObject({
      status: 'RESERVED',
      approvedByUserId: P.north.id,
    });
  });

  it('accepts the PIN of an organisation admin assigned to no branch', async () => {
    const cycleId = await openCycle();
    await expect(approveWith(P.admin, cycleId)).resolves.toMatchObject({
      status: 'RESERVED',
      approvedByUserId: P.admin.id,
    });
  });
});
