/**
 * PH-POS counter E2E seed.
 *
 * Builds one PHARMACY workspace the browser spec can complete real bills in:
 * a licensed package, an administrator who can sign in, a branch with a store
 * location, three medicines that between them exercise every POS-02 search
 * path and both shapes of the POS-03 toggle, received stock, and a captured
 * prescription for the POS-09 panel.
 *
 * Idempotent, but NOT uniformly by upsert. Much of the pharmacy schema is
 * append-only or projection-only, and the triggers enforce it:
 *
 *   - pack levels, printed MRPs, barcodes, aliases, prescriptions,
 *     prescription lines and patient consents refuse UPDATE, so those writes
 *     are create-if-absent;
 *   - `pharmacy_stock_balances` refuses INSERT, UPDATE and DELETE outright — it
 *     is a projection of the movement ledger — so stock is seeded by calling
 *     the real INV-01 `receiveLot` rather than by writing a balance.
 *
 * Runs as the NOSUPERUSER/NOBYPASSRLS runtime role, so every insert here also
 * proves the RLS policies admit a legitimate tenant write.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { hashSync } from 'bcryptjs';
import 'dotenv/config';
import pg from 'pg';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { moduleDefinitionForKey } from '../src/lib/module-catalog.js';
import { normalizeMedicineText } from '../src/lib/pharmacy/medicine.js';
import { breakPack, receiveLot } from '../src/lib/pharmacy/stock-ledger.js';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db.js';
import { PHARMACY_E2E } from '../tests/e2e/pharmacy-counter-fixture.js';
import { resolvePharmacyE2eDatabaseUrl } from './pharmacy-e2e-environment.js';

const PHARMACY_E2E_ADMIN_CAPABILITIES = [
  // #518: POS-09 adds a prescription-only line, which now needs the exact dispense grant.
  'pharmacy:dispense',
  'pharmacy:counter',
  'pharmacy:manage',
  'pharmacy:procurement',
  'pharmacy:inventory',
  'pharmacy:orders',
  'reports:operational',
  'reports:financial',
] as const;

/**
 * Staging demo only: the sensitive pharmacy capabilities that wildcards no longer confer
 * (capabilityMatches('*' | 'pharmacy:*', these) === false). The demo Owner/Admin needs them to
 * dispense, run safety actions, review the catalogue and (at the khataScope gate, which asks for
 * pharmacy:dispense until #300 lands) use Khata at the counter. Never granted to the cashier.
 */
const STAGING_DEMO_ADMIN_SENSITIVE_CAPABILITIES = [
  'pharmacy:dispense',
  'pharmacy:safety',
  'pharmacy:catalogue-review',
] as const;

const FIXED_AT = new Date('2026-09-01T00:00:00.000Z');
/** Received well in the past, so nothing is blocked as UNRECEIVED. */
const RECEIVED_AT = new Date('2026-08-01T00:00:00.000Z');
/** Far enough out that no batch is near-expiry noise in the spec. */
const EXPIRES_AT = new Date('2028-06-30T00:00:00.000Z');

const MODULES = [
  'hr',
  'pharmacy-procurement',
  'pharmacy-core',
  'pharmacy-counter',
  'pharmacy-inventory',
  'pharmacy-dispensing',
  'pharmacy-safety',
] as const;

const databaseUrl = resolvePharmacyE2eDatabaseUrl();
const pool = new pg.Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function asPlatform(run: (tx: Tx) => Promise<void>) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.is_platform_admin', 'true', true), set_config('app.current_organization_id', '', true)`
    );
    await run(tx);
  });
}

async function asTenant(run: (tx: Tx) => Promise<void>) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.is_platform_admin', 'false', true), set_config('app.current_organization_id', $1, true)`,
      PHARMACY_E2E.organizationId
    );
    await run(tx);
  });
}

