import { hashSync } from 'bcryptjs';
import { normalizeMedicineText } from '../src/lib/pharmacy/medicine';
import { moduleDefinitionForKey } from '../src/lib/module-catalog';
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';
import { receiveLot } from '../src/lib/pharmacy/stock-ledger';
import { createSale, addSaleLine, returnSaleLine } from '../src/lib/pharmacy/sales';
import { attachPrescriptionReference } from '../src/lib/pharmacy/rx-prescription-reference';
import {
  applyPharmacyTender,
  refundPharmacyTender,
  openPharmacyDrawer,
  closePharmacyDrawer,
} from '../src/lib/pharmacy/settlement';

const REQUIRED_PASSWORDS = [
  'DEMO_SOLO_OWNER_PASSWORD',
  'DEMO_STAFFED_OWNER_PASSWORD',
  'DEMO_STAFFED_PHARMACIST_PASSWORD',
  'DEMO_STAFFED_CASHIER_PASSWORD',
] as const;

const products = [
  ['Panadol', 'Paracetamol', '500 mg', 'tablet'],
  ['Calpol', 'Paracetamol', '120 mg/5 mL', 'suspension'],
  ['Brufen', 'Ibuprofen', '400 mg', 'tablet'],
  ['Disprin', 'Aspirin', '300 mg', 'tablet'],
  ['Augmentin', 'Co-amoxiclav', '625 mg', 'tablet'],
  ['Amoxil', 'Amoxicillin', '500 mg', 'capsule'],
  ['Ciproxin', 'Ciprofloxacin', '500 mg', 'tablet'],
  ['Flagyl', 'Metronidazole', '400 mg', 'tablet'],
  ['Azomax', 'Azithromycin', '500 mg', 'tablet'],
  ['Klaricid', 'Clarithromycin', '500 mg', 'tablet'],
  ['Risek', 'Omeprazole', '20 mg', 'capsule'],
  ['Nexum', 'Esomeprazole', '40 mg', 'tablet'],
  ['Motilium', 'Domperidone', '10 mg', 'tablet'],
  ['Gravinate', 'Dimenhydrinate', '50 mg', 'tablet'],
  ['Entamizole', 'Diloxanide + Metronidazole', '500/400 mg', 'tablet'],
  ['Imodium', 'Loperamide', '2 mg', 'capsule'],
  ['Glucophage', 'Metformin', '500 mg', 'tablet'],
  ['Amaryl', 'Glimepiride', '2 mg', 'tablet'],
  ['Januvia', 'Sitagliptin', '100 mg', 'tablet'],
  ['Humulin 70/30', 'Human insulin', '100 IU/mL', 'injection'],
  ['Norvasc', 'Amlodipine', '5 mg', 'tablet'],
  ['Concor', 'Bisoprolol', '5 mg', 'tablet'],
  ['Cozaar', 'Losartan', '50 mg', 'tablet'],
  ['Diovan', 'Valsartan', '80 mg', 'tablet'],
  ['Lipitor', 'Atorvastatin', '20 mg', 'tablet'],
  ['Crestor', 'Rosuvastatin', '10 mg', 'tablet'],
  ['Ventolin', 'Salbutamol', '100 mcg', 'inhaler'],
  ['Seretide', 'Salmeterol + Fluticasone', '25/125 mcg', 'inhaler'],
  ['Rigix', 'Cetirizine', '10 mg', 'tablet'],
  ['Telfast', 'Fexofenadine', '120 mg', 'tablet'],
  ['Avil', 'Pheniramine', '25 mg', 'tablet'],
  ['Surbex-Z', 'Multivitamin + Zinc', 'standard', 'tablet'],
  ['Neurobion', 'Vitamins B1/B6/B12', 'standard', 'tablet'],
  ['Fefol', 'Iron + Folic acid', 'standard', 'capsule'],
  ['Caltrate', 'Calcium + Vitamin D', '600 mg', 'tablet'],
  ['Voltaren', 'Diclofenac', '50 mg', 'tablet'],
  ['Ponstan', 'Mefenamic acid', '500 mg', 'tablet'],
  ['Xanax', 'Alprazolam', '0.5 mg', 'tablet'],
  ['Lexotanil', 'Bromazepam', '3 mg', 'tablet'],
  ['Rocephin', 'Ceftriaxone', '1 g', 'injection'],
] as const;

