// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { PHARMACY_E2E as fixture } from '../../../tests/e2e/pharmacy-counter-fixture';
import { createSale, addSaleLine, readReturnHistory, returnSaleLine } from './sales';
import { linkCustomerToSale, redeemSalePoints } from './customer-loyalty';
import { applyPharmacyTender, openPharmacyDrawer, refundPharmacyTender } from './settlement';

const enabled = process.env.PHARMACY_E2E === '1' && !!process.env.PHARMACY_E2E_DATABASE_URL;
const scope = {
  organizationId: fixture.organizationId,
  branchId: fixture.branchId,
  actorId: fixture.adminId,
};
const day = new Date('2026-09-29');
const inTenant = <T>(work: Parameters<typeof withTenantDb<T>>[1]) =>
  withTenantDb(scope.organizationId, work);

describe.skipIf(!enabled)('return/refund disposable database acceptance', () => {
  it('restores loyalty, splits refunds, audits cash fallback, and serializes cumulative caps', async () => {
    const url = new URL(process.env.PHARMACY_E2E_DATABASE_URL!);
    expect(url.hostname).toBe('127.0.0.1');
    expect(Number(url.port)).toBeGreaterThanOrEqual(55600);
    expect(Number(url.port)).toBeLessThanOrEqual(55699);
    expect(url.pathname).toContain('disposable');
    const deviceId = `returns-${randomUUID()}`;
    const key = () => randomUUID();
    await inTenant(async (db) => {
      const roles = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
        Prisma.sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`
      );
      expect(roles[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      if (
        !(await db.patientConsent.findFirst({
          where: { patientId: fixture.patientId, purpose: 'LOYALTY' },
        }))
      ) {
        await db.patientConsent.create({
          data: {
            organizationId: scope.organizationId,
            patientId: fixture.patientId,
            purpose: 'LOYALTY',
            channel: 'IN_PERSON',
            version: 1,
            granted: true,
            recordedByUserId: scope.actorId,
          },
        });
      }
      await openPharmacyDrawer(db, scope, {
        deviceId,
        businessDate: day,
        openingFloatMinor: 10000,
      });
    });
    async function bill() {
      return inTenant(async (db) => {
        const sale = await createSale(db, scope);
        const { line } = await addSaleLine(db, scope, {
          saleId: sale.id,
          medicineId: fixture.medicines.otc.id,
          presentationId: fixture.medicines.otc.presentationId,
          packLevelId: fixture.medicines.otc.packLevelIds.strip,
          saleUnit: 'STRIP',
          quantity: 1,
          canonicalUnitsPerSaleUnit: 10,
          idempotencyKey: key(),
        });
        await linkCustomerToSale(db, scope, {
          saleId: sale.id,
          patientId: fixture.patientId,
          displayName: fixture.patientName,
        });
        return { sale, line };
      });
    }
    // Earn actual points through settlement, rather than seeding a fabricated redemption.
    const earned = await bill();
    await inTenant((db) =>
      applyPharmacyTender(db, scope, {
        saleId: earned.sale.id,
        deviceId,
        businessDate: day,
        type: 'CASH',
        amountMinor: 2500,
        cashReceivedMinor: 2500,
        idempotencyKey: key(),
      })
    );
    const sold = await bill();
    await inTenant((db) =>
      redeemSalePoints(db, scope, {
        saleId: sold.sale.id,
        points: 5,
        deviceId,
        businessDate: day,
        idempotencyKey: key(),
      })
    );
    await inTenant((db) =>
      applyPharmacyTender(db, scope, {
        saleId: sold.sale.id,
        deviceId,
        businessDate: day,
        type: 'CASH',
        amountMinor: 1000,
        cashReceivedMinor: 1000,
        idempotencyKey: key(),
      })
    );
    await inTenant((db) =>
      applyPharmacyTender(db, scope, {
        saleId: sold.sale.id,
        deviceId,
        businessDate: day,
        type: 'CARD',
        amountMinor: 1000,
        idempotencyKey: key(),
        adapter: {
          name: 'TEST',
          certified: true,
          execute: async () => ({ approved: true, providerRef: 'test-sale' }),
        },
      })
    );
    const history = () => inTenant((db) => readReturnHistory(db, scope, sold.sale.id));
    const before = await history();
    const tenderId = (type: string) => before.tenders.find((row) => row.type === type)!.id;
    const returnInput = {
      saleLineId: sold.line.id,
      canonicalUnits: 5,
      disposition: 'RESTOCK' as const,
      reason: 'WRONG_ITEM',
      integrityDecision: 'Intact strip; storage verified',
      idempotencyKey: key(),
    };
    await inTenant((db) => returnSaleLine(db, scope, returnInput));
    const replay = await inTenant((db) => returnSaleLine(db, scope, returnInput));
    expect(replay.replayed).toBe(true);
    expect((await history()).lines[0].returnedUnits).toBe(5);
    const refund = (type: string, amountMinor: number, idempotencyKey = key()) =>
      inTenant((db) =>
        refundPharmacyTender(db, scope, {
          originalTenderId: tenderId(type),
          deviceId,
          businessDate: day,
          amountMinor,
          reason: 'WRONG_ITEM',
          idempotencyKey,
          requireReturnedValue: true,
          manualCashFallback: type === 'CARD',
        })
      );
    const loyaltyKey = key();
    await refund('LOYALTY', 500, loyaltyKey);
    await refund('LOYALTY', 500, loyaltyKey);
    await refund('CASH', 500);
    await refund('CARD', 250);
    const partial = await history();
    expect(partial.refundableMinor).toBe(0);
    expect(
      partial.tenders.find((row) => row.type === 'CARD')!.refunds[0].manualReversalRequired
    ).toBe(true);
    await expect(refund('CARD', 1)).rejects.toThrow('REFUND_EXCEEDS_TENDER');
    await inTenant(async (db) => {
      const points = await db.pharmacyLoyaltyPointsEntry.findMany({
        where: { saleId: sold.sale.id, kind: 'REFUND' },
      });
      expect(points).toHaveLength(1);
      expect(points[0].points).toBe(5);
      expect(points[0].refundId).toBeTruthy();
    });
    await inTenant((db) =>
      returnSaleLine(db, scope, {
        ...returnInput,
        disposition: 'QUARANTINE',
        quarantineLocationId: fixture.quarantineLocationId,
        idempotencyKey: key(),
      })
    );
    const race = await Promise.allSettled([refund('CASH', 500), refund('CASH', 500)]);
    expect(race.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const final = await history();
    expect(final.lines[0].returnedUnits).toBe(10);
    expect(final.tenders.find((row) => row.type === 'CASH')!.refundedMinor).toBe(1000);
    await expect(
      inTenant((db) =>
        returnSaleLine(db, scope, { ...returnInput, idempotencyKey: key(), canonicalUnits: 1 })
      )
    ).rejects.toThrow('RETURN_EXCEEDS_SOLD');
  }, 30000);
});
