import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import { syncPlatformCatalog } from '../../prisma/catalog-sync.js';
import { FIXTURE } from './pharmacy-purchasing-fixture';

/**
 * WHA-1196 — the fixture the PH-PUR browser acceptance walks.
 *
 * It provisions exactly what PRD §6.3 requires to exist *before* a goods
 * receipt is legal, and no more: a licensed organization, two people (because
 * PUR-02 refuses self-approval), a branch with a shelf and a quarantine
 * location, a medicine with an effective pack conversion, an authorized
 * supplier holding a verified unexpired licence, and one purchase order that
 * has been approved by the second person and sent.
 *
 * The order is deliberately left at SENT rather than part-received: the spec's
 * whole point is to walk PO → receive → exception → resolve → stock visible
 * through the surface, so nothing downstream of "sent" is seeded.
 *
 * Idempotent by construction — every write is an upsert on a natural key — so a
 * re-run against a warm database re-establishes the same starting state instead
 * of colliding on a unique constraint.
 */

const MODULES = [
  'pharmacy-core',
  'pharmacy-procurement',
  'pharmacy-inventory',
  'pharmacy-counter',
  'pharmacy-reports',
];

/**
 * Where the seed hands the spec the reference it just wrote. A file rather than
 * an environment variable because the seed and the Playwright run are separate
 * processes started by whoever runs the lane, and an env var they both happen
 * to agree on is a coordination bug waiting to happen.
 *
 * Deliberately NOT under the config's `outputDir`: Playwright wipes that
 * directory at the start of every run, which would delete the handle the seed
 * had just written.
 */
export const HANDLE_PATH = path.join(
  'playwright-artifacts',
  'pharmacy-purchasing-fixture',
  'fixture-handle.json'
);

/** Distinct per run, and sortable, so the newest order is obvious in the picker. */
const runStamp = () =>
  new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);