export const demoPharmacyPlan = [
  {
    slug: 'solo-demo-pharmacy',
    name: 'Solo Demo Pharmacy',
    mode: 'SOLO' as const,
    roles: ['owner'],
  },
  {
    slug: 'staffed-demo-pharmacy',
    name: 'Staffed Demo Pharmacy',
    mode: 'STAFFED' as const,
    roles: ['owner', 'pharmacist', 'cashier'],
  },
];
// Illustrative retail pack prices, in PKR; not a live regulated price feed.
const manufacturers = [
  'Haleon Pakistan',
  'GSK Pakistan',
  'Abbott Laboratories Pakistan',
  'Reckitt Pakistan',
  'GSK Pakistan',
  'GSK Pakistan',
  'Bayer Pakistan',
  'Sanofi Pakistan',
  'AGP Limited',
  'Abbott Laboratories Pakistan',
  'Getz Pharma',
  'Getz Pharma',
  'Martin Dow',
  'Searle Pakistan',
  'Abbott Laboratories Pakistan',
  'Janssen Pakistan',
  'Martin Dow',
  'Sanofi Pakistan',
  'MSD Pakistan',
  'Eli Lilly Pakistan',
  'Pfizer Pakistan',
  'Merck Pakistan',
  'MSD Pakistan',
  'Novartis Pakistan',
  'Pfizer Pakistan',
  'AstraZeneca Pakistan',
  'GSK Pakistan',
  'GSK Pakistan',
  'AGP Limited',
  'Sanofi Pakistan',
  'Sanofi Pakistan',
  'Abbott Laboratories Pakistan',
  'Martin Dow',
  'GSK Pakistan',
  'Pfizer Pakistan',
  'Novartis Pakistan',
  'Pfizer Pakistan',
  'Pfizer Pakistan',
  'Martin Dow',
  'Roche Pakistan',
];
const prices = [
  38, 110, 95, 45, 290, 180, 420, 95, 390, 650, 240, 480, 190, 85, 210, 160, 180, 320, 1850, 1250,
  290, 420, 520, 890, 650, 720, 490, 2100, 160, 380, 85, 420, 280, 190, 650, 240, 140, 280, 220,
  780,
];
const otc = new Set([0, 1, 2, 3, 13, 15, 28, 29, 30, 31, 32, 33, 34]);
export const demoMedicineCatalog = products.map(([brand, generic, strength, form], index) => ({
  brand,
  generic,
  strength,
  form,
  manufacturer: manufacturers[index],
  mrpPkr: prices[index],
  rx: !otc.has(index),
  controlled: index === 37 || index === 38,
  coldChain: index === 19,
  batches: [
    { suffix: 'A', expiryMonths: index % 7 === 0 ? -1 : 1, quantity: index % 9 === 0 ? 2 : 48 },
    { suffix: 'B', expiryMonths: 22, quantity: index % 9 === 0 ? 2 : 72 },
  ],
}));
export const demoSalesDays = 30;
const otcSaleIndexes = [1, 2, 3, 13, 15, 28, 29, 30, 31, 32, 33, 34];
const rxSaleIndexes = [4, 5, 6, 7, 8, 10, 11, 12, 14, 16, 17, 20, 21, 22, 23, 24, 25, 26, 35, 39];

export function readDemoPasswords(env: NodeJS.ProcessEnv = process.env) {
  const missing = REQUIRED_PASSWORDS.filter((key) => !env[key]?.trim());
  if (missing.length)
    throw new Error(`Missing required demo password environment variables: ${missing.join(', ')}`);
  return Object.fromEntries(REQUIRED_PASSWORDS.map((key) => [key, env[key]!])) as Record<
    (typeof REQUIRED_PASSWORDS)[number],
    string
  >;
}

