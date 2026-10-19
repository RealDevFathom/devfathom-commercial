// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveMarketingTemplate,
  createMarketingDraft,
  approveMarketingCampaign,
  captureMarketingCampaign,
  type MarketingScope,
} from './marketing-service';
import { eligibleMarketingReceipts, generateMarketingAttribution } from './marketing-attribution';
import { readPharmacyMarketingReport } from './marketing-report';
import { receiveLot } from './stock-ledger';
import { createSale, addSaleLine, changeSaleStatus } from './sales';
import { postSaleLineEntry, postSaleReturnEntry } from './finance-postings';
import { lockCustomerConsent, writePatientConsent } from './consent-writer';
import {
  dispatchSandboxCampaign,
  recordMarketingCallback,
  reserveSandboxAttempt,
  campaignDeliveryHistory,
  reconcileDelivery,
  type MarketingTransaction,
} from './marketing-delivery';

// Explicit admission + dedicated URLs only. Never fall back to DATABASE_URL or a shared test DB.
const admitted = process.env.PHARMACY_MARKETING_DB_ADMITTED === 'true';
const runtimeUrl = process.env.PHARMACY_MARKETING_TEST_RUNTIME_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_MARKETING_TEST_OWNER_DATABASE_URL;
const enabled = admitted && Boolean(runtimeUrl && ownerUrl);
const suite = enabled ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '');
const org = `mkt_${suffix}`,
  otherOrg = `mkt_other_${suffix}`;
const branch = `branch_${suffix}`,
  sibling = `sibling_${suffix}`;
const now = new Date('2026-10-06T12:00:00Z');
let owner: Client;
let prisma: PrismaClient;
const scope: MarketingScope = {
  organizationId: org,
  branchId: branch,
  actorId: 'synthetic-owner',
  timezone: 'UTC',
};
async function tx<T>(
  run: (db: ScopedDb) => Promise<T>,
  organizationId = org,
  branchId = '',
  platformAdmin = false
) {
  return prisma.$transaction(async (db) => {
    await db.$queryRawUnsafe(
      `SELECT set_config('app.current_organization_id',$1,true), set_config('app.current_branch_id',$2,true), set_config('app.is_platform_admin',$3,true)`,
      organizationId,
      branchId,
      String(platformAdmin)
    );
    return run(db as ScopedDb);
  });
}
const transaction: MarketingTransaction = (run) => tx((db) => run(db, scope));
async function fixture() {
  const patientId = `p_${randomUUID()}`,
    customerId = `c_${randomUUID()}`;
  const result = await tx(async (db) => {
    await db.pharmacyPatient.create({
      data: { id: patientId, organizationId: org, displayName: 'Synthetic patient' },
    });
    await db.pharmacyCustomer.create({
      data: {
        id: customerId,
        organizationId: org,
        patientId,
        displayName: 'Synthetic customer',
        active: true,
        whatsappOptIn: true,
      },
    });
    await writePatientConsent(
      db,
      org,
      scope.actorId,
      { patientId, purpose: 'MARKETING', channel: 'WHATSAPP', granted: true },
      now
    );
    const template = await approveMarketingTemplate(
      db,
      scope,
      { branchId: branch, name: randomUUID(), body: 'Store update. Reply STOP.', reviewed: true },
      now
    );
    const campaign = await createMarketingDraft(db, scope, {
      branchId: branch,
      name: randomUUID(),
      templateId: template.id,
      definition: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
      scheduledAt: now,
      quietHours: { startHour: 22, endHour: 8 },
      frequencyCap: { max: 1, windowDays: 7 },
      promotesRegulatedItem: false,
    });
    await approveMarketingCampaign(db, scope, campaign.id, now);
    const capture = await db.pharmacyCampaignCapture.create({
      data: {
        organizationId: org,
        branchId: branch,
        campaignId: campaign.id,
        customerId,
        channel: 'WHATSAPP',
        idempotencyKey: randomUUID(),
        capturedAt: now,
      },
    });
    await db.pharmacyCampaign.update({ where: { id: campaign.id }, data: { status: 'CAPTURED' } });
    return { campaignId: campaign.id, captureId: capture.id };
  });
  return {
    ...result,
    customerId,
    patientId,
    input: {
      branchId: branch,
      campaignId: result.campaignId,
      requestKey: randomUUID(),
      outcome: 'DELIVERED' as const,
      retry: false,
    },
  };
}
beforeAll(async () => {
  if (!enabled) return;
  expect(runtimeUrl).not.toBe(ownerUrl);
  for (const value of [runtimeUrl!, ownerUrl!]) {
    const url = new URL(value);
    expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
    expect(url.port).toBe('55625'); // newly admitted disposable lane only
  }
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl! }) });
  await owner.query(`SELECT set_config('app.is_platform_admin','true',false)`);
  await owner.query(
    `INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,"deploymentMode","createdAt","updatedAt")
    VALUES ($1,$1,'Synthetic marketing','Synthetic marketing','PHARMACY','ACTIVE','SHARED',now(),now()),
    ($2,$2,'Synthetic other','Synthetic other','PHARMACY','ACTIVE','SHARED',now(),now())`,
    [org, otherOrg]
  );
  await owner.query(
    `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode",active,"createdAt","updatedAt")
    VALUES ($1,$3,'A','Synthetic A','Test','Lahore','PB',true,now(),now()),($2,$3,'B','Synthetic B','Test','Lahore','PB',true,now(),now())`,
    [branch, sibling, org]
  );
});
afterAll(async () => {
  if (enabled) {
    await prisma?.$disconnect();
    await owner?.end();
  }
});

