/**
 * #518 launch fix — a prescription reference on a counter sale line must resolve to a real,
 * current prescription line of this organization, for the same patient (and the sale's linked
 * customer), covering the medicine and the remaining quantity. Anything else is refused with a
 * typed error and adds nothing; QA's invented reference used to be accepted.
 * Real router, persisted roles, PostgreSQL as a NOSUPERUSER NOBYPASSRLS role.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
  org: `org_r518rx_${suffix}`,
  otherOrg: `org_r518rx_other_${suffix}`,
  branch: `br_r518rx_${suffix}`,
  cashier: `user_r518rx_cashier_${suffix}`,
  pharmacist: `user_r518rx_pharm_${suffix}`,
};
const DAY = 24 * 60 * 60 * 1000;
const key = () => randomBytes(8).toString('hex');
const refused = (message: string, code = 'BAD_REQUEST') => ({ code, message });
const NOT_FOUND = refused(
  'That prescription reference does not match a prescription for this medicine in this pharmacy.'
);
const PATIENT_MISMATCH = refused('That prescription belongs to a different patient.');
const NOT_IN_DATE = refused('That prescription is outside its validity period.');
const NEEDS_PHARMACIST = refused(
  'Only a pharmacist with the dispensing permission can record a prescription against a line.',
  'FORBIDDEN'
);
const RX_DENIED = refused(
  'Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission.',
  'FORBIDDEN'
);

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Medicine = { medicineId: string; presentationId: string; packLevelId: string };
type SalesCaller = {
  create: (input: { branchId: string }) => Promise<{ id: string }>;
  addLine: (input: Record<string, unknown>) => Promise<{ line: { id: string } }>;
  attachCounterPrescription: (input: {
    branchId: string;
    saleId: string;
    saleLineId: string;
    patientId: string;
    prescriptionLineId: string;
  }) => Promise<unknown>;
  linkCustomer: (input: Record<string, unknown>) => Promise<unknown>;
  counterCart: (input: { branchId: string; saleId: string }) => Promise<{ lines: unknown[] }>;
  transition: (input: {
    branchId: string;
    saleId: string;
    action: 'void';
    reason: string;
  }) => Promise<unknown>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;
let rx: Medicine;
let otc: Medicine;
let controlled: Medicine;
const patients = { ayesha: '', bilal: '' };
/** Prescription line ids. */
const lines = {
  valid: '',
  expired: '',
  bilal: '',
  otcForAyesha: '',
  otherOrg: '',
  voided: '',
  completed: '',
  retried: '',
  fullCompletion: '',
  concurrent: '',
};