/** Fixed keys plus one transaction per tenant make reruns and concurrent runs safe. */
export async function seedDemoPharmacies(
  prisma: PrismaClient,
  env = process.env,
  plans = demoPharmacyPlan
) {
  const passwords = readDemoPasswords(env);
  for (const plan of plans) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${plan.slug}, 0))`;
        const existing = await tx.organization.findUnique({ where: { slug: plan.slug } });
        if (existing && (!existing.isDemo || existing.vertical !== 'PHARMACY'))
          throw new Error('Demo namespace belongs to a non-demo organization');
        const org = await tx.organization.upsert({
          where: { slug: plan.slug },
          update: {},
          create: {
            slug: plan.slug,
            legalName: plan.name,
            displayName: plan.name,
            vertical: 'PHARMACY',
            status: 'ACTIVE',
            currency: 'PKR',
            timezone: 'Asia/Karachi',
            locale: 'en-PK',
            isDemo: true,
            seatLimit: plan.roles.length,
            pharmacyOperatingMode: plan.mode,
          },
        });
        const organizationId = org.id;
        // Anchor history once; reruns retain the same business dates and expiry facts.
        const epoch = new Date(org.createdAt);
        epoch.setUTCHours(12, 0, 0, 0);
        const before = new Date(epoch.getTime() - 90 * 86400000);
        await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true)`;
        const id = (key: string) => `${plan.slug}:${key}`;
        const branchId = id('branch');
        await tx.organizationDepartment.upsert({
          where: { organizationId_key: { organizationId, key: 'pharmacy' } },
          update: {},
          create: { organizationId, key: 'pharmacy', name: 'Pharmacy' },
        });
        for (const key of [
          'pharmacy-core',
          'pharmacy-counter',
          'pharmacy-inventory',
          'pharmacy-dispensing',
          'pharmacy-procurement',
          'pharmacy-reports',
          'pharmacy-safety',
        ]) {
          const definition = moduleDefinitionForKey(key);
          if (!definition) throw new Error('Missing pharmacy module definition');
          const module = await tx.platformModule.upsert({
            where: { key },
            update: {},
            create: {
              key,
              name: definition.name,
              category: definition.category,
              routePrefix: definition.routePrefix,
              band: definition.band,
              vertical: definition.vertical,
              active: true,
            },
          });
          await tx.organizationModule.upsert({
            where: { organizationId_moduleId: { organizationId, moduleId: module.id } },
            update: {},
            create: { organizationId, moduleId: module.id, startsAt: before },
          });
        }
        for (const role of plan.roles) {
          const r = await tx.organizationRole.upsert({
            where: { organizationId_key: { organizationId, key: role } },
            update: {},
            create: { organizationId, key: role, name: role, isSystem: true },
          });
          const capabilities =
            role === 'cashier'
              ? ['pharmacy:counter']
              : role === 'pharmacist'
                ? ['pharmacy:counter', 'pharmacy:dispense', 'pharmacy:inventory']
                : [
                    'pharmacy:counter',
                    'pharmacy:manage',
                    'pharmacy:inventory',
                    'pharmacy:procurement',
                    'reports:operational',
                    'reports:financial',
                    ...(plan.mode === 'SOLO' ? ['pharmacy:dispense'] : []),
                  ];
          for (const capability of capabilities)
            await tx.organizationRolePermission.upsert({
              where: { organizationRoleId_capability: { organizationRoleId: r.id, capability } },
              update: {},
              create: { organizationId, organizationRoleId: r.id, capability },
            });
          const key = `DEMO_${plan.mode}_${role.toUpperCase()}_PASSWORD` as keyof typeof passwords;
          await tx.user.upsert({
            where: { id: id(role) },
            update: {},
            create: {
              id: id(role),
              organizationId,
              organizationRoleId: r.id,
              name: `${plan.name} ${role}`,
              email: `${role}@${plan.slug}.example`,
              password: hashSync(passwords[key], 12),
              department: 'pharmacy',
              title: role,
              role: role === 'owner' ? 'ADMIN' : 'EMPLOYEE',
            },
          });
        }
        await tx.pharmacyBranch.upsert({
          where: { id: branchId },
          update: {},
          create: {
            id: branchId,
            organizationId,
            code: plan.mode,
            name: plan.name,
            addressLine: 'Demo retail market, Main Boulevard',
            city: 'Lahore',
            provinceCode: 'PB',
          },
        });
        for (const role of plan.roles)
          await tx.pharmacyBranchAssignment.upsert({
            where: {
              organizationId_branchId_userId: { organizationId, branchId, userId: id(role) },
            },
            update: {},
            create: { organizationId, branchId, userId: id(role) },
          });
        const locationId = id('shelf');
        await tx.pharmacyStockLocation.upsert({
          where: { id: locationId },
          update: {},
          create: {
            id: locationId,
            organizationId,
            branchId,
            code: 'MAIN',
            name: 'Main dispensary',
            kind: 'STORE',
          },
        });
        await tx.pharmacyBranch.update({
          where: { id: branchId },
          data: { defaultStockLocationId: locationId },
        });
        await tx.pharmacyStockLocation.upsert({
          where: { id: id('quarantine') },
          update: {},
          create: {
            id: id('quarantine'),
            organizationId,
            branchId,
            code: 'QUARANTINE',
            name: 'Returns quarantine',
            kind: 'QUARANTINE',
          },
        });
        await tx.pharmacyStockLocation.upsert({
          where: { id: id('fridge') },
          update: {},
          create: {
            id: id('fridge'),
            organizationId,
            branchId,
            code: 'FRIDGE',
            name: 'Medicine refrigerator',
            kind: 'STORE',
            coldChain: true,
            minimumTemperatureC: 2,
            maximumTemperatureC: 8,
          },
        });
        const scope = { organizationId, branchId, actorId: id('owner') };
        const db = tx as unknown as ScopedDb;
        for (let index = 0; index < 3; index++) {
          const supplierId = id(`supplier-${index}`);
          await tx.pharmacySupplier.upsert({
            where: { id: supplierId },
            update: {},
            create: {
              id: supplierId,
              organizationId,
              name: [
                'Lahore Demo Distributors',
                'Karachi Demo Medical Supplies',
                'Islamabad Demo Pharma',
              ][index],
              authorized: true,
              serviceArea: 'Pakistan',
              paymentTermsDays: 30,
              contactName: 'Synthetic demo contact',
            },
          });
          if (
            !(await tx.pharmacySupplierLicence.findUnique({
              where: { id: id(`licence-${index}`) },
            }))
          )
            await tx.pharmacySupplierLicence.create({
              data: {
                id: id(`licence-${index}`),
                organizationId,
                supplierId,
                licenceType: 'DEMO',
                licenceNumber: `SYNTHETIC-${index}`,
                issuingAuthority: 'Synthetic demo only',
                issuedAt: before,
                expiresAt: new Date(epoch.getTime() + 3 * 365 * 86400000),
                verifiedAt: before,
                verifiedByUserId: id('owner'),
              },
            });
          await tx.pharmacyPurchaseOrder.upsert({
            where: { id: id(`po-${index}`) },
            update: {},
            create: {
              id: id(`po-${index}`),
              organizationId,
              branchId,
              supplierId,
              reference: `DEMO-PO-${index + 1}`,
              createdByUserId: id('owner'),
              note: 'Synthetic demo replenishment draft',
            },
          });
        }
        for (const [index, product] of demoMedicineCatalog.entries()) {
          const medicineId = id(`medicine-${index}`),
            presentationId = id(`presentation-${index}`),
            packLevelId = id(`pack-${index}`);
          await tx.medicine.upsert({
            where: { id: medicineId },
            update: {},
            create: {
              id: medicineId,
              organizationId,
              productName: `${product.brand} ${product.strength}`,
              brandName: product.brand,
              manufacturer: product.manufacturer,
              productFamily: 'PHARMACEUTICAL',
              controlled: product.controlled,
              coldChain: product.coldChain,
              rx: product.rx,
              otc: !product.rx,
              saleable: true,
              aliases: {
                create: {
                  organizationId,
                  value: product.generic,
                  normalizedValue: normalizeMedicineText(product.generic),
                  type: 'GENERIC',
                },
              },
            },
          });
          if (!(await tx.presentation.findUnique({ where: { id: presentationId } })))
            await tx.presentation.create({
              data: {
                id: presentationId,
                organizationId,
                medicineId,
                dosageForm: product.form,
                presentation: `${product.generic} ${product.strength} ${product.form}`,
              },
            });
          if (!(await tx.packLevel.findUnique({ where: { id: packLevelId } })))
            await tx.packLevel.create({
              data: {
                id: packLevelId,
                organizationId,
                presentationId,
                versionGroupId: packLevelId,
                version: 1,
                level: 'BOX',
                unitsPerParent: 1,
                effectiveFrom: before,
              },
            });
          for (const batch of product.batches) {
            const batchId = id(`batch-${index}-${batch.suffix}`);
            const expiresAt = new Date(epoch);
            expiresAt.setUTCMonth(expiresAt.getUTCMonth() + batch.expiryMonths);
            if (!(await tx.pharmacyManufacturingBatch.findUnique({ where: { id: batchId } })))
              await tx.pharmacyManufacturingBatch.create({
                data: {
                  id: batchId,
                  organizationId,
                  medicineId,
                  batchNumber: `DEMO-${index}-${batch.suffix}`,
                  expiresAt,
                },
              });
            if (
              !(await tx.medicinePackMrp.findUnique({
                where: {
                  organizationId_packLevelId_batchReference: {
                    organizationId,
                    packLevelId,
                    batchReference: `DEMO-${index}-${batch.suffix}`,
                  },
                },
              }))
            )
              await tx.medicinePackMrp.create({
                data: {
                  organizationId,
                  packLevelId,
                  batchReference: `DEMO-${index}-${batch.suffix}`,
                  printedMrpMinor: product.mrpPkr * 100,
                },
              });
            if (
              !(await tx.pharmacyInventoryLot.findFirst({
                where: { organizationId, manufacturingBatchId: batchId },
              }))
            )
              await receiveLot(db, scope, {
                manufacturingBatchId: batchId,
                packLevelId,
                stockLocationId: product.coldChain ? id('fridge') : locationId,
                unitsPerPack: 1,
                supplierName: 'Lahore Demo Distributors',
                supplierInvoiceRef: `DEMO-${index}-${batch.suffix}`,
                printedMrpMinor: product.mrpPkr * 100,
                unitCostMinor: product.mrpPkr * 60,
                receivedExpiresAt: expiresAt,
                receivedExpiryPrecision: 'DAY',
                quantityUnits: batch.quantity,
                receivedAt: before,
                idempotencyKey: batchId,
              });
          }
          const poId = id(`po-${index % 3}`);
          if (
            !(await tx.pharmacyPurchaseOrderLine.findFirst({
              where: { organizationId, purchaseOrderId: poId, lineNumber: index + 1 },
            }))
          )
            await tx.pharmacyPurchaseOrderLine.create({
              data: {
                organizationId,
                purchaseOrderId: poId,
                lineNumber: index + 1,
                medicineId,
                packLevelId,
                orderedPacks: 24,
                canonicalUnitsPerPack: 1,
                orderedCanonicalUnits: 24,
                listPricePerPackMinor: product.mrpPkr * 60,
              },
            });
        }
        await tx.pharmacyPatient.upsert({
          where: { id: id('patient') },
          update: {},
          create: {
            id: id('patient'),
            organizationId,
            displayName: 'Synthetic Demo Patient',
          },
        });
        await tx.pharmacyPrescriber.upsert({
          where: { id: id('prescriber') },
          update: {},
          create: {
            id: id('prescriber'),
            organizationId,
            name: 'Synthetic Demo Prescriber',
            registrationNumber: 'DEMO-NOT-A-REAL-REGISTRATION',
          },
        });
        for (let day = 0; day < demoSalesDays; day++) {
          const saleKey = id(`sale-${day}`);
          if (
            await tx.auditLog.findFirst({
              where: { organizationId, action: 'DEMO:SALE_SEEDED', targetId: saleKey },
            })
          )
            continue;
          const date = new Date(epoch.getTime() - day * 86400000);
          date.setUTCHours(0, 0, 0, 0);
          const actorId = id(plan.mode === 'SOLO' ? 'owner' : day % 2 ? 'cashier' : 'pharmacist');
          const saleScope = { ...scope, actorId };
          const makerScope = plan.mode === 'STAFFED' ? { ...scope, actorId: id('cashier') } : scope;
          const sale = await createSale(db, makerScope);
          // Alternate OTC and Rx; controlled drugs remain catalog-only.
          const choices = day % 2 ? otcSaleIndexes : rxSaleIndexes;
          const index = choices[Math.floor(day / 2) % choices.length]!;
          const product = demoMedicineCatalog[index];
          const result = await addSaleLine(db, saleScope, {
            saleId: sale.id,
            medicineId: id(`medicine-${index}`),
            presentationId: id(`presentation-${index}`),
            packLevelId: id(`pack-${index}`),
            saleUnit: 'PACK',
            quantity: 1,
            canonicalUnitsPerSaleUnit: 1,
            idempotencyKey: saleKey,
            ...(day % 5 === 0 && !product.rx
              ? {
                  discountKind: 'DISCOUNT',
                  discountMinor: product.mrpPkr * 5,
                  approvedByUserId: id('owner'),
                  approvalPolicy: 'DEMO:ILLUSTRATIVE_DISCOUNT',
                }
              : {}),
          });
          if (product.rx) {
            const prescription = await tx.prescription.create({
              data: {
                organizationId,
                patientId: id('patient'),
                prescriberId: id('prescriber'),
                sourceKind: 'PAPER_IMAGE',
                sourceFileRef: `demo://synthetic/${day}`,
                validFrom: before,
                validUntil: new Date(epoch.getTime() + 365 * 86400000),
                capturedByUserId: actorId,
                lines: {
                  create: {
                    lineNumber: 1,
                    medicineId: id(`medicine-${index}`),
                    presentationId: id(`presentation-${index}`),
                    authorizedCanonicalUnits: 1,
                    directions: 'Synthetic demo only; not clinical advice',
                  },
                },
              },
              include: { lines: true },
            });
            await attachPrescriptionReference(db, saleScope, {
              prescriptionLineId: prescription.lines[0].id,
              patientId: id('patient'),
              saleLineId: result.line.id,
            });
          }
          const drawer = await openPharmacyDrawer(db, saleScope, {
            deviceId: id(`counter-${day}`),
            businessDate: date,
            openingFloatMinor: 0,
          });
          const tender = await applyPharmacyTender(db, saleScope, {
            saleId: sale.id,
            deviceId: id(`counter-${day}`),
            businessDate: date,
            type: 'CASH',
            amountMinor: result.line.unitPriceMinor - result.line.discountMinor,
            cashReceivedMinor: result.line.unitPriceMinor,
            idempotencyKey: `${saleKey}:tender`,
          });
          if (day % 7 === 0) {
            await returnSaleLine(db, scope, {
              saleLineId: result.line.id,
              canonicalUnits: 1,
              lotId: result.allocation.allocations[0]?.inventoryLotId,
              disposition: 'QUARANTINE',
              quarantineLocationId: id('quarantine'),
              reason: 'Synthetic demo customer return',
              integrityDecision: 'QUARANTINE',
              idempotencyKey: `${saleKey}:return`,
            });
            if (!('tenderId' in tender) || typeof tender.tenderId !== 'string')
              throw new Error('Demo tender missing');
            await refundPharmacyTender(db, scope, {
              originalTenderId: tender.tenderId,
              deviceId: id(`counter-${day}`),
              businessDate: date,
              amountMinor: result.line.unitPriceMinor - result.line.discountMinor,
              reason: 'Synthetic demo return refund',
              idempotencyKey: `${saleKey}:refund`,
            });
          }
          await closePharmacyDrawer(db, saleScope, {
            drawerSessionId: drawer.id,
            countedCashMinor:
              day % 7 === 0 ? 0 : result.line.unitPriceMinor - result.line.discountMinor,
          });
          await tx.auditLog.create({
            data: {
              organizationId,
              actorId,
              source: 'SYSTEM',
              category: 'PHARMACY',
              action: 'DEMO:SALE_SEEDED',
              targetType: 'PharmacySale',
              targetId: saleKey,
              metadata: { saleId: sale.id, synthetic: true, businessDate: date.toISOString() },
            },
          });
        }
      },
      { timeout: 120000 }
    );
    console.log(`${plan.name}: 40 medicines, 80 batches, 30 sales days; fixture ensured.`);
  }
}
async function main() {
  readDemoPasswords();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    await seedDemoPharmacies(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error &&
        error.message.startsWith('Missing required demo password environment variables:')
        ? error.message
        : 'Demo seed failed; check configuration and database prerequisites.'
    );
    process.exitCode = 1;
  });
