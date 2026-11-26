import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { decideFromRules } from '@/lib/abac/capabilities';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import {
  createTenantDb,
  withPlatformDb,
  withTenantDb,
  type ScopedDb,
} from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';
import { seedPharmacyRegulatoryProfile } from '@/lib/test-support/pharmacy-regulatory';
import { PHARMACY_MODULES, PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { receiveLot } from '@/lib/pharmacy/stock-ledger';
import { router, type TRPCContext } from '@/server/trpc';
import { pharmacySalesRouter } from '@/server/routers/pharmacy-sales';
import { pharmacyDispensingRouter } from '@/server/routers/pharmacy-dispensing';
import { pharmacyPurchasingRouter } from '@/server/routers/pharmacy-purchasing';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { pharmacyInventoryRouter } from '@/server/routers/pharmacy-inventory';
import { pharmacyMedicineRouter } from '@/server/routers/pharmacy-medicine';
import { pharmacyStagedReviewRouter } from '@/server/routers/pharmacy-staged-review';
import { pharmacyCardTerminalRouter } from '@/server/routers/pharmacy-card-terminal';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { organizationAdminRouter } from '@/server/routers/organization-admin';

const api = router({
  pharmacySales: pharmacySalesRouter,
  pharmacyDispensing: pharmacyDispensingRouter,
  // The exported purchasing caller overloads two paginated reads. Mount its
  // real procedure record so tRPC retains the namespace and infers mutations.
  pharmacyPurchasing: router(pharmacyPurchasingRouter._def.record),
  pharmacyReports: pharmacyReportsRouter,
  pharmacyMedicine: pharmacyMedicineRouter,
  pharmacyInventory: pharmacyInventoryRouter,
  pharmacyCardTerminal: pharmacyCardTerminalRouter,
  pharmacyFinance: pharmacyFinanceRouter,
  organizationAdmin: organizationAdminRouter,
});
export type RoleKey =
  | 'owner'
  | 'owner-operator'
  | 'pharmacist'
  | 'pharmacist-cashier'
  | 'manager'
  | 'cashier'
  | 'procurement'
  | 'inventory'
  | 'finance'
  | 'auditor';
export const pin = '4628';

export async function setupRole(role: RoleKey) {
  const org = 'task_' + randomUUID().slice(0, 12);
  const branchId = org + '_branch';
  const closeBranchId = org + '_close';
  const tenant = <T>(fn: (db: ScopedDb) => Promise<T>) => withTenantDb(org, fn);
  const id = (person: string) => org + '_' + person;
  const people = {
    subject: role,
    editor: 'owner-operator',
    witness: 'pharmacist',
    cashier: 'cashier',
    supervisor: 'manager',
    buyer: 'procurement',
    teammate: 'inventory',
  } as const;
  type Person = keyof typeof people;
  const userRole = (person: Person) =>
    ['owner', 'owner-operator'].includes(people[person])
      ? ('ADMIN' as const)
      : ('EMPLOYEE' as const);
  await withPlatformDb(
    (db) =>
      db.$executeRaw`INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,"updatedAt",timezone,"requireApprovalAuthenticator") VALUES (${org},${org},'Task suite','Task suite','PHARMACY','ACTIVE',now(),'UTC',false)`
  );
  const credentialHash = await hashOperatorCredential('PIN', pin);
  const stock = await tenant(async (db) => {
    await seedDepartments(db, [org], ['LEADERSHIP']);
    const premises = {
      city: 'Lahore',
      addressLine: '1 Test Road',
      provinceCode: 'PB',
      cashShiftsEnabled: true,
    };
    await db.pharmacyBranch.createMany({
      data: [
        { ...premises, id: branchId, code: 'MAIN', name: 'Main' },
        { ...premises, id: closeBranchId, code: 'CLOSE', name: 'Closing branch' },
      ],
    });
    for (const template of PHARMACY_ROLE_TEMPLATES) {
      await db.organizationRole.create({
        data: {
          id: id(template.key),
          key: template.key,
          name: template.name,
          isSystem: true,
          permissions: {
            create: template.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
          },
        },
      });
    }
    for (const person of Object.keys(people) as Person[]) {
      const userId = id('user_' + person);
      await db.user.create({
        data: {
          id: userId,
          name: person,
          email: userId + '@example.test',
          title: 'Staff',
          department: 'LEADERSHIP',
          role: userRole(person),
          organizationRoleId: id(people[person]),
        },
      });
      await db.pharmacyBranchAssignment.createMany({
        data: [
          { branchId, userId },
          { branchId: closeBranchId, userId },
        ],
      });
      await db.restaurantStaffProfile.create({
        data: {
          id: id('staff_' + person),
          userId,
          displayName: person,
          credentials: { create: { type: 'PIN', credentialHash } },
        },
      });
    }
    const supplier = await db.pharmacySupplier.create({
      data: {
        name: 'Synthetic distributor',
        authorized: true,
        licences: {
          create: {
            licenceType: 'WHOLESALE',
            licenceNumber: 'TEST',
            issuingAuthority: 'Test',
            issuedAt: new Date('2020-01-01'),
            expiresAt: new Date('2099-01-01'),
            verifiedAt: new Date(),
          },
        },
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: { branchId, code: 'S', name: 'Store', kind: 'STORE' },
    });
    const patient = await db.pharmacyPatient.create({
      data: { displayName: 'Synthetic patient', cnic: '00000-0000000-0' },
    });
    await db.patientConsent.create({
      data: {
        patientId: patient.id,
        purpose: 'DISPENSING',
        channel: 'IN_PERSON',
        version: 1,
        granted: true,
        recordedByUserId: id('user_witness'),
      },
    });
    const prescriber = await db.pharmacyPrescriber.create({
      data: { name: 'Synthetic prescriber', registrationNumber: id('reg') },
    });
    async function product(kind: 'otc' | 'rx' | 'controlled') {
      const m = await db.medicine.create({
        data: {
          productName: 'Synthetic ' + kind,
          productFamily: kind === 'otc' ? 'FRONT_SHOP' : 'PHARMACEUTICAL',
          rx: kind !== 'otc',
          controlled: kind === 'controlled',
          saleable: true,
          presentations: { create: { presentation: 'Strip' } },
        },
        include: { presentations: true },
      });
      const presentationId = m.presentations[0]!.id;
      const pack = await db.packLevel.create({
        data: {
          presentationId,
          versionGroupId: randomUUID(),
          version: 1,
          level: 'STRIP',
          unitsPerParent: 1,
          effectiveFrom: new Date('2020-01-01'),
        },
      });
      const expiry = new Date('2099-01-01');
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          medicineId: m.id,
          batchNumber: 'B-' + kind,
          expiresAt: expiry,
          expiryPrecision: 'DAY',
        },
      });
      const { lot } = await receiveLot(
        db,
        { organizationId: org, branchId, actorId: id('user_editor') },
        {
          manufacturingBatchId: batch.id,
          packLevelId: pack.id,
          stockLocationId: location.id,
          unitsPerPack: 1,
          supplierName: supplier.name,
          supplierInvoiceRef: 'SYN',
          unitCostMinor: 100,
          printedMrpMinor: 1000,
          receivedExpiresAt: expiry,
          receivedExpiryPrecision: 'DAY',
          quantityUnits: 100,
          idempotencyKey: randomUUID(),
          receivedAt: new Date('2020-01-02'),
        }
      );
      const rx = await db.prescription.create({
        data: {
          patientId: patient.id,
          prescriberId: prescriber.id,
          sourceKind: 'PAPER_IMAGE',
          sourceFileRef: 'synthetic',
          validFrom: new Date('2020-01-01'),
          validUntil: expiry,
          authorizedRepeats: 10,
          capturedByUserId: id('user_witness'),
          lines: {
            create: {
              lineNumber: 1,
              medicineId: m.id,
              presentationId,
              authorizedCanonicalUnits: 100,
              directions: 'Fixture',
            },
          },
        },
        include: { lines: true },
      });
      return {
        medicineId: m.id,
        presentationId,
        packLevelId: pack.id,
        lotId: lot.id,
        prescriptionLineId: rx.lines[0]!.id,
      };
    }
    return {
      supplier,
      location,
      patient,
      otc: await product('otc'),
      rx: await product('rx'),
      controlled: await product('controlled'),
    };
  });
  const rulesId = await seedPharmacyRegulatoryProfile(withPlatformDb, tenant, branchId);
  function context(person: Person) {
    const userId = id('user_' + person);
    return {
      db: createTenantDb(org, userId),
      entitlements: {
        organizationId: org,
        enabledModules: [...PHARMACY_MODULES.map((m) => m.key), 'hr'],
        modules: [],
        limits: {},
        seatLimit: 15,
        activeSeats: 7,
      },
      session: {
        expires: 'later',
        user: {
          id: userId,
          role: userRole(person),
          status: 'ACTIVE',
          department: 'LEADERSHIP',
          organizationId: org,
        },
      },
      organization: { id: org, vertical: 'PHARMACY', timezone: 'UTC' },
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext;
  }
  const as = (person: Person) =>
    api.createCaller(context(person), {
      onError: ({ error, path }) => {
        // Only the role under test can satisfy a refusal assertion. A failed setup,
        // witness signature, or cashier handoff must fail the scenario.
        if (person !== 'subject')
          throw new Error(person + ' could not complete ' + path, { cause: error });
      },
    });
  const staging = pharmacyStagedReviewRouter.createCaller(context('editor')).pharmacyMedicine;
  const businessDate = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const till = await as('cashier').pharmacySales.openDrawer({
    branchId,
    deviceId: id('main-till'),
    businessDate,
    openingFloatMinor: 0,
  });
  expect(till.branchId).toBe(branchId);
  const ctx = context('subject');
  const subjectRole = await ctx.db.organizationRole.findFirstOrThrow({
    where: { id: id(role) },
    include: { permissions: true },
  });
  function names(action: Action) {
    return decideFromRules(subjectRole.permissions, action) === true;
  }
  function holds(action: Action) {
    return can(subjectFromSession(ctx.session!.user), action, undefined, {
      db: ctx.db,
      source: 'TRPC',
    });
  }
  return {
    branchId,
    closeBranchId,
    tenant,
    id,
    as,
    staging,
    role,
    ...stock,
    rulesId,
    businessDate,
    names,
    holds,
  };
}
export type PharmacyFixture = Awaited<ReturnType<typeof setupRole>>;