suite('marketing persisted restricted-role acceptance', () => {
  it('uses a restricted role and forced RLS on both append-only tables', async () => {
    await tx(async (db) => {
      expect(
        await db.$queryRawUnsafe(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tables = await db.$queryRawUnsafe<
        Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >(
        `SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('pharmacy_campaign_dispatch_attempts','pharmacy_campaign_delivery_events')`
      );
      expect(tables).toHaveLength(2);
      expect(tables.every((t) => t.relrowsecurity && t.relforcerowsecurity)).toBe(true);
    });
  });
  it('double-dispatch commits one attempt and sandbox acceptance/delivery only once', async () => {
    const f = await fixture();
    await Promise.all([
      dispatchSandboxCampaign(transaction, f.input, now),
      dispatchSandboxCampaign(transaction, f.input, now),
    ]);
    const result = await dispatchSandboxCampaign(transaction, f.input, now);
    expect(result).toMatchObject({ accepted: 1, delivered: 1, attempted: 1 });
    expect(result.attempts).toHaveLength(1);
  });
  it('permits retry only after definite rejection; timeout and empty reservation never resend', async () => {
    const f = await fixture();
    await dispatchSandboxCampaign(transaction, { ...f.input, outcome: 'REJECTED' }, now);
    expect(
      (
        await dispatchSandboxCampaign(
          transaction,
          { ...f.input, requestKey: 'retry', retry: true },
          now
        )
      ).attempts
    ).toHaveLength(2);
    const timeout = await fixture();
    await dispatchSandboxCampaign(transaction, { ...timeout.input, outcome: 'TIMEOUT' }, now);
    expect(
      (
        await dispatchSandboxCampaign(
          transaction,
          { ...timeout.input, requestKey: 'retry', retry: true },
          now
        )
      ).attempts
    ).toHaveLength(1);
    const crashed = await fixture();
    await tx((db) => reserveSandboxAttempt(db, scope, crashed.captureId, crashed.input, now));
    const result = await dispatchSandboxCampaign(
      transaction,
      { ...crashed.input, requestKey: 'retry', retry: true },
      now
    );
    expect(result).toMatchObject({ unknown: 1, accepted: 0 });
    expect(result.attempts).toHaveLength(1);
  });
  it('denies cross-tenant and sibling-branch reads/writes and immutable mutation', async () => {
    const f = await fixture();
    const result = await dispatchSandboxCampaign(transaction, f.input, now);
    const attemptId = result.attempts[0].id;
    for (const platformAdmin of [false, true]) {
      for (const [organizationId, branchId] of [
        [otherOrg, ''],
        [org, sibling],
      ]) {
        expect(
          await tx(
            (db) => db.pharmacyCampaignDispatchAttempt.findMany({ where: { id: attemptId } }),
            organizationId,
            branchId,
            platformAdmin
          )
        ).toEqual([]);
        expect(
          await tx(
            (db) => db.pharmacyCampaignDeliveryEvent.findMany({ where: { attemptId } }),
            organizationId,
            branchId,
            platformAdmin
          )
        ).toEqual([]);
        await expect(
          tx(
            (db) =>
              db.pharmacyCampaignDispatchAttempt.create({
                data: {
                  organizationId: org,
                  captureId: f.captureId,
                  requestKey: randomUUID(),
                  attemptNumber: 99,
                  provider: 'sandbox',
                  senderId: 'sandbox-local-v1',
                  sandboxOutcome: 'DELIVERED',
                },
              }),
            organizationId,
            branchId,
            platformAdmin
          )
        ).rejects.toThrow();
        await expect(
          tx(
            (db) =>
              db.pharmacyCampaignDeliveryEvent.create({
                data: {
                  organizationId: org,
                  attemptId,
                  provider: 'sandbox',
                  senderId: 'sandbox-local-v1',
                  eventKey: randomUUID(),
                  state: 'UNKNOWN',
                  reason: 'TRANSPORT_UNKNOWN',
                  occurredAt: now,
                },
              }),
            organizationId,
            branchId,
            platformAdmin
          )
        ).rejects.toThrow();
      }
    }
    await expect(
      tx((db) =>
        db.pharmacyCampaignDispatchAttempt.update({
          where: { id: attemptId },
          data: { senderId: 'rebound' },
        })
      )
    ).rejects.toThrow();
    await expect(
      tx((db) => db.pharmacyCampaignDispatchAttempt.delete({ where: { id: attemptId } }))
    ).rejects.toThrow();
    await expect(
      tx((db) =>
        db.pharmacyCampaignDeliveryEvent.updateMany({
          where: { attemptId },
          data: { state: 'FAILED' },
        })
      )
    ).rejects.toThrow();
    await expect(
      tx((db) => db.pharmacyCampaignDeliveryEvent.deleteMany({ where: { attemptId } }))
    ).rejects.toThrow();
    await expect(
      tx((db) =>
        db.pharmacyCampaignCapture.update({
          where: { id: f.captureId },
          data: { branchId: sibling },
        })
      )
    ).rejects.toThrow();
  });
  it('serializes purpose revocation with dispatch, and assigns unique server versions concurrently', async () => {
    const f = await fixture();
    let release!: () => void, locked!: () => void;
    const holding = new Promise<void>((r) => {
      release = r;
    });
    const acquired = new Promise<void>((r) => {
      locked = r;
    });
    const revoke = tx(async (db) => {
      await writePatientConsent(
        db,
        org,
        scope.actorId,
        { patientId: f.patientId, purpose: 'MARKETING', channel: 'WHATSAPP', granted: false },
        now
      );
      locked();
      await holding;
    });
    await acquired;
    const dispatch = dispatchSandboxCampaign(transaction, f.input, now);
    release();
    await revoke;
    expect(await dispatch).toMatchObject({ suppressed: 1, accepted: 0 });
    const versions = await Promise.all(
      [true, false].map((granted) =>
        tx((db) =>
          writePatientConsent(
            db,
            org,
            scope.actorId,
            { patientId: f.patientId, purpose: 'MARKETING', channel: 'WHATSAPP', granted },
            now
          )
        )
      )
    );
    expect(versions.map((v) => v.version).sort()).toEqual([3, 4]);
  });
  it('serializes global STOP with dispatch using the same patient/customer protocol', async () => {
    const f = await fixture();
    let release!: () => void, locked!: () => void;
    const holding = new Promise<void>((r) => {
        release = r;
      }),
      acquired = new Promise<void>((r) => {
        locked = r;
      });
    const stop = tx(async (db) => {
      await lockCustomerConsent(db, org, f.customerId);
      await db.pharmacyCustomer.update({
        where: { id: f.customerId },
        data: { whatsappOptIn: false, whatsappOptInChangedAt: now },
      });
      locked();
      await holding;
    });
    await acquired;
    const dispatch = dispatchSandboxCampaign(transaction, f.input, now);
    release();
    await stop;
    expect(await dispatch).toMatchObject({ suppressed: 1, attempted: 0 });
  });
  it('binds Meta callback identity, tolerates replay/order, and preserves contradictions', async () => {
    const f = await fixture(),
      senderId = `sender_${randomUUID()}`,
      messageId = `message_${randomUUID()}`;
    const acceptance = await tx(async (db) => {
      const attempt = await db.pharmacyCampaignDispatchAttempt.create({
        data: {
          organizationId: org,
          captureId: f.captureId,
          requestKey: 'synthetic-meta',
          attemptNumber: 1,
          provider: 'meta',
          senderId,
        },
      });
      return db.pharmacyCampaignDeliveryEvent.create({
        data: {
          organizationId: org,
          attemptId: attempt.id,
          provider: 'meta',
          senderId,
          providerMessageId: messageId,
          eventKey: randomUUID(),
          state: 'PROVIDER_ACCEPTED',
          occurredAt: now,
        },
      });
    });
    const callback = { senderId, messageId, state: 'DELIVERED' as const, occurredAt: now };
    expect(await tx((db) => recordMarketingCallback(db, org, 'wrong', callback, now))).toBe(
      'REJECTED'
    );
    expect(await tx((db) => recordMarketingCallback(db, org, senderId, callback, now))).toBe(
      'RECORDED'
    );
    expect(await tx((db) => recordMarketingCallback(db, org, senderId, callback, now))).toBe(
      'REPLAY'
    );
    await tx((db) =>
      recordMarketingCallback(
        db,
        org,
        senderId,
        { ...callback, state: 'FAILED', occurredAt: new Date(now.getTime() - 1000) },
        now
      )
    );
    expect(
      await tx((db) =>
        db.pharmacyCampaignDeliveryEvent.count({ where: { attemptId: acceptance.attemptId } })
      )
    ).toBe(3);
    expect(
      reconcileDelivery(
        await tx((db) =>
          db.pharmacyCampaignDeliveryEvent.findMany({ where: { attemptId: acceptance.attemptId } })
        )
      )
    ).toMatchObject({ contradictory: true, unknown: true, retryable: false });
    await expect(
      tx((db) =>
        db.pharmacyCampaignDeliveryEvent.create({
          data: {
            organizationId: org,
            attemptId: acceptance.attemptId,
            provider: 'meta',
            senderId,
            providerMessageId: 'rebound',
            acceptanceId: acceptance.id,
            eventKey: randomUUID(),
            state: 'DELIVERED',
            occurredAt: now,
          },
        })
      )
    ).rejects.toThrow();
  });
  it('concurrent capture campaigns share one customer frequency cap', async () => {
    const patientId = `p_${randomUUID()}`,
      customerId = `c_${randomUUID()}`;
    const campaigns = await tx(async (db) => {
      await db.pharmacyPatient.create({
        data: { id: patientId, organizationId: org, displayName: 'Synthetic' },
      });
      await db.pharmacyCustomer.create({
        data: {
          id: customerId,
          organizationId: org,
          patientId,
          displayName: 'Synthetic',
          whatsappOptIn: true,
        },
      });
      await writePatientConsent(
        db,
        org,
        scope.actorId,
        { patientId, purpose: 'MARKETING', channel: 'WHATSAPP', granted: true },
        now
      );
      await db.pharmacySale.create({
        data: {
          organizationId: org,
          branchId: branch,
          customerId,
          createdByUserId: scope.actorId,
          status: 'COMPLETED',
          completedAt: now,
          receiptNumber: 1,
        },
      });
      const template = await approveMarketingTemplate(
        db,
        scope,
        { branchId: branch, name: randomUUID(), body: 'Store update. Reply STOP.', reviewed: true },
        now
      );
      const ids = [];
      for (let n = 0; n < 2; n++) {
        const c = await createMarketingDraft(db, scope, {
          branchId: branch,
          name: randomUUID(),
          templateId: template.id,
          definition: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
          scheduledAt: now,
          quietHours: { startHour: 22, endHour: 8 },
          frequencyCap: { max: 1, windowDays: 7 },
          promotesRegulatedItem: false,
        });
        await approveMarketingCampaign(db, scope, c.id, now);
        ids.push(c.id);
      }
      return ids;
    });
    await Promise.all(
      campaigns.map((id) => tx((db) => captureMarketingCampaign(db, scope, id, now)))
    );
    expect(await tx((db) => db.pharmacyCampaignCapture.count({ where: { customerId } }))).toBe(1);
  });

  it('rejects FAILED without a reason, with and without acceptance identity', async () => {
    const f = await fixture();
    const result = await dispatchSandboxCampaign(transaction, f.input, now);
    const acceptance = await tx((db) =>
      db.pharmacyCampaignDeliveryEvent.findFirstOrThrow({
        where: { attemptId: result.attempts[0].id, state: 'PROVIDER_ACCEPTED' },
      })
    );
    for (const bound of [false, true]) {
      await expect(
        tx((db) =>
          db.pharmacyCampaignDeliveryEvent.create({
            data: {
              organizationId: org,
              attemptId: acceptance.attemptId,
              provider: 'sandbox',
              senderId: 'sandbox-local-v1',
              eventKey: randomUUID(),
              state: 'FAILED',
              reason: null,
              occurredAt: now,
              acceptanceId: bound ? acceptance.id : null,
              providerMessageId: bound ? acceptance.providerMessageId : null,
            },
          })
        )
      ).rejects.toThrow(/check constraint/);
    }
  });
  it('sandbox history excludes Meta failures and pending reservations', async () => {
    const f = await fixture();
    await dispatchSandboxCampaign(transaction, f.input, now);
    await tx(async (db) => {
      for (const n of [2, 3]) {
        const a = await db.pharmacyCampaignDispatchAttempt.create({
          data: {
            organizationId: org,
            captureId: f.captureId,
            requestKey: randomUUID(),
            attemptNumber: n,
            provider: 'meta',
            senderId: 'synthetic',
          },
        });
        if (n === 2)
          await db.pharmacyCampaignDeliveryEvent.create({
            data: {
              organizationId: org,
              attemptId: a.id,
              eventKey: randomUUID(),
              state: 'FAILED',
              provider: 'meta',
              senderId: 'synthetic',
              reason: 'DEFINITE_REJECTION',
              occurredAt: now,
            },
          });
      }
    });
    const history = await tx((db) => campaignDeliveryHistory(db, scope, f.campaignId));
    expect(history).toMatchObject({
      attempted: 1,
      accepted: 1,
      delivered: 1,
      failed: 0,
      unknown: 0,
      suppressed: 0,
    });
    expect(history.attempts).toHaveLength(1);
  });
  it('database event rollback leaves reservation unresolved and cannot resend', async () => {
    const f = await fixture();
    let count = 0;
    const failing: MarketingTransaction = (run) =>
      tx(async (db) => {
        const result = await run(db, scope);
        if (++count === 3) throw new Error('synthetic persistence rollback');
        return result;
      });
    await expect(dispatchSandboxCampaign(failing, f.input, now)).rejects.toThrow(
      'synthetic persistence rollback'
    );
    const history = await dispatchSandboxCampaign(
      transaction,
      { ...f.input, requestKey: 'retry-after-rollback', retry: true },
      now
    );
    expect(history).toMatchObject({ unknown: 1, accepted: 0, delivered: 0 });
    expect(history.attempts).toHaveLength(1);
  });
  it('reconciles actual allocation journal amounts and partial/full returns at report cutoffs', async () => {
    const f = await fixture();
    // Synthetic Meta evidence only; no provider call. Dates separate posting cutoffs.
    await tx(async (db) => {
      const a = await db.pharmacyCampaignDispatchAttempt.create({
        data: {
          organizationId: org,
          captureId: f.captureId,
          requestKey: randomUUID(),
          attemptNumber: 1,
          provider: 'meta',
          senderId: 'synthetic-receipt',
        },
      });
      const accepted = await db.pharmacyCampaignDeliveryEvent.create({
        data: {
          organizationId: org,
          attemptId: a.id,
          eventKey: randomUUID(),
          provider: 'meta',
          senderId: a.senderId,
          state: 'PROVIDER_ACCEPTED',
          providerMessageId: randomUUID(),
          occurredAt: now,
          recordedAt: now,
        },
      });
      await db.pharmacyCampaignDeliveryEvent.create({
        data: {
          organizationId: org,
          attemptId: a.id,
          eventKey: randomUUID(),
          provider: 'meta',
          senderId: a.senderId,
          state: 'DELIVERED',
          providerMessageId: accepted.providerMessageId,
          acceptanceId: accepted.id,
          occurredAt: now,
          recordedAt: now,
        },
      });
    });
    const receipt = (
      override: {
        receiptNumber?: number | null;
        status?: 'OPEN' | 'COMPLETED';
        customerId?: string | null;
        completedAt?: Date;
        branchId?: string;
      } = {}
    ) =>
      tx(async (db) => {
        const receiptScope = { ...scope, branchId: override.branchId ?? branch };
        const medicine = await db.medicine.create({
          data: {
            organizationId: org,
            productName: 'Synthetic OTC fixture',
            productFamily: 'PHARMACEUTICAL',
            saleable: true,
            presentations: { create: { organizationId: org, presentation: 'Synthetic strip' } },
          },
          include: { presentations: true },
        });
        const pack = await db.packLevel.create({
          data: {
            organizationId: org,
            presentationId: medicine.presentations[0].id,
            versionGroupId: randomUUID(),
            version: 1,
            level: 'STRIP',
            unitsPerParent: 10,
            effectiveFrom: new Date('2026-01-01'),
          },
        });
        const location = await db.pharmacyStockLocation.create({
          data: {
            organizationId: org,
            branchId: receiptScope.branchId,
            code: randomUUID(),
            name: 'Synthetic store',
            kind: 'STORE',
          },
        });
        // Two exact landed costs expose averaged/per-sale-unit cost arithmetic defects.
        for (const [units, cost] of [
          [10, 21],
          [10, 34],
        ]) {
          const batch = await db.pharmacyManufacturingBatch.create({
            data: {
              organizationId: org,
              medicineId: medicine.id,
              batchNumber: randomUUID(),
              expiresAt: new Date('2028-01-01'),
              expiryPrecision: 'DAY',
            },
          });
          await receiveLot(db, receiptScope, {
            manufacturingBatchId: batch.id,
            packLevelId: pack.id,
            stockLocationId: location.id,
            unitsPerPack: 1,
            supplierName: 'Synthetic supplier',
            supplierInvoiceRef: randomUUID(),
            unitCostMinor: cost,
            printedMrpMinor: 100,
            receivedExpiresAt: new Date('2028-01-01'),
            receivedExpiryPrecision: 'DAY',
            quantityUnits: units,
            idempotencyKey: randomUUID(),
            receivedAt: now,
          });
        }
        const sale = await createSale(db, receiptScope);
        const { line } = await addSaleLine(db, receiptScope, {
          saleId: sale.id,
          medicineId: medicine.id,
          presentationId: medicine.presentations[0].id,
          packLevelId: pack.id,
          saleUnit: 'STRIP',
          quantity: 2,
          canonicalUnitsPerSaleUnit: 10,
          idempotencyKey: randomUUID(),
        });
        await changeSaleStatus(db, receiptScope, sale.id, 'complete');
        // Reader fixture: receipt numbering/customer/time assigned directly, no payment/receipt issuance proof.
        await db.pharmacySale.update({
          where: { id: sale.id },
          data: {
            customerId: f.customerId,
            receiptNumber: 100,
            completedAt: new Date('2026-10-06T13:00:00Z'),
            ...override,
          },
        });
        await postSaleLineEntry(db, receiptScope, {
          saleLineId: line.id,
          at: new Date('2026-10-06T13:00:00Z'),
        });
        return { sale, line };
      });
    const sold = await receipt();
    const from = new Date('2026-10-06'),
      before = new Date('2026-10-07'),
      partial = new Date('2026-10-08'),
      full = new Date('2026-10-09');
    const read = (cutoff: Date) =>
      tx((db) => eligibleMarketingReceipts(db, org, [branch], from, cutoff));
    expect((await read(before)).find((r) => r.receiptId === sold.sale.id)).toMatchObject({
      salesMinor: 2000,
      marginMinor: 1450,
    });
    expect(await tx((db) => generateMarketingAttribution(db, scope, from, before))).toMatchObject({
      created: 1,
    });
    expect(await tx((db) => generateMarketingAttribution(db, scope, from, before))).toMatchObject({
      created: 0,
    });
    for (const [units, date] of [
      [5, '2026-10-07T12:00:00Z'],
      [15, '2026-10-08T12:00:00Z'],
    ] as const) {
      await tx(async (db) => {
        // Reader-only return fixture: production returnSaleLine currently fails on
        // Prisma's void advisory-lock result. No stock-restoration/E2E claim.
        const returned = await db.pharmacySaleReturn.create({
          data: {
            organizationId: org,
            branchId: branch,
            originalSaleId: sold.sale.id,
            actorId: scope.actorId,
            reason: 'SYNTHETIC_READER_FIXTURE',
            createdAt: new Date(date),
          },
        });
        const allocations = await db.pharmacySaleLineAllocation.findMany({
          where: { saleLineId: sold.line.id },
          orderBy: { id: 'asc' },
        });
        let remaining: number = units;
        for (const allocation of allocations) {
          const prior = await db.pharmacySaleReturnLine.aggregate({
            where: { saleLineId: sold.line.id, inventoryLotId: allocation.inventoryLotId },
            _sum: { canonicalUnits: true },
          });
          const quantity = Math.min(
            remaining,
            allocation.canonicalUnits - (prior._sum.canonicalUnits ?? 0)
          );
          if (!quantity) continue;
          const line = await db.pharmacySaleReturnLine.create({
            data: {
              organizationId: org,
              branchId: branch,
              returnId: returned.id,
              saleLineId: sold.line.id,
              inventoryLotId: allocation.inventoryLotId,
              stockLocationId: allocation.stockLocationId,
              canonicalUnits: quantity,
              integrityDecision: 'SYNTHETIC_READER_ONLY',
              stockMovementId: `reader-only-${randomUUID()}`,
              createdAt: new Date(date),
            },
          });
          await postSaleReturnEntry(db, scope, { saleReturnLineId: line.id, at: new Date(date) });
          remaining -= quantity;
        }
        expect(remaining).toBe(0);
      });
    }
    const afterPartial = (await read(partial)).find((r) => r.receiptId === sold.sale.id)!;
    expect(afterPartial.salesMinor).toBe(1500);
    // Which lot returns first follows allocation id; compare exact stored journal, not an averaged cost.
    const totals = await tx((db) =>
      db.$queryRawUnsafe<Array<{ margin: number }>>(
        `SELECT SUM(CASE WHEN j.side='CREDIT' THEN j."amountMinor" ELSE -j."amountMinor" END)::int margin FROM finance_journal_lines j JOIN finance_journal_entries e ON e.id=j."entryId" AND e."organizationId"=j."organizationId" WHERE j."organizationId"=$1 AND j."sourceLineId"=$2 AND j."accountCode" IN ('SALES_REVENUE','SALES_DISCOUNT','COST_OF_GOODS_SOLD') AND e."occurredAt"<$3`,
        org,
        sold.line.id,
        partial
      )
    );
    expect(afterPartial.marginMinor).toBe(totals[0].margin);
    expect((await read(full)).find((r) => r.receiptId === sold.sale.id)).toMatchObject({
      salesMinor: 0,
      marginMinor: 0,
    });
    expect((await read(before)).find((r) => r.receiptId === sold.sale.id)).toMatchObject({
      salesMinor: 2000,
      marginMinor: 1450,
    });
    const report = await tx((db) =>
      readPharmacyMarketingReport(db, org, {
        branchIds: [branch],
        from: '2026-10-06',
        to: '2026-10-08',
      })
    );
    expect(report.attribution).toMatchObject({
      attributedReceipts: 1,
      recoveredSalesMinor: 0,
      recoveredMarginMinor: 0,
    });
    const sandboxOnly = await fixture();
    await dispatchSandboxCampaign(transaction, sandboxOnly.input, now);
    const sandboxReceipt = await receipt({ customerId: sandboxOnly.customerId });
    expect((await read(full)).some((r) => r.receiptId === sandboxReceipt.sale.id)).toBe(false);
    const cohort = await tx((db) =>
      db.pharmacyCampaignCapture.count({
        where: { organizationId: org, branchId: branch, capturedAt: { gte: from, lt: full } },
      })
    );
    const refreshed = await tx((db) =>
      readPharmacyMarketingReport(db, org, {
        branchIds: [branch],
        from: '2026-10-06',
        to: '2026-10-08',
      })
    );
    expect(refreshed.prepared).toBe(cohort);
    expect(refreshed.sandbox.delivered).toBeGreaterThan(0);
    expect(refreshed.attribution.attributedReceipts).toBe(1);
    // Same stored receipt cannot qualify when scope/identity/window/number/state changes.
    expect(await tx((db) => eligibleMarketingReceipts(db, otherOrg, [branch], from, full))).toEqual(
      []
    );
    expect(await tx((db) => eligibleMarketingReceipts(db, org, [sibling], from, full))).toEqual([]);
    for (const data of [
      { receiptNumber: null },
      { status: 'OPEN' as const },
      { customerId: null },
      { customerId: (await fixture()).customerId },
      { branchId: sibling },
      { completedAt: new Date('2026-10-06T11:00:00Z') },
      { completedAt: new Date('2026-10-14') },
    ]) {
      const excluded = await receipt(data);
      expect(
        (await read(new Date('2026-10-16'))).some((r) => r.receiptId === excluded.sale.id)
      ).toBe(false);
    }
  });
});
