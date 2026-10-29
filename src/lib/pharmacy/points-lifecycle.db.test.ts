// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { seedDemoPharmacies } from '../../../scripts/seed-demo-pharmacies';
import { createSale, addSaleLine, returnSaleLine, changeSaleStatus } from './sales';
import {
  linkCustomerToSale,
  accrueSalePoints,
  redeemSalePoints,
  readCustomerSnapshot,
} from './customer-loyalty';
import { writePatientConsent } from './consent-writer';
import { applyPharmacyTender, openPharmacyDrawer, refundPharmacyTender } from './settlement';
import { savePointsPolicy } from './points-policy';
import { readCounterReceipt } from './counter';
const slug = `points-test-${randomUUID()}`;
const id = (key: string) => `${slug}:${key}`;
const role = `points_runtime_${randomUUID().replaceAll('-', '')}`;
let client: PrismaClient;
let owner: Client;
let organizationId: string;
const day = new Date('2026-10-29');
const scope = () => ({ organizationId, branchId: id('branch'), actorId: id('owner') });
async function inTenant<T>(work: (db: ScopedDb) => Promise<T>) {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      await tx.$queryRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true), set_config('app.current_branch_id', ${id('branch')}, true), set_config('app.is_platform_admin','false',true)`;
      return work(tx as unknown as ScopedDb);
    },
    { timeout: 30000 }
  );
}
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for points integration');
  client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const env = Object.fromEntries(
    [
      'DEMO_SOLO_OWNER_PASSWORD',
      'DEMO_STAFFED_OWNER_PASSWORD',
      'DEMO_STAFFED_PHARMACIST_PASSWORD',
      'DEMO_STAFFED_CASHIER_PASSWORD',
    ].map((key) => [key, randomBytes(24).toString('hex')])
  );
  await seedDemoPharmacies(client, { ...env, NODE_ENV: 'test' }, [
    { slug, name: 'Synthetic points regression', mode: 'SOLO', roles: ['owner'] },
  ]);
  organizationId = (await client.organization.findUniqueOrThrow({ where: { slug } })).id;
  owner = new Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();
  await owner.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await owner.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`
  );
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
}, 120000);
afterAll(async () => {
  await client?.$disconnect();
  if (owner) {
    await owner.query(`DROP OWNED BY "${role}"`);
    await owner.query(`DROP ROLE "${role}"`);
    await owner.end();
  }
});
async function basket(db: ScopedDb) {
  const sale = await createSale(db, scope());
  const added = await addSaleLine(db, scope(), {
    saleId: sale.id,
    medicineId: id('medicine-1'),
    presentationId: id('presentation-1'),
    packLevelId: id('pack-1'),
    saleUnit: 'PACK',
    quantity: 1,
    canonicalUnitsPerSaleUnit: 1,
    idempotencyKey: randomUUID(),
  });
  const customer = await linkCustomerToSale(db, scope(), {
    saleId: sale.id,
    patientId: id('loyalty-patient-1'),
    displayName: 'Synthetic consenting customer',
  });
  return { sale, added, customer, total: added.line.unitPriceMinor };
}
describe('points lifecycle with real PostgreSQL and forced RLS', () => {
  it('does not enroll without consent or earn when consent is revoked before completion', async () => {
    await inTenant(async (db) => {
      const { sale, total } = await basket(db);
      await writePatientConsent(db, organizationId, id('owner'), {
        patientId: id('loyalty-patient-1'),
        purpose: 'LOYALTY',
        channel: 'IN_PERSON',
        granted: false,
      });
      const other = await createSale(db, scope());
      await expect(
        linkCustomerToSale(db, scope(), {
          saleId: other.id,
          patientId: id('loyalty-patient-1'),
          displayName: 'Must not enroll',
        })
      ).rejects.toThrow('LOYALTY_CONSENT_REQUIRED');
      const deviceId = randomUUID();
      await openPharmacyDrawer(db, scope(), { deviceId, businessDate: day, openingFloatMinor: 0 });
      await applyPharmacyTender(db, scope(), {
        saleId: sale.id,
        deviceId,
        businessDate: day,
        type: 'CASH',
        amountMinor: total,
        cashReceivedMinor: total,
        idempotencyKey: randomUUID(),
      });
      expect(
        await db.pharmacyLoyaltyPointsEntry.count({
          where: { organizationId, saleId: sale.id, kind: 'EARN' },
        })
      ).toBe(0);
      await writePatientConsent(db, organizationId, id('owner'), {
        patientId: id('loyalty-patient-1'),
        purpose: 'LOYALTY',
        channel: 'IN_PERSON',
        granted: true,
      });
    });
  });
  it('redeems, prints redeemed/remaining points, and reverses both sides of a full refund at original rates', async () => {
    await inTenant(async (db) => {
      const { sale, total, added, customer } = await basket(db);
      expect(await accrueSalePoints(db, scope(), sale.id)).toBeNull();
      const before = await readCustomerSnapshot(db, scope(), customer.id);
      const deviceId = randomUUID();
      await openPharmacyDrawer(db, scope(), { deviceId, businessDate: day, openingFloatMinor: 0 });
      const redeemed = await redeemSalePoints(db, scope(), {
        saleId: sale.id,
        points: 5,
        deviceId,
        businessDate: day,
        idempotencyKey: randomUUID(),
      });
      expect(redeemed.amountMinor).toBe(500);
      const cash = await applyPharmacyTender(db, scope(), {
        saleId: sale.id,
        deviceId,
        businessDate: day,
        type: 'CASH',
        amountMinor: total - 500,
        cashReceivedMinor: total - 500,
        idempotencyKey: randomUUID(),
      });
      if (!('tenderId' in cash)) throw new Error('Missing cash tender');
      const receipt = await readCounterReceipt(db, scope(), sale.id, {
        name: 'Synthetic branch',
        currency: 'PKR',
      });
      expect(receipt.loyalty).toEqual({
        redeemedPoints: 5,
        remainingPoints: before.pointsBalance - 5 + Math.floor((total - 500) / 1000),
      });
      await savePointsPolicy(db, organizationId, id('owner'), {
        pointsEnabled: false,
        earnEveryMinor: 200,
        pointValueMinor: 500,
        minimumRedeemPoints: 10,
      });
      await returnSaleLine(db, scope(), {
        saleLineId: added.line.id,
        canonicalUnits: 1,
        lotId: added.allocation.allocations[0]!.inventoryLotId,
        disposition: 'QUARANTINE',
        quarantineLocationId: id('quarantine'),
        reason: 'Synthetic full refund',
        integrityDecision: 'QUARANTINE',
        idempotencyKey: randomUUID(),
      });
      const tender = await db.pharmacyTender.findFirstOrThrow({
        where: { organizationId, saleId: sale.id, type: 'LOYALTY' },
      });
      for (const [originalTenderId, amountMinor] of [
        [tender.id, 500],
        [cash.tenderId, total - 500],
      ] as const)
        await refundPharmacyTender(db, scope(), {
          originalTenderId,
          amountMinor,
          deviceId,
          businessDate: day,
          reason: 'Synthetic full refund',
          idempotencyKey: randomUUID(),
        });
      expect((await readCustomerSnapshot(db, scope(), customer.id)).pointsBalance).toBe(
        before.pointsBalance
      );
    });
  });
  it('rejects updates to the immutable settings audit', async () => {
    await expect(
      inTenant((db) =>
        db.pharmacyLoyaltySettingsAudit.updateMany({
          where: { organizationId },
          data: { actorId: id('owner') },
        })
      )
    ).rejects.toThrow('append only');
  });
  it('restores a partial points tender on void without earning', async () => {
    await inTenant(async (db) => {
      await savePointsPolicy(db, organizationId, id('owner'), {
        pointsEnabled: true,
        earnEveryMinor: 1000,
        pointValueMinor: 100,
        minimumRedeemPoints: 5,
      });
      const { sale, customer } = await basket(db);
      const before = (await readCustomerSnapshot(db, scope(), customer.id)).pointsBalance;
      await redeemSalePoints(db, scope(), {
        saleId: sale.id,
        points: 5,
        deviceId: randomUUID(),
        businessDate: day,
        idempotencyKey: randomUUID(),
      });
      await changeSaleStatus(db, scope(), sale.id, 'void', 'Synthetic cancelled bill');
      const tender = await db.pharmacyTender.findFirstOrThrow({
        where: { organizationId, saleId: sale.id, type: 'LOYALTY' },
        include: { refunds: true },
      });
      expect(tender.refunds.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(
        tender.amountMinor
      );
      await expect(
        refundPharmacyTender(db, scope(), {
          originalTenderId: tender.id,
          amountMinor: 100,
          deviceId: tender.deviceId,
          businessDate: day,
          reason: 'Must not double restore',
          idempotencyKey: randomUUID(),
        })
      ).rejects.toThrow('REFUND_EXCEEDS_TENDER');
      expect((await readCustomerSnapshot(db, scope(), customer.id)).pointsBalance).toBe(before);
      expect(
        await db.pharmacyLoyaltyPointsEntry.count({
          where: { organizationId, saleId: sale.id, kind: 'EARN' },
        })
      ).toBe(0);
    });
  });
});