async function seedCatalog() {
  await asPlatform(async (tx) => {
    await tx.platformPackage.upsert({
      where: { id: PHARMACY_E2E.packageId },
      update: {
        key: 'pharmacy-counter-e2e',
        name: 'Pharmacy Counter E2E',
        vertical: 'PHARMACY',
        active: true,
      },
      create: {
        id: PHARMACY_E2E.packageId,
        key: 'pharmacy-counter-e2e',
        name: 'Pharmacy Counter E2E',
        vertical: 'PHARMACY',
        active: true,
        defaultSeats: 10,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    for (const key of MODULES) {
      // Read the registry facts from the catalog so this fixture can never
      // register a module row the application disagrees with.
      const definition = moduleDefinitionForKey(key);
      if (!definition) throw new Error(`Unknown module key: ${key}`);
      const module = await tx.platformModule.upsert({
        where: { key },
        update: {
          name: definition.name,
          category: definition.category,
          routePrefix: definition.routePrefix,
          active: true,
        },
        create: {
          id: `module_pharmacy_counter_e2e_${key}`,
          key,
          name: definition.name,
          category: definition.category,
          routePrefix: definition.routePrefix,
          band: definition.band,
          vertical: definition.vertical,
          active: true,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });
      await tx.platformPackageModule.upsert({
        where: {
          packageId_moduleId: { packageId: PHARMACY_E2E.packageId, moduleId: module.id },
        },
        update: { enabled: true },
        create: {
          id: `package_module_pharmacy_counter_e2e_${key}`,
          packageId: PHARMACY_E2E.packageId,
          moduleId: module.id,
          enabled: true,
        },
      });
    }
  });
}

async function seedWorkspace(email: string, passwordHash: string) {
  await asPlatform(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_organization_id', $1, true)`,
      PHARMACY_E2E.organizationId
    );
    const organization = {
      slug: 'pharmacy-counter-e2e',
      legalName: 'Fathom Pharmacy E2E',
      displayName: 'Fathom Pharmacy E2E',
      vertical: 'PHARMACY' as const,
      status: 'ACTIVE' as const,
      packageId: PHARMACY_E2E.packageId,
      timezone: 'Asia/Karachi',
      currency: 'PKR',
      seatLimit: 10,
      activatedAt: FIXED_AT,
    };
    await tx.organization.upsert({
      where: { id: PHARMACY_E2E.organizationId },
      update: organization,
      create: {
        id: PHARMACY_E2E.organizationId,
        ...organization,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    await tx.organizationDepartment.upsert({
      where: {
        organizationId_key: { organizationId: PHARMACY_E2E.organizationId, key: 'LEADERSHIP' },
      },
      update: { name: 'Leadership', active: true, sortOrder: 0 },
      create: {
        id: `department_${PHARMACY_E2E.organizationId}_leadership`,
        organizationId: PHARMACY_E2E.organizationId,
        key: 'LEADERSHIP',
        name: 'Leadership',
        sortOrder: 0,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    await tx.organizationRole.upsert({
      where: { id: PHARMACY_E2E.roleId },
      update: { key: 'administrator', name: 'Administrator', isSystem: true },
      create: {
        id: PHARMACY_E2E.roleId,
        organizationId: PHARMACY_E2E.organizationId,
        key: 'administrator',
        name: 'Administrator',
        isSystem: true,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    // The administrator role gets explicit, non-sensitive grants only (never `*`). The counter's
    // receipt guard asks the organization role for a capability before it honours a session
    // ADMIN, so without pharmacy:counter the admin the spec signs in as cannot read the bill it
    // is selling. pharmacy:dispense is granted because POS-09 adds a prescription-only line,
    // which #518 restricts to the exact grant; pharmacy:safety and pharmacy:catalogue-review are
    // deliberately absent: the counter spec exercises neither.
    for (const capability of PHARMACY_E2E_ADMIN_CAPABILITIES) {
      await tx.organizationRolePermission.upsert({
        where: {
          organizationRoleId_capability: { organizationRoleId: PHARMACY_E2E.roleId, capability },
        },
        update: { effect: 'ALLOW' },
        create: {
          organizationId: PHARMACY_E2E.organizationId,
          organizationRoleId: PHARMACY_E2E.roleId,
          capability,
          effect: 'ALLOW',
        },
      });
    }
    // Remove a `*` grant left by an earlier run of this seed.
    await tx.organizationRolePermission.deleteMany({
      where: { organizationRoleId: PHARMACY_E2E.roleId, capability: '*' },
    });
    const user = {
      organizationId: PHARMACY_E2E.organizationId,
      organizationRoleId: PHARMACY_E2E.roleId,
      name: 'Counter Gate Admin',
      email,
      password: passwordHash,
      role: 'ADMIN' as const,
      department: 'LEADERSHIP',
      title: 'Pharmacy Administrator',
      status: 'ACTIVE' as const,
    };
    await tx.user.upsert({
      where: { id: PHARMACY_E2E.adminId },
      update: user,
      create: { id: PHARMACY_E2E.adminId, ...user, createdAt: FIXED_AT, updatedAt: FIXED_AT },
    });
  });
}

/**
 * DEV-645: refunds need the signed-in manager/owner's own PIN. The browser spec refunds as the
 * administrator, so the E2E workspace gives that account a staff PIN. Not seeded for the staging
 * demo: its owner sets their own PIN.
 */
async function seedAdminRefundPin() {
  await asTenant(async (tx) => {
    await tx.restaurantStaffProfile.upsert({
      where: { id: PHARMACY_E2E.adminStaffProfileId },
      update: { userId: PHARMACY_E2E.adminId, status: 'ACTIVE' },
      create: {
        id: PHARMACY_E2E.adminStaffProfileId,
        organizationId: PHARMACY_E2E.organizationId,
        userId: PHARMACY_E2E.adminId,
        displayName: 'Counter Gate Admin',
        status: 'ACTIVE',
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    const credential = {
      staffProfileId: PHARMACY_E2E.adminStaffProfileId,
      type: 'PIN' as const,
      credentialHash: hashSync(PHARMACY_E2E.adminRefundPin, 10),
      failedAttempts: 0,
      lockedUntil: null,
      revokedAt: null,
      deviceId: null,
    };
    await tx.restaurantOperatorCredential.upsert({
      where: { id: PHARMACY_E2E.adminPinCredentialId },
      update: credential,
      create: {
        id: PHARMACY_E2E.adminPinCredentialId,
        organizationId: PHARMACY_E2E.organizationId,
        ...credential,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
  });
}

async function seedBranch() {
  await asTenant(async (tx) => {
    const branch = {
      organizationId: PHARMACY_E2E.organizationId,
      code: PHARMACY_E2E.branchCode,
      name: PHARMACY_E2E.branchName,
      addressLine: '12 Main Boulevard',
      city: 'Lahore',
      provinceCode: 'PB',
      active: true,
    };
    await tx.pharmacyBranch.upsert({
      where: { id: PHARMACY_E2E.branchId },
      update: branch,
      create: {
        id: PHARMACY_E2E.branchId,
        ...branch,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });

    for (const [id, code, name, kind] of [
      [PHARMACY_E2E.stockLocationId, PHARMACY_E2E.stockLocationCode, 'Front store', 'STORE'],
      [PHARMACY_E2E.quarantineLocationId, 'QUAR-1', 'Quarantine shelf', 'QUARANTINE'],
    ] as const) {
      const location = {
        organizationId: PHARMACY_E2E.organizationId,
        branchId: PHARMACY_E2E.branchId,
        code,
        name,
        kind,
        coldChain: false,
        active: true,
      };
      await tx.pharmacyStockLocation.upsert({
        where: { id },
        update: location,
        create: { id, ...location, createdAt: FIXED_AT, updatedAt: FIXED_AT },
      });
    }

    // Set only after the location exists: the composite FK on
    // (organizationId, id, defaultStockLocationId) constrains it to a location
    // of THIS branch.
    await tx.pharmacyBranch.update({
      where: { id: PHARMACY_E2E.branchId },
      data: { defaultStockLocationId: PHARMACY_E2E.stockLocationId },
    });
  });
}

/** Demo cashier for the counter. Assigned to the seeded branch so receipt reads are not empty-set denies. */
/** Idempotent ALLOW top-up for the demo administrator role. Staging demo only. */
async function seedStagingDemoSensitiveGrants() {
  await asTenant(async (tx) => {
    const role = await tx.organizationRole.findFirst({
      where: { id: PHARMACY_E2E.roleId, organizationId: PHARMACY_E2E.organizationId },
      select: { id: true },
    });
    if (!role)
      throw new Error('Demo pharmacy administrator role not found; run the full seed first.');
    for (const capability of STAGING_DEMO_ADMIN_SENSITIVE_CAPABILITIES) {
      await tx.organizationRolePermission.upsert({
        where: { organizationRoleId_capability: { organizationRoleId: role.id, capability } },
        update: { effect: 'ALLOW' },
        create: {
          organizationId: PHARMACY_E2E.organizationId,
          organizationRoleId: role.id,
          capability,
          effect: 'ALLOW',
        },
      });
    }
  });
  console.log(
    `Staging demo admin grants ensured: ${STAGING_DEMO_ADMIN_SENSITIVE_CAPABILITIES.join(', ')}.`
  );
}

/** Staging demo only: a Pharmacist (dispense + catalogue review, explicit grants; never `*`). */
const STAGING_DEMO_PHARMACIST = {
  roleId: 'role_pharmacy_counter_e2e_pharmacist',
  userId: 'user_pharmacy_counter_e2e_pharmacist',
  email: 'pharmacist.counter@pharmacy-counter-e2e.devfathom.invalid',
  assignmentId: 'pba_pharmacy_counter_e2e_pharmacist',
  capabilities: ['pharmacy:dispense', 'pharmacy:catalogue-review'] as const,
};

async function seedStagingDemoPharmacist(
  passwordHash: string,
  opts: { keepExistingPassword?: boolean } = {}
) {
  await asTenant(async (tx) => {
    const role = await tx.organizationRole.upsert({
      where: {
        organizationId_key: { organizationId: PHARMACY_E2E.organizationId, key: 'pharmacist' },
      },
      update: { name: 'Pharmacist', isSystem: true },
      create: {
        id: STAGING_DEMO_PHARMACIST.roleId,
        organizationId: PHARMACY_E2E.organizationId,
        key: 'pharmacist',
        name: 'Pharmacist',
        isSystem: true,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    for (const capability of STAGING_DEMO_PHARMACIST.capabilities) {
      await tx.organizationRolePermission.upsert({
        where: { organizationRoleId_capability: { organizationRoleId: role.id, capability } },
        update: { effect: 'ALLOW' },
        create: {
          organizationId: PHARMACY_E2E.organizationId,
          organizationRoleId: role.id,
          capability,
          effect: 'ALLOW',
        },
      });
    }
    // Never a wildcard on the pharmacist role.
    await tx.organizationRolePermission.deleteMany({
      where: { organizationRoleId: role.id, capability: { in: ['*', 'pharmacy:*'] } },
    });
    const user = {
      organizationId: PHARMACY_E2E.organizationId,
      organizationRoleId: role.id,
      name: 'Demo Pharmacist',
      email: STAGING_DEMO_PHARMACIST.email,
      password: passwordHash,
      role: 'EMPLOYEE' as const,
      department: 'LEADERSHIP',
      title: 'Pharmacist',
      status: 'ACTIVE' as const,
    };
    await tx.user.upsert({
      where: { id: STAGING_DEMO_PHARMACIST.userId },
      // Grants-only top-ups never rotate an existing login's password.
      update: opts.keepExistingPassword ? (({ password: _password, ...rest }) => rest)(user) : user,
      create: {
        id: STAGING_DEMO_PHARMACIST.userId,
        ...user,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    await tx.pharmacyBranchAssignment.upsert({
      where: {
        organizationId_branchId_userId: {
          organizationId: PHARMACY_E2E.organizationId,
          branchId: PHARMACY_E2E.branchId,
          userId: STAGING_DEMO_PHARMACIST.userId,
        },
      },
      update: { active: true },
      create: {
        id: STAGING_DEMO_PHARMACIST.assignmentId,
        organizationId: PHARMACY_E2E.organizationId,
        branchId: PHARMACY_E2E.branchId,
        userId: STAGING_DEMO_PHARMACIST.userId,
        active: true,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
  });
  console.log(`Staging demo pharmacist ensured: ${STAGING_DEMO_PHARMACIST.email}.`);
}

async function seedCashier(passwordHash: string) {
  await asTenant(async (tx) => {
    const role = await tx.organizationRole.upsert({
      where: {
        organizationId_key: {
          organizationId: PHARMACY_E2E.organizationId,
          key: 'cashier',
        },
      },
      update: { name: 'Cashier', isSystem: true },
      create: {
        id: PHARMACY_E2E.cashierRoleId,
        organizationId: PHARMACY_E2E.organizationId,
        key: 'cashier',
        name: 'Cashier',
        isSystem: true,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    // Repair workspaces created by the seed before the counter capability was canonicalized.
    await tx.organizationRolePermission.deleteMany({
      where: { organizationRoleId: role.id, capability: 'pharmacy.counter' },
    });
    // Canonical grants, as #163's migration leaves real cashiers and the Cashier template gives
    // new ones.
    for (const [id, capability] of [
      [PHARMACY_E2E.cashierCounterPermissionId, 'pharmacy:counter'],
      [PHARMACY_E2E.cashierOrdersPermissionId, 'pharmacy:orders'],
    ] as const) {
      const existing = await tx.organizationRolePermission.findFirst({
        where: { organizationRoleId: role.id, capability },
        select: { id: true },
      });
      if (!existing) {
        await tx.organizationRolePermission.create({
          data: {
            id,
            organizationId: PHARMACY_E2E.organizationId,
            organizationRoleId: role.id,
            capability,
            effect: 'ALLOW',
            createdAt: FIXED_AT,
          },
        });
      }
    }
    const user = {
      organizationId: PHARMACY_E2E.organizationId,
      organizationRoleId: role.id,
      name: 'Counter Gate Cashier',
      email: PHARMACY_E2E.cashierEmail,
      password: passwordHash,
      role: 'EMPLOYEE' as const,
      department: 'LEADERSHIP',
      title: 'Cashier',
      status: 'ACTIVE' as const,
    };
    await tx.user.upsert({
      where: { id: PHARMACY_E2E.cashierId },
      update: user,
      create: { id: PHARMACY_E2E.cashierId, ...user, createdAt: FIXED_AT, updatedAt: FIXED_AT },
    });
    await tx.pharmacyBranchAssignment.upsert({
      where: {
        organizationId_branchId_userId: {
          organizationId: PHARMACY_E2E.organizationId,
          branchId: PHARMACY_E2E.branchId,
          userId: PHARMACY_E2E.cashierId,
        },
      },
      update: { active: true },
      create: {
        id: PHARMACY_E2E.cashierAssignmentId,
        organizationId: PHARMACY_E2E.organizationId,
        branchId: PHARMACY_E2E.branchId,
        userId: PHARMACY_E2E.cashierId,
        active: true,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
  });
}

type MedicineSeed = {
  id: string;
  name: string;
  brandName?: string;
  strength: string;
  presentationId: string;
  presentation: string;
  dosageForm: string;
  rx: boolean;
  packLevels: Array<{ id: string; level: 'BOX' | 'STRIP' | 'UNIT'; unitsPerParent: number }>;
  barcode?: string;
  alias?: string;
  batchId: string;
  batchNumber: string;
  unitsPerPack: number;
  printedMrpMinor: number;
  onHandUnits: number;
};

function medicineSeeds(): MedicineSeed[] {
  const { otc, syrup, rx } = PHARMACY_E2E.medicines;
  return [
    {
      id: otc.id,
      name: otc.name,
      brandName: otc.brandName,
      strength: otc.strength,
      presentationId: otc.presentationId,
      presentation: otc.presentation,
      dosageForm: 'Tablet',
      rx: false,
      packLevels: [
        { id: otc.packLevelIds.box, level: 'BOX', unitsPerParent: 1 },
        { id: otc.packLevelIds.strip, level: 'STRIP', unitsPerParent: 10 },
        { id: otc.packLevelIds.unit, level: 'UNIT', unitsPerParent: 10 },
      ],
      barcode: otc.barcode,
      alias: otc.alias,
      batchId: otc.batchId,
      batchNumber: otc.batchNumber,
      unitsPerPack: otc.unitsPerPack,
      printedMrpMinor: otc.printedMrpMinor,
      onHandUnits: otc.onHandUnits,
    },
    {
      id: syrup.id,
      name: syrup.name,
      strength: syrup.strength,
      presentationId: syrup.presentationId,
      presentation: syrup.presentation,
      dosageForm: 'Syrup',
      rx: false,
      // No strip level: the toggle must offer PACK and UNIT only.
      packLevels: [
        { id: syrup.packLevelIds.bottle, level: 'BOX', unitsPerParent: 1 },
        { id: syrup.packLevelIds.unit, level: 'UNIT', unitsPerParent: 60 },
      ],
      batchId: syrup.batchId,
      batchNumber: syrup.batchNumber,
      unitsPerPack: syrup.unitsPerPack,
      printedMrpMinor: syrup.printedMrpMinor,
      onHandUnits: syrup.onHandUnits,
    },
    {
      id: rx.id,
      name: rx.name,
      strength: rx.strength,
      presentationId: rx.presentationId,
      presentation: rx.presentation,
      dosageForm: 'Capsule',
      rx: true,
      packLevels: [
        { id: rx.packLevelIds.box, level: 'BOX', unitsPerParent: 1 },
        { id: rx.packLevelIds.strip, level: 'STRIP', unitsPerParent: 8 },
        { id: rx.packLevelIds.unit, level: 'UNIT', unitsPerParent: 10 },
      ],
      batchId: rx.batchId,
      batchNumber: rx.batchNumber,
      unitsPerPack: rx.unitsPerPack,
      printedMrpMinor: rx.printedMrpMinor,
      onHandUnits: rx.onHandUnits,
    },
  ];
}

async function seedMedicines() {
  await asTenant(async (tx) => {
    await tx.ingredient.upsert({
      where: { id: PHARMACY_E2E.ingredientId },
      update: { name: 'Paracetamol E2E' },
      create: {
        id: PHARMACY_E2E.ingredientId,
        organizationId: PHARMACY_E2E.organizationId,
        name: 'Paracetamol E2E',
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });

    for (const seed of medicineSeeds()) {
      const medicine = {
        organizationId: PHARMACY_E2E.organizationId,
        productName: seed.name,
        brandName: seed.brandName ?? null,
        manufacturer: 'Fathom Labs E2E',
        drapRegistrationNumber: `DRAP-${seed.batchNumber}`,
        drapRegistrationStatus: 'REGISTERED',
        productFamily: 'PHARMACEUTICAL' as const,
        rx: seed.rx,
        otc: !seed.rx,
        restricted: false,
        controlled: false,
        highAlert: false,
        lasa: false,
        coldChain: false,
        saleable: true,
      };
      await tx.medicine.upsert({
        where: { id: seed.id },
        update: medicine,
        create: { id: seed.id, ...medicine, createdAt: FIXED_AT, updatedAt: FIXED_AT },
      });

      const [value, unit] = seed.strength.split(' ');
      await tx.medicineStrengthComponent.upsert({
        where: {
          medicineId_ingredientId_value_unit: {
            medicineId: seed.id,
            ingredientId: PHARMACY_E2E.ingredientId,
            value: value!,
            unit: unit!,
          },
        },
        update: {},
        create: {
          id: `strength_${seed.id}`,
          organizationId: PHARMACY_E2E.organizationId,
          medicineId: seed.id,
          ingredientId: PHARMACY_E2E.ingredientId,
          value: value!,
          unit: unit!,
          createdAt: FIXED_AT,
        },
      });

      const presentation = {
        organizationId: PHARMACY_E2E.organizationId,
        medicineId: seed.id,
        dosageForm: seed.dosageForm,
        route: 'Oral',
        presentation: seed.presentation,
      };
      await tx.presentation.upsert({
        where: { id: seed.presentationId },
        update: presentation,
        create: {
          id: seed.presentationId,
          ...presentation,
          createdAt: FIXED_AT,
          updatedAt: FIXED_AT,
        },
      });

      // MED-02 pack levels are conversion-immutable, and the MRP, barcode and
      // alias tables are append-only. None of them may be UPDATEd, so every
      // write below is create-if-absent rather than an upsert.
      let parentPackLevelId: string | null = null;
      for (const level of seed.packLevels) {
        if (!(await tx.packLevel.findFirst({ where: { id: level.id }, select: { id: true } }))) {
          await tx.packLevel.create({
            data: {
              id: level.id,
              organizationId: PHARMACY_E2E.organizationId,
              presentationId: seed.presentationId,
              parentPackLevelId,
              versionGroupId: `version_group_${level.id}`,
              version: 1,
              level: level.level,
              unitsPerParent: level.unitsPerParent,
              effectiveFrom: FIXED_AT,
              // `referencedAt` is stamped by the receiving trigger, not here.
              createdAt: FIXED_AT,
            },
          });
        }
        parentPackLevelId = level.id;
      }

      const rootPackLevelId = seed.packLevels[0]!.id;
      if (
        !(await tx.medicinePackMrp.findFirst({
          where: {
            organizationId: PHARMACY_E2E.organizationId,
            packLevelId: rootPackLevelId,
            batchReference: seed.batchNumber,
          },
          select: { id: true },
        }))
      ) {
        await tx.medicinePackMrp.create({
          data: {
            id: `mrp_${seed.id}`,
            organizationId: PHARMACY_E2E.organizationId,
            packLevelId: rootPackLevelId,
            batchReference: seed.batchNumber,
            printedMrpMinor: seed.printedMrpMinor,
            roundingIncrementMinor: 1,
            createdAt: FIXED_AT,
          },
        });
      }

      if (
        seed.barcode &&
        !(await tx.medicineBarcode.findFirst({
          where: { id: `barcode_${seed.id}` },
          select: { id: true },
        }))
      ) {
        await tx.medicineBarcode.create({
          data: {
            id: `barcode_${seed.id}`,
            organizationId: PHARMACY_E2E.organizationId,
            presentationId: seed.presentationId,
            packLevelId: rootPackLevelId,
            type: 'GTIN',
            code: seed.barcode,
            normalizedCode: normalizeMedicineText(seed.barcode),
            createdAt: FIXED_AT,
          },
        });
      }

      if (
        seed.alias &&
        !(await tx.medicineAlias.findFirst({
          where: { id: `alias_${seed.id}` },
          select: { id: true },
        }))
      ) {
        await tx.medicineAlias.create({
          data: {
            id: `alias_${seed.id}`,
            organizationId: PHARMACY_E2E.organizationId,
            medicineId: seed.id,
            type: 'TRANSLITERATION',
            value: seed.alias,
            normalizedValue: normalizeMedicineText(seed.alias),
            createdAt: FIXED_AT,
          },
        });
      }
    }
  });
}

/**
 * Stock, posted the way stock actually arrives.
 *
 * `pharmacy_stock_balances` is a PROJECTION: its trigger refuses a direct
 * insert, update or delete, so a balance can only exist because a movement was
 * posted. The seed therefore calls the real INV-01 `receiveLot`, which creates
 * the lot, posts the RECEIPT movement, and lets the projection derive the
 * on-hand figure the counter reads.
 */
async function seedStock() {
  const scope = {
    organizationId: PHARMACY_E2E.organizationId,
    branchId: PHARMACY_E2E.branchId,
    actorId: PHARMACY_E2E.adminId,
  };
  for (const seed of medicineSeeds()) {
    await asTenant(async (tx) => {
      const batch = {
        organizationId: PHARMACY_E2E.organizationId,
        medicineId: seed.id,
        batchNumber: seed.batchNumber,
        expiresAt: EXPIRES_AT,
        expiryPrecision: 'DAY' as const,
        state: 'ACTIVE' as const,
      };
      await tx.pharmacyManufacturingBatch.upsert({
        where: { id: seed.batchId },
        update: batch,
        create: { id: seed.batchId, ...batch, createdAt: FIXED_AT, updatedAt: FIXED_AT },
      });

      const supplierInvoiceRef = `INV-${seed.batchNumber}`;
      // Idempotence key for the whole receipt: the lot is unique on
      // (organization, supplier, invoice, batch), so a second seed pass finds
      // the lot already received and posts nothing further.
      const existing = await tx.pharmacyInventoryLot.findFirst({
        where: {
          organizationId: PHARMACY_E2E.organizationId,
          supplierName: 'Fathom Distributors E2E',
          supplierInvoiceRef,
          manufacturingBatchId: seed.batchId,
        },
        select: { id: true },
      });
      if (existing) return;

      const { lot } = await receiveLot(tx as unknown as ScopedDb, scope, {
        manufacturingBatchId: seed.batchId,
        packLevelId: seed.packLevels[0]!.id,
        stockLocationId: PHARMACY_E2E.stockLocationId,
        unitsPerPack: seed.unitsPerPack,
        supplierName: 'Fathom Distributors E2E',
        supplierInvoiceRef,
        unitCostMinor: Math.floor(seed.printedMrpMinor / seed.unitsPerPack / 2),
        printedMrpMinor: seed.printedMrpMinor,
        receivedExpiresAt: EXPIRES_AT,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: seed.onHandUnits,
        idempotencyKey: `pharmacy-counter-e2e-receipt-${seed.batchNumber}`,
        receivedAt: RECEIVED_AT,
      });

      // A received lot is entirely sealed packs. INV-04 refuses a sale that
      // would break one — breaking a pack is its own movement — so a counter
      // stocked only with sealed packs cannot sell a strip or a loose unit at
      // all, which is not the shelf a real pharmacy dispenses from.
      //
      // Two packs are opened, not one, and the arithmetic is the reason. A sale
      // draws LOOSE units first and then refuses unless the remainder is a whole
      // number of packs (`stock-ledger.postSaleMovements`). With a single pack
      // open, the strip bill leaves 80 loose units behind, and the whole-pack
      // bill that follows would need 80 loose + 20 sealed — not a whole pack, so
      // INV-04 refuses it. Opening a second pack keeps the loose pool larger
      // than one pack, so the pack bill is served from opened stock, which is
      // exactly how a counter dispenses: the open box goes out before a sealed
      // one is touched.
      //
      // Idempotent by construction: `breakPack` breaks only until the required
      // loose units exist, so the second seed pass is a no-op.
      await breakPack(tx as unknown as ScopedDb, scope, {
        inventoryLotId: lot.id,
        stockLocationId: PHARMACY_E2E.stockLocationId,
        requiredLooseUnits: seed.unitsPerPack * 2,
        idempotencyKey: `pharmacy-counter-e2e-break-${seed.batchNumber}`,
        at: RECEIVED_AT,
      });
    });
  }
}

async function seedPrescription() {
  const rx = PHARMACY_E2E.medicines.rx;
  await asTenant(async (tx) => {
    await tx.pharmacyPatient.upsert({
      where: { id: PHARMACY_E2E.patientId },
      update: { displayName: PHARMACY_E2E.patientName },
      create: {
        id: PHARMACY_E2E.patientId,
        organizationId: PHARMACY_E2E.organizationId,
        displayName: PHARMACY_E2E.patientName,
        cnic: '3520112345678',
        phone: '03001234567',
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    // RX-01 consent is append-only and versioned: an existing consent may never
    // be rewritten, only superseded by a later version.
    if (
      !(await tx.patientConsent.findFirst({
        where: { id: `consent_${PHARMACY_E2E.patientId}` },
        select: { id: true },
      }))
    ) {
      await tx.patientConsent.create({
        data: {
          id: `consent_${PHARMACY_E2E.patientId}`,
          organizationId: PHARMACY_E2E.organizationId,
          patientId: PHARMACY_E2E.patientId,
          purpose: 'DISPENSING',
          channel: 'IN_PERSON',
          version: 1,
          granted: true,
          recordedByUserId: PHARMACY_E2E.adminId,
          recordedAt: FIXED_AT,
        },
      });
    }
    await tx.pharmacyPrescriber.upsert({
      where: { id: PHARMACY_E2E.prescriberId },
      update: { name: 'Dr Imran Shah E2E', registrationNumber: 'PMC-E2E-1' },
      create: {
        id: PHARMACY_E2E.prescriberId,
        organizationId: PHARMACY_E2E.organizationId,
        name: 'Dr Imran Shah E2E',
        registrationNumber: 'PMC-E2E-1',
        createdAt: FIXED_AT,
      },
    });

    // RX-02 prescriptions and their lines are append-only: a captured
    // authorization is evidence, so it is created once and never rewritten.
    if (
      !(await tx.prescription.findFirst({
        where: { id: PHARMACY_E2E.prescriptionId },
        select: { id: true },
      }))
    ) {
      await tx.prescription.create({
        data: {
          id: PHARMACY_E2E.prescriptionId,
          organizationId: PHARMACY_E2E.organizationId,
          patientId: PHARMACY_E2E.patientId,
          prescriberId: PHARMACY_E2E.prescriberId,
          sourceKind: 'PAPER_IMAGE',
          sourceFileRef: 'seed://pharmacy-counter-e2e/prescription.jpg',
          custodyState: 'HELD_AT_PHARMACY',
          validFrom: FIXED_AT,
          validUntil: new Date('2027-09-01T00:00:00.000Z'),
          authorizedRepeats: 2,
          capturedByUserId: PHARMACY_E2E.adminId,
          capturedAt: FIXED_AT,
        },
      });
    }

    if (
      !(await tx.prescriptionLine.findFirst({
        where: { id: rx.prescriptionLineId },
        select: { id: true },
      }))
    ) {
      await tx.prescriptionLine.create({
        data: {
          id: rx.prescriptionLineId,
          organizationId: PHARMACY_E2E.organizationId,
          prescriptionId: PHARMACY_E2E.prescriptionId,
          lineNumber: 1,
          medicineId: rx.id,
          presentationId: rx.presentationId,
          authorizedCanonicalUnits: 80,
          directions: 'One capsule twice daily for five days.',
          createdAt: FIXED_AT,
        },
      });
    }
  });
}

async function main() {
  try {
    const [role] = await prisma.$queryRaw<
      Array<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (!role?.rolcanlogin || role.rolsuper || role.rolbypassrls) {
      throw new Error('Pharmacy E2E seed requires LOGIN NOSUPERUSER NOBYPASSRLS.');
    }

    const stagingDemo = process.env.STAGING_DEMO_SEED === '1';
    if (process.env.PHARMACY_E2E_GRANTS_ONLY === '1') {
      if (!stagingDemo) throw new Error('PHARMACY_E2E_GRANTS_ONLY is staging-demo only.');
      await seedStagingDemoSensitiveGrants();
      const pw = process.env.PHARMACY_E2E_ADMIN_PASSWORD?.trim();
      if (!pw) throw new Error('PHARMACY_E2E_ADMIN_PASSWORD is required for the demo pharmacist.');
      await seedStagingDemoPharmacist(hashSync(pw, 10), { keepExistingPassword: true });
      return;
    }

    const email = process.env.PHARMACY_E2E_ADMIN_EMAIL!.trim().toLowerCase();
    const passwordHash = hashSync(process.env.PHARMACY_E2E_ADMIN_PASSWORD!, 10);

    await seedCatalog();
    await seedWorkspace(email, passwordHash);
    await seedBranch();
    await seedCashier(passwordHash);
    await seedMedicines();
    await seedStock();
    await seedPrescription();
    if (stagingDemo) {
      await seedStagingDemoSensitiveGrants();
      await seedStagingDemoPharmacist(passwordHash);
    } else {
      await seedAdminRefundPin();
    }

    console.log('Pharmacy counter E2E seed complete.');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