const day = (offsetDays: number) => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date;
};

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    // The catalog is control-plane RLS, and an unsynced catalog would leave
    // `pharmacy-procurement` absent — the module gate would then hide the whole
    // surface and the spec would fail for a reason that is not the product's.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await syncPlatformCatalog(tx);
    });

    const organizationId = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      const organization = await tx.organization.upsert({
        where: { slug: FIXTURE.organizationSlug },
        update: { vertical: 'PHARMACY', status: 'ACTIVE', pharmacyOperatingMode: 'STAFFED' },
        create: {
          slug: FIXTURE.organizationSlug,
          legalName: `${FIXTURE.organizationName} (Pvt) Ltd`,
          displayName: FIXTURE.organizationName,
          vertical: 'PHARMACY',
          status: 'ACTIVE',
          pharmacyOperatingMode: 'STAFFED',
          timezone: 'Asia/Karachi',
          currency: 'PKR',
          seatLimit: 10,
          activatedAt: day(-30),
        },
        select: { id: true },
      });

      const modules = await tx.platformModule.findMany({
        where: { key: { in: MODULES } },
        select: { id: true, key: true },
      });
      const missing = MODULES.filter((key) => !modules.some((module) => module.key === key));
      if (missing.length > 0) {
        throw new Error(`Catalog is missing ${missing.join(', ')} after a sync.`);
      }
      for (const module of modules) {
        await tx.organizationModule.upsert({
          where: {
            organizationId_moduleId: { organizationId: organization.id, moduleId: module.id },
          },
          update: { status: 'ENABLED', startsAt: day(-1), expiresAt: null },
          create: {
            organizationId: organization.id,
            moduleId: module.id,
            status: 'ENABLED',
            startsAt: day(-1),
          },
        });
      }
      return organization.id;
    });

    const purchaseOrderReference = `${FIXTURE.purchaseOrder.reference}-${runStamp()}`;

    // Everything below is tenant data, so it runs with the organization GUC set
    // and under the same forced RLS the application runs under.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_organization_id', '${organizationId}', true)`
      );

      // WHA-278: `User.department` is a composite foreign key onto the
      // organization's own department catalog, so the catalog has to exist
      // before any user row can be written.
      await tx.organizationDepartment.createMany({
        data: ['pharmacy', 'operations'].map((key, index) => ({
          organizationId,
          key,
          name: key === 'pharmacy' ? 'Pharmacy' : 'Operations',
          sortOrder: index,
        })),
        skipDuplicates: true,
      });

      const managerRole = await tx.organizationRole.upsert({
        where: { organizationId_key: { organizationId, key: 'manager' } },
        update: {},
        create: { organizationId, key: 'manager', name: 'Procurement manager', isSystem: true },
      });
      await tx.organizationRolePermission.upsert({
        where: {
          organizationRoleId_capability: {
            organizationRoleId: managerRole.id,
            capability: 'pharmacy:procurement',
          },
        },
        update: { effect: 'ALLOW' },
        create: {
          organizationId,
          organizationRoleId: managerRole.id,
          capability: 'pharmacy:procurement',
          effect: 'ALLOW',
        },
      });
      const passwordHash = await bcrypt.hash(FIXTURE.receiver.password, 10);
      const [receiver, approver] = await Promise.all(
        [FIXTURE.receiver, FIXTURE.approver].map((person, index) =>
          tx.user.upsert({
            where: { organizationId_email: { organizationId, email: person.email } },
            update: {
              status: 'ACTIVE',
              password: passwordHash,
              ...(index === 1 ? { organizationRoleId: managerRole.id } : {}),
            },
            create: {
              organizationId,
              email: person.email,
              name: person.name,
              password: passwordHash,
              department: 'pharmacy',
              title: index === 0 ? 'Receiving pharmacist' : 'Branch manager',
              // The receiver opens the console; the independent checker holds the live procurement grant.
              ...(index === 1 ? { organizationRoleId: managerRole.id } : {}),
              role: index === 0 ? 'ADMIN' : 'EMPLOYEE',
              status: 'ACTIVE',
            },
            select: { id: true },
          })
        )
      );

      const branch = await tx.pharmacyBranch.upsert({
        where: { organizationId_code: { organizationId, code: FIXTURE.branch.code } },
        update: { active: true },
        create: {
          organizationId,
          code: FIXTURE.branch.code,
          name: FIXTURE.branch.name,
          addressLine: '12 Zaibunnisa Street',
          city: FIXTURE.branch.city,
          provinceCode: 'SD',
          active: true,
        },
        select: { id: true },
      });

      for (const person of [receiver!, approver!]) {
        await tx.pharmacyBranchAssignment.upsert({
          where: {
            organizationId_branchId_userId: {
              organizationId,
              branchId: branch.id,
              userId: person.id,
            },
          },
          update: { active: true },
          create: { organizationId, branchId: branch.id, userId: person.id },
        });
      }

      const [shelf, quarantine] = await Promise.all(
        [
          { ...FIXTURE.shelf, kind: 'STORE' as const },
          { ...FIXTURE.quarantine, kind: 'QUARANTINE' as const },
        ].map((location) =>
          tx.pharmacyStockLocation.upsert({
            where: {
              organizationId_branchId_code: {
                organizationId,
                branchId: branch.id,
                code: location.code,
              },
            },
            update: { active: true },
            create: {
              organizationId,
              branchId: branch.id,
              code: location.code,
              name: location.name,
              kind: location.kind,
              active: true,
            },
            select: { id: true },
          })
        )
      );
      await tx.pharmacyBranch.update({
        where: { id: branch.id },
        data: { defaultStockLocationId: shelf!.id },
      });

      let medicine = await tx.medicine.findFirst({
        where: { organizationId, productName: FIXTURE.medicine.productName },
        select: { id: true, presentations: { select: { id: true } } },
      });
      if (!medicine) {
        medicine = await tx.medicine.create({
          data: {
            organizationId,
            productName: FIXTURE.medicine.productName,
            productFamily: 'PHARMACEUTICAL',
            saleable: true,
            presentations: {
              create: { organizationId, presentation: 'Capsule, 10 per strip' },
            },
          },
          select: { id: true, presentations: { select: { id: true } } },
        });
      }
      const presentationId = medicine.presentations[0]!.id;

      let packLevel = await tx.packLevel.findFirst({
        where: { organizationId, presentationId },
        select: { id: true },
      });
      if (!packLevel) {
        packLevel = await tx.packLevel.create({
          data: {
            organizationId,
            presentationId,
            versionGroupId: 'ph-pur-e2e-strip',
            version: 1,
            level: 'STRIP',
            unitsPerParent: FIXTURE.purchaseOrder.unitsPerPack,
            effectiveFrom: day(-30),
          },
          select: { id: true },
        });
      }

      const supplier = await tx.pharmacySupplier.upsert({
        where: { organizationId_name: { organizationId, name: FIXTURE.supplier.name } },
        update: { authorized: true, active: true },
        create: {
          organizationId,
          name: FIXTURE.supplier.name,
          legalName: 'Indus Pharma Distributors (Pvt) Ltd',
          authorized: true,
          active: true,
          serviceArea: 'Karachi South, Karachi East',
          contactName: 'Sana Iqbal',
          contactPhone: '021-3456789',
          paymentTermsDays: 30,
          creditLimitMinor: 5_000_00,
        },
        select: { id: true },
      });

      // PUR-01: authorization alone is not enough — the licence has to be
      // verified and unexpired, or every order and receipt below is refused.
      if (
        !(await tx.pharmacySupplierLicence.findFirst({
          where: { organizationId, supplierId: supplier.id },
          select: { id: true },
        }))
      ) {
        await tx.pharmacySupplierLicence.create({
          data: {
            organizationId,
            supplierId: supplier.id,
            licenceType: 'Drug sale licence',
            licenceNumber: 'DSL-KHI-2026-001',
            issuingAuthority: 'Drug Regulatory Authority of Pakistan',
            issuedAt: day(-200),
            expiresAt: day(400),
            verifiedAt: day(-199),
            verifiedByUserId: approver!.id,
          },
        });
      }

      // A run-unique order rather than a reused one. Receiving is cumulative by
      // design — the bench pre-fills the *outstanding* balance — so a second run
      // against a part-received order would see 30 units outstanding where the
      // first saw 100, and the spec would fail for a reason that is the fixture's
      // rather than the product's. The reference is handed to the spec below.
      {
        await tx.pharmacyPurchaseOrder.create({
          data: {
            organizationId,
            branchId: branch.id,
            reference: purchaseOrderReference,
            // Approved by the approver and sent, which is the only state a
            // receipt may be filed against.
            status: 'SENT',
            supplierId: supplier.id,
            createdByUserId: receiver!.id,
            approvedByUserId: approver!.id,
            approvedAt: day(-2),
            submittedAt: day(-3),
            sentAt: day(-1),
            expectedDeliveryAt: day(1),
            // Prisma 7 rejects a composite-FK scalar in a nested create: the
            // parent supplies `organizationId` through the relation, so
            // repeating it here is an unknown argument rather than a duplicate.
            lines: {
              create: {
                lineNumber: 1,
                medicineId: medicine.id,
                packLevelId: packLevel.id,
                orderedPacks: FIXTURE.purchaseOrder.orderedPacks,
                canonicalUnitsPerPack: FIXTURE.purchaseOrder.unitsPerPack,
                orderedCanonicalUnits:
                  FIXTURE.purchaseOrder.orderedPacks * FIXTURE.purchaseOrder.unitsPerPack,
                listPricePerPackMinor: 250_00,
              },
            },
            approvals: {
              create: {
                actorUserId: approver!.id,
                policy: 'PUR-02:SEGREGATION_OF_DUTIES',
                decision: 'APPROVED',
                fromStatus: 'SUBMITTED',
                toStatus: 'APPROVED',
                reason: 'Seeded acceptance fixture.',
              },
            },
          },
        });
      }

      // Quarantine is referenced by the capture form even when nothing is
      // rejected, so fail loudly here rather than in the browser.
      if (!quarantine) throw new Error('Quarantine location was not provisioned.');
    });

    mkdirSync(path.dirname(HANDLE_PATH), { recursive: true });
    writeFileSync(
      HANDLE_PATH,
      `${JSON.stringify({ organizationId, purchaseOrderReference }, null, 2)}\n`
    );
    process.stdout.write(
      `PH-PUR fixture ready: organization ${organizationId}, order ${purchaseOrderReference}\n`
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
