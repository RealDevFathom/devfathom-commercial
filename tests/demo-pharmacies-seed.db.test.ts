// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compare } from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  demoMedicineCatalog,
  demoPharmacyPlan,
  readDemoPasswords,
  seedDemoPharmacies,
} from '../scripts/seed-demo-pharmacies';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
const keys = [
  'DEMO_SOLO_OWNER_PASSWORD',
  'DEMO_STAFFED_OWNER_PASSWORD',
  'DEMO_STAFFED_PHARMACIST_PASSWORD',
  'DEMO_STAFFED_CASHIER_PASSWORD',
];
const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  ...Object.fromEntries(keys.map((key) => [key, randomBytes(24).toString('base64url')])),
};
const testPlans = demoPharmacyPlan.map((plan) => ({
  ...plan,
  slug: `${plan.slug}-${randomUUID()}`,
}));
let prisma: PrismaClient;
beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error('Local DATABASE_URL required for persisted demo seed smoke tests');
  assertDisposableRlsDatabase(process.env.DATABASE_URL);
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
});
afterAll(async () => {
  await prisma?.$disconnect();
});
describe('persisted demo pharmacy seed', () => {
  it('rejects each absent secret before writing anything', async () => {
    for (const key of keys) {
      const missing = { ...env };
      delete missing[key];
      expect(() => readDemoPasswords(missing)).toThrow(key);
      await expect(seedDemoPharmacies(prisma, missing, testPlans)).rejects.toThrow(key);
    }
  });
  it('refuses an ordinary pharmacy occupying the seed namespace', async () => {
    const plan = { ...testPlans[0]!, slug: `occupied-pharmacy-${randomUUID()}` };
    const existing = await prisma.organization.create({
      data: {
        slug: plan.slug,
        legalName: 'Existing pharmacy',
        displayName: 'Existing pharmacy',
        vertical: 'PHARMACY',
        status: 'ACTIVE',
      },
    });
    await expect(seedDemoPharmacies(prisma, env, [plan])).rejects.toThrow(
      'Demo namespace belongs to a non-demo organization'
    );
    expect(
      await prisma.organization.findUniqueOrThrow({ where: { id: existing.id } })
    ).toMatchObject({ isDemo: false, notes: null, displayName: 'Existing pharmacy' });
  });
  it('persists both complete pharmacies and reruns without duplicating immutable evidence', async () => {
    await seedDemoPharmacies(prisma, env, testPlans);
    const snapshot = async () => {
      const results = [];
      for (const plan of testPlans) {
        const organization = await prisma.organization.findUniqueOrThrow({
          where: { slug: plan.slug },
        });
        const organizationId = organization.id;
        const users = await prisma.user.findMany({
          where: { organizationId },
          include: { organizationRole: { include: { permissions: true } } },
        });
        expect(organization.pharmacyOperatingMode).toBe(plan.mode);
        expect(organization.isDemo).toBe(false);
        expect(organization.notes).toContain('seed-demo-pharmacies:v1');
        expect(users.map((user) => user.organizationRole!.key).sort()).toEqual(
          [...plan.roles].sort()
        );
        for (const user of users) {
          const key = `DEMO_${plan.mode}_${user.organizationRole!.key.toUpperCase()}_PASSWORD`;
          expect(await compare(env[key]!, user.password!)).toBe(true);
          expect(user.password).not.toBe(env[key]);
        }
        const grants = (role: string) => users.find((user) => user.organizationRole?.key === role)!
          .organizationRole!.permissions.filter((grant) => grant.effect === 'ALLOW').map((grant) => grant.capability);
        expect(grants('owner')).toEqual(expect.arrayContaining([
          'pharmacy:safety', 'pharmacy:catalogue-review',
        ]));
        if (plan.mode === 'SOLO') expect(grants('owner')).toContain('pharmacy:dispense');
        else {
          expect(grants('owner')).not.toContain('pharmacy:dispense');
          expect(grants('pharmacist')).toContain('pharmacy:dispense');
          expect(grants('cashier')).not.toContain('pharmacy:dispense');
          expect(grants('cashier')).not.toContain('pharmacy:safety');
          expect(grants('cashier')).not.toContain('pharmacy:catalogue-review');
        }
        const medicines = await prisma.medicine.findMany({
          where: { organizationId },
          include: { aliases: true, presentations: true },
        });
        expect(medicines.length).toBeGreaterThanOrEqual(40);
        expect(
          medicines.every(
            (m) =>
              m.manufacturer &&
              m.brandName &&
              m.aliases.some((a) => a.type === 'GENERIC') &&
              m.presentations[0]?.dosageForm
          )
        ).toBe(true);
        const batches = await prisma.pharmacyManufacturingBatch.findMany({
          where: { organizationId },
        });
        expect(batches).toHaveLength(80);
        expect(batches.some((b) => b.expiresAt < organization.createdAt)).toBe(true);
        expect(
          batches.some(
            (b) =>
              b.expiresAt > organization.createdAt &&
              b.expiresAt < new Date(organization.createdAt.getTime() + 90 * 86400000)
          )
        ).toBe(true);
        expect(
          await prisma.pharmacyStockBalance.count({
            where: { organizationId, onHandUnits: { lte: 4, gt: 0 } },
          })
        ).toBeGreaterThan(0);
        const sales = await prisma.pharmacySale.findMany({
          where: { organizationId, status: 'COMPLETED' },
          include: { lines: { include: { medicine: true } } },
        });
        expect(sales).toHaveLength(30);
        expect(
          new Set(sales.map((sale) => sale.businessDate!.toISOString().slice(0, 10))).size
        ).toBe(30);
        expect(sales.some((s) => s.lines.some((l) => l.medicine.rx && l.prescriptionLineId))).toBe(
          true
        );
        expect(sales.some((s) => s.lines.some((l) => l.medicine.otc))).toBe(true);
        expect(sales.some((s) => s.lines.some((l) => l.discountMinor > 0))).toBe(true);
        const counts = {
          medicines: medicines.length,
          batches: batches.length,
          sales: sales.length,
          suppliers: await prisma.pharmacySupplier.count({ where: { organizationId } }),
          orders: await prisma.pharmacyPurchaseOrder.count({ where: { organizationId } }),
          returns: await prisma.pharmacySaleReturn.count({ where: { organizationId } }),
          refunds: await prisma.pharmacyRefund.count({ where: { organizationId } }),
          fills: await prisma.prescriptionFill.count({ where: { organizationId } }),
          movements: await prisma.pharmacyStockMovement.count({ where: { organizationId } }),
          audits: await prisma.auditLog.count({ where: { organizationId } }),
        };
        expect(counts.suppliers).toBe(3);
        expect(counts.orders).toBe(3);
        expect(counts.returns).toBe(5);
        expect(counts.refunds).toBe(5);
        expect(counts.fills).toBe(15);
        results.push(counts);
      }
      return results;
    };
    const first = await snapshot();
    // Upgrade the old seed marker without losing accounts or immutable history.
    await prisma.organization.update({
      where: { slug: testPlans[0]!.slug },
      data: { isDemo: true, notes: null },
    });
    await seedDemoPharmacies(prisma, env, testPlans);
    expect(await snapshot()).toEqual(first);
    expect(demoMedicineCatalog.every((m) => m.manufacturer && m.strength && m.mrpPkr > 0)).toBe(
      true
    );
  }, 120000);
});