function act<T>(userId: string, run: (api: SalesCaller, db: ScopedDb) => Promise<T>) {
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
          audit: { detail: {} },
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
const withReference = (prescriptionLineId: string, patientId = patients.ayesha) => ({
  prescription: { prescriptionLineId, patientId },
});

async function newSale(userId: string, prepare?: (api: SalesCaller, saleId: string) => unknown) {
  return act(userId, async (api) => {
    const sale = await api.create({ branchId: ids.branch });
    await prepare?.(api, sale.id);
    return sale.id;
  });
}
/** One addLine on a new sale is refused with `error`, and the sale stays empty. */
async function expectRefused(
  userId: string,
  medicine: Medicine,
  extra: Record<string, unknown>,
  error: { code: string; message: string },
  prepare?: (api: SalesCaller, saleId: string) => unknown
) {
  const saleId = await newSale(userId, prepare);
  await expect(
    act(userId, (api) => api.addLine(line(saleId, medicine, extra)))
  ).rejects.toMatchObject(error);
  const cart = await act(ids.pharmacist, (api) =>
    api.counterCart({ branchId: ids.branch, saleId })
  );
  expect(cart.lines).toEqual([]);
}

async function assertRuntimeRole() {
  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls
         FROM pg_roles
        WHERE rolname = current_user`
    )
  );
  expect(role).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
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
  // Keep this precondition outside individual tests so filtered runs cannot skip it,
  // and reject a role that bypasses RLS before writing any fixture data.
  await assertRuntimeRole();
  for (const org of [ids.org, ids.otherOrg])
    await withPlatformDb((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, 'Rx reference', 'Rx reference', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
        org
      )
    );
  const now = Date.now();
  const current = { validFrom: new Date(now - 30 * DAY), validUntil: new Date(now + 365 * DAY) };

  async function medicineIn(
    tx: ScopedDb,
    name: string,
    flags: { rx?: boolean; controlled?: boolean },
    stockUnits = 0
  ): Promise<Medicine> {
    const medicine = await tx.medicine.create({
      data: {
        productName: `${name} ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        rx: flags.rx ?? false,
        controlled: flags.controlled ?? false,
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
    if (stockUnits > 0) {
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
          quantityUnits: stockUnits,
          idempotencyKey: `receipt-${medicine.id}`,
          receivedAt: new Date('2026-02-01T00:00:00.000Z'),
        }
      );
    }
    return {
      medicineId: medicine.id,
      presentationId: medicine.presentations[0]!.id,
      packLevelId: packLevel.id,
    };
  }

  async function prescriptionLine(
    tx: ScopedDb,
    organizationId: string,
    input: {
      patientId: string;
      prescriberId: string;
      medicine: Medicine;
      validFrom: Date;
      validUntil: Date;
      authorizedCanonicalUnits: number;
      authorizedRepeats?: number;
    }
  ) {
    const prescription = await tx.prescription.create({
      data: {
        organizationId,
        patientId: input.patientId,
        prescriberId: input.prescriberId,
        sourceKind: 'PAPER_IMAGE',
        sourceFileRef: `paper:${key()}`,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        authorizedRepeats: input.authorizedRepeats ?? 0,
        capturedByUserId: ids.pharmacist,
        lines: {
          create: {
            lineNumber: 1,
            medicineId: input.medicine.medicineId,
            presentationId: input.medicine.presentationId,
            authorizedCanonicalUnits: input.authorizedCanonicalUnits,
            directions: 'One capsule three times a day',
          },
        },
      },
      include: { lines: true },
    });
    return prescription.lines[0]!.id;
  }

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
    for (const [userId, capabilities] of [
      [ids.cashier, ['pharmacy:counter', 'pharmacy:orders']],
      [ids.pharmacist, ['pharmacy:dispense', 'pharmacy:counter']],
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
      await tx.pharmacyBranchAssignment.create({ data: { userId, branchId: ids.branch } });
    }
    rx = await medicineIn(tx, 'Amoxicillin 500mg', { rx: true }, 500);
    otc = await medicineIn(tx, 'Paracetamol 500mg', {});
    controlled = await medicineIn(tx, 'Tramadol 50mg', { controlled: true });
    patients.ayesha = (
      await tx.pharmacyPatient.create({ data: { displayName: 'Ayesha Khan' } })
    ).id;
    patients.bilal = (await tx.pharmacyPatient.create({ data: { displayName: 'Bilal Ahmed' } })).id;
    await tx.patientConsent.create({
      data: {
        patientId: patients.ayesha,
        purpose: 'LOYALTY',
        channel: 'IN_PERSON',
        version: 1,
        granted: true,
        recordedByUserId: ids.pharmacist,
      },
    });
    const prescriber = await tx.pharmacyPrescriber.create({
      data: { name: 'Dr Sana Malik', registrationNumber: `PMDC-${suffix}` },
    });
    const forAyesha = { patientId: patients.ayesha, prescriberId: prescriber.id };
    // One strip's worth with repeats to spare, so the second strip fails on quantity.
    lines.valid = await prescriptionLine(tx, ids.org, {
      ...forAyesha,
      ...current,
      medicine: rx,
      authorizedCanonicalUnits: 10,
      authorizedRepeats: 3,
    });
    lines.expired = await prescriptionLine(tx, ids.org, {
      ...forAyesha,
      medicine: rx,
      validFrom: new Date(now - 60 * DAY),
      validUntil: new Date(now - DAY),
      authorizedCanonicalUnits: 100,
    });
    lines.bilal = await prescriptionLine(tx, ids.org, {
      ...current,
      patientId: patients.bilal,
      prescriberId: prescriber.id,
      medicine: rx,
      authorizedCanonicalUnits: 100,
    });
    lines.otcForAyesha = await prescriptionLine(tx, ids.org, {
      ...forAyesha,
      ...current,
      medicine: otc,
      authorizedCanonicalUnits: 100,
    });
    for (const name of [
      'voided',
      'completed',
      'fullCompletion',
      'retried',
      'concurrent',
    ] as const) {
      lines[name] = await prescriptionLine(tx, ids.org, {
        ...forAyesha,
        ...current,
        medicine: rx,
        authorizedCanonicalUnits: 10,
        authorizedRepeats: 3,
      });
    }
  });
  // The same medicine and patient shape in another organization, invisible to this one.
  await withTenantDb(ids.otherOrg, async (tx) => {
    const medicine = await medicineIn(tx, 'Amoxicillin 500mg other', { rx: true });
    const patient = await tx.pharmacyPatient.create({ data: { displayName: 'Ayesha Khan' } });
    const prescriber = await tx.pharmacyPrescriber.create({
      data: { name: 'Dr Other', registrationNumber: `PMDC-O-${suffix}` },
    });
    lines.otherOrg = await prescriptionLine(tx, ids.otherOrg, {
      ...current,
      patientId: patient.id,
      prescriberId: prescriber.id,
      medicine,
      authorizedCanonicalUnits: 100,
    });
  });
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('prescription references on counter sale lines (#518)', () => {
  it('runs the fixture as the provisioned runtime role with tenant context (#389)', async () => {
    await assertRuntimeRole();

    const [scope] = await withTenantDb(ids.org, (tx) =>
      tx.$queryRawUnsafe<Array<{ organization_id: string; is_platform_admin: string }>>(
        `SELECT current_setting('app.current_organization_id') AS organization_id,
                current_setting('app.is_platform_admin') AS is_platform_admin`
      )
    );
    expect(scope).toEqual({ organization_id: ids.org, is_platform_admin: 'false' });
  });

  it('refuses an unknown reference', async () => {
    await expectRefused(ids.pharmacist, rx, withReference(`rx-invented-${suffix}`), NOT_FOUND);
  });

  it('allows a cashier to stage an unlinked Rx line without authorizing it', async () => {
    const saleId = await newSale(ids.cashier);
    const added = await act(ids.cashier, (api) => api.addLine(line(saleId, rx)));
    const cart = await act(ids.cashier, (api) => api.counterCart({ branchId: ids.branch, saleId }));
    expect(cart.lines).toEqual([
      expect.objectContaining({
        saleLineId: added.line.id,
        prescriptionLineId: null,
        prescriptionSigned: false,
      }),
    ]);
  });

  it('serializes attachment against void and never attaches to a void bill', async () => {
    const saleId = await newSale(ids.cashier);
    const added = await act(ids.cashier, (api) => api.addLine(line(saleId, rx)));
    let release: () => void = () => {};
    let markLocked: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const voiding = act(ids.cashier, async (api) => {
      await api.transition({ branchId: ids.branch, saleId, action: 'void', reason: 'Cancelled' });
      markLocked();
      await held;
    });
    await locked;
    const attaching = act(ids.cashier, (api) =>
      api.attachCounterPrescription({
        branchId: ids.branch,
        saleId,
        saleLineId: added.line.id,
        patientId: patients.ayesha,
        prescriptionLineId: lines.valid,
      })
    );
    release();
    const outcomes = await Promise.allSettled([voiding, attaching]);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1].status).toBe('rejected');
    const stored = await withTenantDb(ids.org, (tx) =>
      tx.pharmacySaleLine.findFirstOrThrow({ where: { id: added.line.id } })
    );
    expect(stored.prescriptionLineId).toBeNull();
  });

  it('queues the attached line without signing and rejects the requesting cashier as signer', async () => {
    const saleId = await newSale(ids.cashier);
    const added = await act(ids.cashier, (api) => api.addLine(line(saleId, rx)));
    const attachment = {
      branchId: ids.branch,
      saleId,
      saleLineId: added.line.id,
      patientId: patients.ayesha,
      prescriptionLineId: lines.valid,
    };
    await expect(
      act(ids.cashier, (api) =>
        api.attachCounterPrescription({ ...attachment, patientId: patients.bilal })
      )
    ).rejects.toMatchObject(PATIENT_MISMATCH);
    await act(ids.cashier, (api) => api.attachCounterPrescription(attachment));
    const review = await withTenantDb(ids.org, (tx) =>
      tx.pharmacyPharmacistReviewItem.findFirstOrThrow({ where: { saleLineId: added.line.id } })
    );
    const before = await act(ids.cashier, (api) =>
      api.counterCart({ branchId: ids.branch, saleId })
    );
    expect(before.lines).toEqual([
      expect.objectContaining({ prescriptionLineId: lines.valid, prescriptionSigned: false }),
    ]);
    await expect(
      withTenantDb(
        ids.org,
        (tx) =>
          tx.pharmacyPharmacistReviewDecision.create({
            data: {
              reviewItemId: review.id,
              kind: 'SIGN',
              signedAt: new Date(),
              actorUserId: ids.cashier,
            },
          }),
        { userId: ids.cashier }
      )
    ).rejects.toThrow();
    await withTenantDb(
      ids.org,
      (tx) =>
        tx.pharmacyPharmacistReviewDecision.create({
          data: {
            reviewItemId: review.id,
            kind: 'SIGN',
            signedAt: new Date(),
            actorUserId: ids.pharmacist,
          },
        }),
      { userId: ids.pharmacist }
    );
    const after = await act(ids.cashier, (api) =>
      api.counterCart({ branchId: ids.branch, saleId })
    );
    expect(after.lines).toEqual([
      expect.objectContaining({ prescriptionLineId: lines.valid, prescriptionSigned: true }),
    ]);
  });

  it('refuses an attempt to attach a line belonging to a different bill', async () => {
    const saleId = await newSale(ids.cashier);
    const otherSaleId = await newSale(ids.cashier);
    const added = await act(ids.cashier, (api) => api.addLine(line(otherSaleId, rx)));
    await expect(
      act(ids.cashier, (api) =>
        api.attachCounterPrescription({
          branchId: ids.branch,
          saleId,
          saleLineId: added.line.id,
          patientId: patients.ayesha,
          prescriptionLineId: lines.valid,
        })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const lineAfter = await withTenantDb(ids.org, (tx) =>
      tx.pharmacySaleLine.findFirstOrThrow({ where: { id: added.line.id } })
    );
    expect(lineAfter.prescriptionLineId).toBeNull();
  });

  it("refuses another organization's prescription", async () => {
    await expectRefused(ids.pharmacist, rx, withReference(lines.otherOrg), NOT_FOUND);
  });

  it('refuses an expired prescription', async () => {
    await expectRefused(ids.pharmacist, rx, withReference(lines.expired), NOT_IN_DATE);
  });

  it('refuses a prescription for another medicine', async () => {
    await expectRefused(ids.pharmacist, rx, withReference(lines.otcForAyesha), NOT_FOUND);
  });

  it("refuses another patient's prescription, and one for a sale linked to another customer", async () => {
    await expectRefused(
      ids.pharmacist,
      rx,
      withReference(lines.bilal, patients.ayesha),
      PATIENT_MISMATCH
    );
    await expectRefused(
      ids.pharmacist,
      rx,
      withReference(lines.bilal, patients.bilal),
      PATIENT_MISMATCH,
      (api, saleId) =>
        api.linkCustomer({
          branchId: ids.branch,
          saleId,
          patientId: patients.ayesha,
          displayName: 'Ayesha Khan',
        })
    );
  });

  it('serializes a referenced addLine against a concurrent customer link (#518 F-01)', async () => {
    const saleId = await newSale(ids.pharmacist);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const add = act(ids.pharmacist, async (api) => {
      await api.addLine(line(saleId, rx, withReference(lines.bilal, patients.bilal)));
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const link = act(ids.pharmacist, (api) =>
      api.linkCustomer({
        branchId: ids.branch,
        saleId,
        patientId: patients.ayesha,
        displayName: 'Ayesha Khan',
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    const [addOutcome, linkOutcome] = await Promise.allSettled([add, link]);
    expect(addOutcome.status).toBe('fulfilled');
    expect(linkOutcome.status).toBe('rejected');
    const sale = await withTenantDb(ids.org, (tx) =>
      tx.pharmacySale.findFirst({ where: { id: saleId }, select: { customerId: true } })
    );
    expect(sale?.customerId ?? null).toBeNull();
  });

  it('refuses the invented reference inside a controlled authorization on a non-controlled line', async () => {
    await expectRefused(
      ids.pharmacist,
      rx,
      {
        controlledAuthorization: {
          prescriptionLineId: `rx-invented-${suffix}`,
          patientId: patients.ayesha,
          patientAddress: '12 Mall Road, Lahore',
          staffProfileId: `staff-invented-${suffix}`,
          pin: '1234',
          rxSerialWritten: true,
          emergency: false,
        },
      },
      refused('A controlled-medicine authorization was sent for a medicine that is not controlled.')
    );
  });

  it('refuses a prescription field on a controlled line', async () => {
    await expectRefused(
      ids.pharmacist,
      controlled,
      withReference(lines.valid),
      refused("A controlled medicine's prescription belongs in its controlled authorization.")
    );
  });

  it('lets only a pharmacist record a prescription, on an Rx or an OTC line', async () => {
    await expectRefused(ids.cashier, rx, withReference(lines.valid), RX_DENIED);
    await expectRefused(ids.cashier, otc, withReference(lines.otcForAyesha), NEEDS_PHARMACIST);
  });

  async function addReferencedSale(prescriptionLineId: string) {
    const saleId = await newSale(ids.pharmacist);
    const added = await act(ids.pharmacist, (api) =>
      api.addLine(line(saleId, rx, withReference(prescriptionLineId)))
    );
    return { saleId, saleLineId: added.line.id };
  }

  async function recordCompletion(saleLineId: string) {
    const { recordCompletedPrescriptionReference } =
      await import('@/lib/pharmacy/rx-prescription-reference');
    return withTenantDb(
      ids.org,
      async (tx) => {
        const saleLine = await tx.pharmacySaleLine.findFirstOrThrow({
          where: { id: saleLineId, organizationId: ids.org, branchId: ids.branch },
        });
        if (!saleLine.prescriptionLineId) throw new Error('missing prescription reference');
        await recordCompletedPrescriptionReference(
          tx,
          { organizationId: ids.org, branchId: ids.branch, actorId: ids.pharmacist },
          { ...saleLine, prescriptionLineId: saleLine.prescriptionLineId, saleId: saleLine.saleId }
        );
      },
      { userId: ids.pharmacist }
    );
  }

  async function signPrescription(saleLineId: string, prescriptionLineId: string) {
    await withTenantDb(ids.org, async (tx) => {
      const review = await tx.pharmacyPharmacistReviewItem.create({
        data: {
          prescriptionLineId,
          saleLineId,
          requestedByUserId: ids.cashier,
        },
      });
      await tx.pharmacyPharmacistReviewDecision.create({
        data: {
          reviewItemId: review.id,
          kind: 'SIGN',
          actorUserId: ids.pharmacist,
          signedAt: new Date(),
        },
      });
    });
  }

  it('leaves prescription quantity unconsumed when an added line is voided', async () => {
    const added = await addReferencedSale(lines.voided);
    await act(ids.pharmacist, (api) =>
      api.transition({
        branchId: ids.branch,
        saleId: added.saleId,
        action: 'void',
        reason: 'Patient cancelled before payment',
      })
    );
    await expect(
      withTenantDb(ids.org, (tx) =>
        tx.prescriptionFill.count({ where: { prescriptionLineId: lines.voided } })
      )
    ).resolves.toBe(0);
  });

  it('consumes prescription quantity at completion, not at addLine', async () => {
    const added = await addReferencedSale(lines.completed);
    await expect(
      withTenantDb(ids.org, (tx) =>
        tx.prescriptionFill.count({ where: { prescriptionLineId: lines.completed } })
      )
    ).resolves.toBe(0);
    await recordCompletion(added.saleLineId);
    await expect(
      withTenantDb(ids.org, (tx) =>
        tx.prescriptionFill.findFirst({ where: { prescriptionLineId: lines.completed } })
      )
    ).resolves.toMatchObject({
      quantityCanonicalUnits: 10,
      dispensedByUserId: ids.pharmacist,
      idempotencyKey: `rx-reference:${added.saleLineId}`,
    });
  });

  it('completes a referenced sale through completePaidPharmacySale and records the fill', async () => {
    // Exercises the real completion path (no mocks in this case): QA found completion
    // dropped prescriptionPatientId/saleId when recording the reference.
    const added = await addReferencedSale(lines.fullCompletion);
    await signPrescription(added.saleLineId, lines.fullCompletion);
    const { completePaidPharmacySale, completionSaleInclude } =
      await import('@/lib/pharmacy/sale-completion');
    await withTenantDb(
      ids.org,
      async (tx) => {
        const sale = await tx.pharmacySale.findFirstOrThrow({
          where: { id: added.saleId, organizationId: ids.org, branchId: ids.branch },
          include: completionSaleInclude,
        });
        await completePaidPharmacySale(
          tx,
          { organizationId: ids.org, branchId: ids.branch, actorId: ids.pharmacist },
          sale,
          { deviceId: `dev_r518_${suffix}`, businessDate: new Date('2026-10-23T00:00:00.000Z') }
        );
      },
      { userId: ids.pharmacist }
    );
    const state = await withTenantDb(ids.org, async (tx) => ({
      sale: await tx.pharmacySale.findFirstOrThrow({ where: { id: added.saleId } }),
      fill: await tx.prescriptionFill.findFirst({
        where: { prescriptionLineId: lines.fullCompletion },
      }),
    }));
    expect(state.sale.status).toBe('COMPLETED');
    expect(state.fill).toMatchObject({
      quantityCanonicalUnits: 10,
      idempotencyKey: `rx-reference:${added.saleLineId}`,
    });
  });

  it('makes completion retries idempotent', async () => {
    const added = await addReferencedSale(lines.retried);
    await recordCompletion(added.saleLineId);
    await recordCompletion(added.saleLineId);
    await expect(
      withTenantDb(ids.org, (tx) =>
        tx.prescriptionFill.count({ where: { prescriptionLineId: lines.retried } })
      )
    ).resolves.toBe(1);
  });

  it('serializes competing completions from two different sales (#389)', async () => {
    const first = await addReferencedSale(lines.concurrent);
    const second = await addReferencedSale(lines.concurrent);
    expect(first.saleId).not.toBe(second.saleId);
    expect(first.saleLineId).not.toBe(second.saleLineId);

    const outcomes = await Promise.allSettled([
      recordCompletion(first.saleLineId),
      recordCompletion(second.saleLineId),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.reason).toMatchObject({
      name: 'PharmacyRxReferenceError',
      reason: 'PRESCRIPTION_EXHAUSTED',
    });

    const winningLineId = outcomes[0].status === 'fulfilled' ? first.saleLineId : second.saleLineId;
    const fills = await withTenantDb(ids.org, (tx) =>
      tx.prescriptionFill.findMany({ where: { prescriptionLineId: lines.concurrent } })
    );
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      quantityCanonicalUnits: 10,
      idempotencyKey: `rx-reference:${winningLineId}`,
    });
  });
});
