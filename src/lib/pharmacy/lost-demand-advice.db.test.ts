/**
 * DEV-80 — lost-demand advice tables against PostgreSQL under RLS.
 *
 * Settings and decisions are invisible to another tenant; decisions are
 * append-only except for the sanctioned purge of their own tenant; and the
 * DRAFT-conditional flip that allocates a transfer request lets exactly one of
 * two concurrent allocations through.
 * Skipped unless TEST_DATABASE_URL is set (a NOSUPERUSER NOBYPASSRLS role).
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const client = url ? db : null;
const describeIfDatabase = url ? describe : describe.skip;

const orgA = `org_ld80_a_${randomUUID()}`;
const orgB = `org_ld80_b_${randomUUID()}`;
const branchA = `br_ld80_a_${randomUUID()}`;
const branchA2 = `br_ld80_a2_${randomUUID()}`;
const actorId = `ld80-actor-${randomUUID()}`;

function inOrg<T>(
  organizationId: string,
  work: (db: ScopedDb) => Promise<T>,
  extra: Record<string, string> = {}
) {
  if (!client) throw new Error('TEST_DATABASE_URL required');
  return client.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)",
        organizationId
      );
      for (const [key, value] of Object.entries(extra))
        await tx.$queryRawUnsafe('SELECT set_config($1, $2, true)', key, value);
      return work(tx as ScopedDb);
    },
    { timeout: 30_000 }
  );
}

let decisionId: string;
let transferId: string;

beforeAll(async () => {
  if (!client) return;
  await client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.is_platform_admin', 'true', true)");
    for (const org of [orgA, orgB]) {
      await tx.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
        org
      );
    }
  });
  await inOrg(orgA, async (dbx) => {
    for (const id of [branchA, branchA2]) {
      await dbx.pharmacyBranch.create({
        data: {
          id,
          organizationId: orgA,
          code: id,
          name: 'Lost demand test',
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
    }
    await dbx.pharmacyLostDemandTriggerSetting.create({
      data: { organizationId: orgA, branchId: branchA, updatedByUserId: actorId },
    });
    const decision = await dbx.pharmacyLostDemandAdviceDecision.create({
      data: {
        organizationId: orgA,
        branchId: branchA,
        demandKey: 'sku:medicine_a',
        decision: 'IGNORED',
        actorUserId: actorId,
      },
    });
    decisionId = decision.id;
    const transfer = await dbx.pharmacyInterbranchTransfer.create({
      data: {
        organizationId: orgA,
        fromBranchId: branchA2,
        toBranchId: branchA,
        status: 'DRAFT',
        allocatedById: actorId,
      },
    });
    transferId = transfer.id;
  });
});
afterAll(() => client?.$disconnect());

describeIfDatabase('lost-demand advice tables (DEV-80)', () => {
  it('hides one tenant settings and decisions from another', async () => {
    await inOrg(orgB, async (dbx) => {
      expect(
        await dbx.pharmacyLostDemandTriggerSetting.count({ where: { branchId: branchA } })
      ).toBe(0);
      expect(await dbx.pharmacyLostDemandAdviceDecision.count({ where: { id: decisionId } })).toBe(
        0
      );
    });
    await inOrg(orgA, async (dbx) => {
      expect(
        await dbx.pharmacyLostDemandTriggerSetting.count({ where: { branchId: branchA } })
      ).toBe(1);
    });
  });

  it('refuses a decision written under another tenant', async () => {
    await expect(
      inOrg(orgB, (dbx) =>
        dbx.pharmacyLostDemandAdviceDecision.create({
          data: {
            organizationId: orgA,
            branchId: branchA,
            demandKey: 'sku:medicine_a',
            decision: 'IGNORED',
            actorUserId: actorId,
          },
        })
      )
    ).rejects.toThrow();
  });

  it('keeps decisions append-only', async () => {
    await expect(
      inOrg(orgA, (dbx) =>
        dbx.pharmacyLostDemandAdviceDecision.update({
          where: { id: decisionId },
          data: { reason: 'rewritten' },
        })
      )
    ).rejects.toThrow(/append-only/);
    await expect(
      inOrg(orgA, (dbx) =>
        dbx.pharmacyLostDemandAdviceDecision.delete({ where: { id: decisionId } })
      )
    ).rejects.toThrow(/append-only/);
    // A purge context naming a different tenant authorises nothing here.
    await expect(
      inOrg(
        orgA,
        (dbx) => dbx.pharmacyLostDemandAdviceDecision.delete({ where: { id: decisionId } }),
        { 'app.purging_organization_id': orgB }
      )
    ).rejects.toThrow(/append-only/);
  });

  it('lets exactly one of two concurrent allocations flip a DRAFT request', async () => {
    const flip = (actor: string) =>
      inOrg(orgA, (dbx) =>
        dbx.pharmacyInterbranchTransfer.updateMany({
          where: { id: transferId, organizationId: orgA, status: 'DRAFT' },
          data: { status: 'ALLOCATED', allocatedById: actor },
        })
      );
    const results = await Promise.all([flip('allocator-1'), flip('allocator-2')]);
    expect(results.map((result) => result.count).sort()).toEqual([0, 1]);
    await inOrg(orgA, async (dbx) => {
      const transfer = await dbx.pharmacyInterbranchTransfer.findFirstOrThrow({
        where: { id: transferId },
      });
      expect(transfer.status).toBe('ALLOCATED');
    });
  });

  const purgeDecisions = (extra: Record<string, string>) =>
    inOrg(
      orgA,
      (dbx) =>
        dbx.$executeRawUnsafe(
          'DELETE FROM "pharmacy_lost_demand_advice_decisions" WHERE "organizationId" = $1',
          orgA
        ),
      extra
    );

  it('refuses a tenant transaction that names its own organization as purged', async () => {
    await expect(purgeDecisions({ 'app.purging_organization_id': orgA })).rejects.toThrow(
      /append-only/
    );
  });

  it('lets the platform purge of its own tenant remove decisions', async () => {
    const removed = await purgeDecisions({
      'app.purging_organization_id': orgA,
      'app.is_platform_admin': 'true',
    });
    expect(removed).toBe(1);
  });
});

describeIfDatabase('DEV-991 customer asked for it', () => {
  it('records a request once across concurrent retries without creating stock or a sale', async () => {
    const { recordCounterDemand } = await import('./sales');
    const input = {
      requestId: randomUUID(),
      requestedText: 'Synthetic request',
      quantity: 3,
      reason: 'NOT_CARRIED' as const,
    };
    const record = () =>
      inOrg(orgA, (dbx) =>
        recordCounterDemand(dbx, { organizationId: orgA, branchId: branchA, actorId }, input)
      );
    const [a, b] = await Promise.all([record(), record()]);
    expect(a.id).toBe(b.id);
    await inOrg(orgA, async (dbx) => {
      const where = { organizationId: orgA, branchId: branchA };
      expect(await dbx.unfulfilledDemandEvent.findMany({ where })).toMatchObject([
        { id: a.id, quantity: 3, saleId: null, capturedByUserId: actorId },
      ]);
      expect(await dbx.pharmacySale.count({ where })).toBe(0);
      expect(await dbx.pharmacyInventoryLot.count({ where })).toBe(0);
    });
  });

  it('shares open shortfall captures and records a substitute decline separately on the same bill', async () => {
    const { captureDemand } = await import('./sales');
    const { declineSubstitute } = await import('./substitute-finder');
    const scope = { organizationId: orgA, branchId: branchA2, actorId };
    await inOrg(orgA, async (dbx) => {
      const sale = await dbx.pharmacySale.create({
        data: {
          organizationId: orgA,
          branchId: branchA2,
          createdByUserId: actorId,
          status: 'OPEN',
        },
      });
      const medicine = await dbx.medicine.create({
        data: {
          organizationId: orgA,
          productName: 'Synthetic shortfall',
          productFamily: 'PHARMACEUTICAL',
        },
      });
      const input = {
        saleId: sale.id,
        requestedMedicineId: medicine.id,
        saleUnit: 'UNIT' as const,
        quantity: 2,
        inventoryRuleSnapshot: {},
      };
      const shortfall = await captureDemand(dbx, scope, {
        ...input,
        reason: 'STOCKOUT',
        shareBillDemand: true,
      });
      const declined = await captureDemand(dbx, scope, {
        ...input,
        quantity: 1,
        reason: 'SUBSTITUTE_DECLINED',
      });
      expect(declined.id).not.toBe(shortfall.id);
      await expect(declineSubstitute(dbx, scope, declined.id)).resolves.toMatchObject({
        reason: 'SUBSTITUTE_DECLINED',
        status: 'CLOSED',
      });

      await expect(
        captureDemand(dbx, scope, {
          ...input,
          quantity: 3,
          reason: 'STOCKOUT',
          shareBillDemand: true,
        })
      ).resolves.toMatchObject({ id: shortfall.id, status: 'OPEN', quantity: 2 });

      await dbx.unfulfilledDemandEvent.update({
        where: { id: shortfall.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      const fresh = await captureDemand(dbx, scope, {
        ...input,
        reason: 'STOCKOUT',
        shareBillDemand: true,
      });
      expect(fresh.id).not.toBe(shortfall.id);
      expect(fresh.status).toBe('OPEN');
    });
  });
});

describeIfDatabase('DEV-991 notify and reserve choices', () => {
  it('uses the linked retail customer’s reminder consent and records only a future reserve request', async () => {
    const { recordCounterDemand } = await import('./sales');
    const scope = { organizationId: orgA, branchId: branchA, actorId };
    const { medicine, patient, customer } = await inOrg(orgA, async (tx) => {
      const medicine = await tx.medicine.create({
        data: {
          organizationId: orgA,
          productName: 'Synthetic demand',
          productFamily: 'PHARMACEUTICAL',
        },
      });
      const patient = await tx.pharmacyPatient.create({
        data: { organizationId: orgA, displayName: 'Test reminder contact' },
      });
      const customer = await tx.pharmacyCustomer.create({
        data: { organizationId: orgA, patientId: patient.id, displayName: 'Test customer' },
      });
      return { medicine, patient, customer };
    });
    const input = {
      requestId: randomUUID(),
      requestedText: medicine.productName,
      requestedMedicineId: medicine.id,
      quantity: 2,
      reason: 'STOCKOUT' as const,
      followUp: { customerId: customer.id, channel: 'SMS' as const, reserveOnArrival: true },
    };
    const record = () => inOrg(orgA, (dbx) => recordCounterDemand(dbx, scope, input));
    await expect(record()).rejects.toThrow(/CONSENT_REQUIRED/);
    await inOrg(orgA, async (dbx) => {
      expect(
        await dbx.unfulfilledDemandEvent.count({ where: { requestedMedicineId: medicine.id } })
      ).toBe(0);
      await dbx.patientConsent.create({
        data: {
          organizationId: orgA,
          patientId: patient.id,
          purpose: 'REMINDERS',
          channel: 'SMS',
          version: 1,
          granted: true,
          recordedByUserId: actorId,
        },
      });
    });
    const { id } = await record();
    await inOrg(
      orgA,
      async (dbx) => {
        expect(
          await dbx.pharmacyRestockInterest.findMany({ where: { demandEventId: id } })
        ).toMatchObject([
          {
            patientId: patient.id,
            channel: 'SMS',
            reserveOnArrival: true,
            quantityUnits: 2,
            status: 'OPEN',
          },
        ]);
        expect(await dbx.pharmacySale.count({ where: { branchId: branchA } })).toBe(0);
        expect(await dbx.pharmacyInventoryLot.count({ where: { branchId: branchA } })).toBe(0);
      },
      { 'app.current_branch_id': branchA }
    );
  });
});
