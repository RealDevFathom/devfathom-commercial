// @vitest-environment node
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { GrowthInput, GrowthResult } from '@/lib/ai/growth-recommendations';
import {
  buildPharmacyGrowthInput,
  listGrowthInsights,
  reviewGrowthInsight,
  saveGrowthInsight,
} from './growth-insights';
import {
  approveMarketingCampaign,
  captureMarketingCampaign,
  approveMarketingTemplate,
  type MarketingScope,
} from './marketing-service';
import { readGrowthSandboxDiagnostic } from './growth-evidence';
import { receiveLot } from './stock-ledger';
import { createSale, addSaleLine, changeSaleStatus } from './sales';
import { postSaleLineEntry } from './finance-postings';
import { writePatientConsent } from './consent-writer';
import { dispatchSandboxCampaign } from './marketing-delivery';
import { generateMarketingAttribution } from './marketing-attribution';
import { readPharmacyMarketingReport } from './marketing-report';
const enabled =
  process.env.PHARMACY_MARKETING_DB_ADMITTED === 'true' &&
  !!process.env.PHARMACY_MARKETING_TEST_RUNTIME_DATABASE_URL &&
  !!process.env.PHARMACY_MARKETING_TEST_OWNER_DATABASE_URL;
const suite = enabled ? describe : describe.skip;
const org = `growth_${randomUUID()}`,
  branch = `branch_${randomUUID()}`,
  sibling = `branch_${randomUUID()}`;
const scope: MarketingScope = {
  organizationId: org,
  branchId: branch,
  actorId: 'synthetic-growth-owner',
  timezone: 'UTC',
};
let owner: Client;
let prisma: PrismaClient;
const now = new Date();
const input: GrowthInput = {
  vertical: 'PHARMACY',
  currency: 'PKR',
  current: { from: '2026-09-01T00:00:00Z', cutoff: '2026-10-01T00:00:00Z' },
  comparison: { from: '2026-08-01T00:00:00Z', cutoff: '2026-09-01T00:00:00Z' },
  facts: [
    {
      ref: 'e1',
      metric: 'receipt_count',
      value: '20',
      period: 'CURRENT',
      cohortSize: 10,
      coverage: 'COMPLETE',
      freshAt: now.toISOString(),
    },
  ],
  actions: [{ ref: 'a1', kind: 'RETAIL_REVIEW' }],
};
// Deliberate provider double: proves persistence/review contracts, never actual-model acceptance.
const result: GrowthResult = {
  schemaVersion: 1,
  status: 'READY',
  failureCode: null,
  provider: 'TEST_DOUBLE',
  model: 'synthetic-contract-only',
  inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  input,
  output: {
    recommendations: [
      {
        evidenceRefs: ['e1'],
        actionRef: 'a1',
        hypothesis: 'REVIEW_RETAIL',
        limitations: ['OBSERVATIONAL'],
      },
    ],
  },
};
function tx<T>(
  run: (db: ScopedDb) => Promise<T>,
  organizationId = org,
  branchId = branch,
  platform = false
) {
  return prisma.$transaction(async (db) => {
    await db.$queryRawUnsafe(
      "SELECT set_config('app.current_organization_id',$1,true),set_config('app.current_branch_id',$2,true),set_config('app.is_platform_admin',$3,true)",
      organizationId,
      branchId,
      String(platform)
    );
    return run(db as ScopedDb);
  });
}
let templateId: string;
beforeAll(async () => {
  if (!enabled) return;
  for (const text of [
    process.env.PHARMACY_MARKETING_TEST_RUNTIME_DATABASE_URL!,
    process.env.PHARMACY_MARKETING_TEST_OWNER_DATABASE_URL!,
  ]) {
    const url = new URL(text);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('55625');
  }
  owner = new Client({ connectionString: process.env.PHARMACY_MARKETING_TEST_OWNER_DATABASE_URL });
  await owner.connect();
  prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.PHARMACY_MARKETING_TEST_RUNTIME_DATABASE_URL!,
    }),
  });
  await owner.query("SELECT set_config('app.is_platform_admin','true',false)");
  await owner.query(
    `INSERT INTO organizations(id,slug,"legalName","displayName",vertical,status,"deploymentMode","createdAt","updatedAt") VALUES($1,$1,'Synthetic growth','Synthetic growth','PHARMACY','ACTIVE','SHARED',now(),now())`,
    [org]
  );
  await owner.query(
    `INSERT INTO pharmacy_branches(id,"organizationId",code,name,"addressLine",city,"provinceCode",active,"createdAt","updatedAt") VALUES($1,$3,'A','Synthetic A','Test','Lahore','PB',true,now(),now()),($2,$3,'B','Synthetic B','Test','Lahore','PB',true,now(),now())`,
    [branch, sibling, org]
  );
  templateId = (
    await tx((db) =>
      approveMarketingTemplate(db, scope, {
        branchId: branch,
        name: randomUUID(),
        body: 'Store news. Reply STOP.',
        reviewed: true,
      })
    )
  ).id;
});
afterAll(async () => {
  if (enabled) {
    await prisma?.$disconnect();
    await owner?.end();
  }
});
const edit = () => ({
  name: 'Reviewed store update',
  templateId,
  scheduledAt: new Date(Date.now() + 86400000),
});
suite('growth restricted DB contracts', () => {
  it('persists configuration failures and empty aggregate status without a fabricated recommendation', async () => {
    const saved = await tx((db) =>
      saveGrowthInsight(db, scope, {
        ...result,
        status: 'UNAVAILABLE',
        failureCode: 'CONFIGURATION',
        provider: null,
        model: null,
        output: null,
      })
    );
    const history = await tx((db) => listGrowthInsights(db, scope));
    expect(history.insights.find((x) => x.id === saved.id)).toMatchObject({
      status: 'UNAVAILABLE',
      failureCode: 'CONFIGURATION',
      output: null,
    });
    expect(
      (
        await tx((db) =>
          buildPharmacyGrowthInput(db, scope, new Date('2026-09-01'), new Date('2026-10-01'), now)
        )
      ).facts
    ).toEqual([]);
    await expect(
      tx((db) =>
        reviewGrowthInsight(db, scope, {
          branchId: branch,
          insightId: saved.id,
          recommendation: 0,
          decision: 'APPROVE',
          edit: edit(),
        })
      )
    ).rejects.toThrow('Ready insight');
  });
  it('forces RLS and denies sibling/tenant reads and writes even with platform admin true', async () => {
    const saved = await tx((db) => saveGrowthInsight(db, scope, result));
    const posture = await tx((db) =>
      db.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('growth_insights','pharmacy_growth_reviews')"
      )
    );
    expect(posture).toHaveLength(2);
    expect(posture.every((x) => x.relrowsecurity && x.relforcerowsecurity)).toBe(true);
    expect(
      await tx((db) =>
        db.$queryRawUnsafe(
          'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=current_user'
        )
      )
    ).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
      },
    ]);
    for (const platform of [false, true]) {
      for (const [tenant, selectedBranch] of [
        [org, sibling],
        ['other-tenant', branch],
      ]) {
        expect(
          (await tx((db) => listGrowthInsights(db, scope), tenant, selectedBranch, platform))
            .insights
        ).toHaveLength(0);
        await expect(
          tx((db) => saveGrowthInsight(db, scope, result), tenant, selectedBranch, platform)
        ).rejects.toThrow();
        await expect(
          tx(
            (db) =>
              reviewGrowthInsight(db, scope, {
                branchId: branch,
                insightId: saved.id,
                recommendation: 0,
                decision: 'APPROVE',
                edit: edit(),
              }),
            tenant,
            selectedBranch,
            platform
          )
        ).rejects.toThrow();
      }
    }
  });
  it('retains immutable source, explicit edits and exactly one draft for concurrent approval', async () => {
    const saved = await tx((db) => saveGrowthInsight(db, scope, result));
    const decision = {
      branchId: branch,
      insightId: saved.id,
      recommendation: 0,
      decision: 'APPROVE' as const,
      edit: edit(),
    };
    await tx((db) =>
      reviewGrowthInsight(db, scope, {
        ...decision,
        decision: 'EDIT',
        edit: { ...edit(), name: 'Edited draft' },
      })
    );
    const [a, b] = await Promise.all([
      tx((db) => reviewGrowthInsight(db, scope, decision)),
      tx((db) => reviewGrowthInsight(db, scope, decision)),
    ]);
    expect(a.campaignId).toBe(b.campaignId);
    for (const changed of [
      { ...decision.edit, name: 'Changed name' },
      { ...decision.edit, templateId: 'changed-template' },
      { ...decision.edit, scheduledAt: new Date(decision.edit.scheduledAt.getTime() + 1000) },
    ])
      await expect(
        tx((db) => reviewGrowthInsight(db, scope, { ...decision, edit: changed }))
      ).rejects.toThrow('settings conflict');

    expect([a.replay, b.replay].sort()).toEqual([false, true]);
    const campaign = await tx((db) =>
      db.pharmacyCampaign.findFirst({ where: { organizationId: org, id: a.campaignId! } })
    );
    expect(campaign).toMatchObject({
      status: 'DRAFT',
      ownerApprovedAt: null,
      frequencyCap: { max: 1, windowDays: 7 },
    });
    const history = await tx((db) => listGrowthInsights(db, scope));
    expect(
      history.reviews
        .filter((x) => x.insightId === saved.id)
        .map((x) => x.decision)
        .sort()
    ).toEqual(['APPROVE', 'EDIT']);
    await expect(
      tx((db) =>
        db.$executeRawUnsafe('UPDATE growth_insights SET model=$1 WHERE id=$2', 'changed', saved.id)
      )
    ).rejects.toThrow();
    await expect(
      tx((db) =>
        db.$executeRawUnsafe('DELETE FROM pharmacy_growth_reviews WHERE "insightId"=$1', saved.id)
      )
    ).rejects.toThrow();
    await expect(
      tx((db) => reviewGrowthInsight(db, scope, { ...decision, decision: 'REJECT' }))
    ).rejects.toThrow('already resolved');
  });
  it('rejection is replay-safe and never becomes approval', async () => {
    const saved = await tx((db) => saveGrowthInsight(db, scope, result));
    const decision = {
      branchId: branch,
      insightId: saved.id,
      recommendation: 0,
      decision: 'REJECT' as const,
    };
    expect(await tx((db) => reviewGrowthInsight(db, scope, decision))).toMatchObject({
      campaignId: null,
      replay: false,
    });
    expect(await tx((db) => reviewGrowthInsight(db, scope, decision))).toMatchObject({
      campaignId: null,
      replay: true,
    });
    await expect(
      tx((db) => reviewGrowthInsight(db, scope, { ...decision, decision: 'APPROVE', edit: edit() }))
    ).rejects.toThrow('already resolved');
  });
  it('rechecks current template eligibility and rejects out-of-scope edited settings atomically', async () => {
    const saved = await tx((db) => saveGrowthInsight(db, scope, result));
    await expect(
      tx((db) =>
        reviewGrowthInsight(db, scope, {
          branchId: sibling,
          insightId: saved.id,
          recommendation: 0,
          decision: 'APPROVE',
          edit: edit(),
        })
      )
    ).rejects.toThrow('Branch mismatch');
    await expect(
      tx((db) =>
        reviewGrowthInsight(db, scope, {
          branchId: branch,
          insightId: saved.id,
          recommendation: 0,
          decision: 'APPROVE',
          edit: { ...edit(), templateId: 'foreign-template' },
        })
      )
    ).rejects.toThrow('reviewed template');
    expect(
      (await tx((db) => listGrowthInsights(db, scope))).reviews.filter(
        (x) => x.insightId === saved.id
      )
    ).toHaveLength(0);
  });
});

suite('growth aggregate and TEST sandbox feedback', () => {
  it('requires every posted line, suppresses small cohorts, honors STOP and reconciles lineage to exact Finance', async () => {
    const at = new Date('2026-10-08T12:00:00Z');
    const cutoff = new Date('2026-10-10T00:00:00Z');
    const earlier = new Date('2026-10-06T12:00:00Z');
    const asset = await tx(async (db) => {
      const medicine = await db.medicine.create({
        data: {
          organizationId: org,
          productName: 'Synthetic fixture',
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          presentations: { create: { organizationId: org, presentation: 'Synthetic unit' } },
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
          unitsPerParent: 1,
          effectiveFrom: new Date('2026-01-01'),
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: {
          organizationId: org,
          branchId: branch,
          code: randomUUID(),
          name: 'Synthetic store',
          kind: 'STORE',
        },
      });
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: org,
          medicineId: medicine.id,
          batchNumber: randomUUID(),
          expiresAt: new Date('2028-01-01'),
          expiryPrecision: 'DAY',
        },
      });
      await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: 1,
        supplierName: 'Synthetic supplier',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 27,
        printedMrpMinor: 100,
        receivedExpiresAt: new Date('2028-01-01'),
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 100,
        idempotencyKey: randomUUID(),
        receivedAt: earlier,
      });
      return {
        medicineId: medicine.id,
        presentationId: medicine.presentations[0].id,
        packLevelId: pack.id,
      };
    });
    const customers: Array<{ id: string; patientId: string }> = [];
    const unposted: string[] = [];
    async function receipt(customerId: string, completedAt: Date, allPosted: boolean) {
      return tx(async (db) => {
        const sale = await createSale(db, scope);
        const lines = [];
        for (let i = 0; i < 2; i++)
          lines.push(
            (
              await addSaleLine(db, scope, {
                ...asset,
                saleId: sale.id,
                saleUnit: 'STRIP',
                quantity: 1,
                canonicalUnitsPerSaleUnit: 1,
                idempotencyKey: randomUUID(),
              })
            ).line
          );
        await changeSaleStatus(db, scope, sale.id, 'complete');
        // Synthetic reader fixture, not tender/receipt issuance acceptance.
        await db.pharmacySale.update({
          where: { id: sale.id },
          data: { customerId, receiptNumber: 100, completedAt },
        });
        await postSaleLineEntry(db, scope, { saleLineId: lines[0].id, at: completedAt });
        if (allPosted)
          await postSaleLineEntry(db, scope, { saleLineId: lines[1].id, at: completedAt });
        else unposted.push(lines[1].id);
        return sale.id;
      });
    }
    const read = () =>
      tx((db) => buildPharmacyGrowthInput(db, scope, new Date('2026-10-01'), cutoff, cutoff));
    for (let i = 0; i < 10; i++) {
      const customer = await tx(async (db) => {
        const patient = await db.pharmacyPatient.create({
          data: { organizationId: org, displayName: 'Synthetic' },
        });
        const c = await db.pharmacyCustomer.create({
          data: {
            organizationId: org,
            patientId: patient.id,
            displayName: 'Synthetic',
            active: true,
            whatsappOptIn: true,
          },
        });
        await writePatientConsent(
          db,
          org,
          scope.actorId,
          { patientId: patient.id, purpose: 'MARKETING', channel: 'WHATSAPP', granted: true },
          earlier
        );
        return { id: c.id, patientId: patient.id };
      });
      customers.push(customer);
      await receipt(customer.id, earlier, false);
      if (i === 8) expect((await read()).facts).toEqual([]);
    }
    const partial = await read();
    expect(partial.facts.find((f) => f.metric === 'receipt_count')?.value).toBe('10');
    expect(partial.facts.find((f) => f.metric === 'consent_eligible_retail_count')?.value).toBe(
      '10'
    );
    expect(partial.facts.some((f) => f.metric === 'settled_sales_minor')).toBe(false);
    for (const saleLineId of unposted)
      await tx((db) => postSaleLineEntry(db, scope, { saleLineId, at: earlier }));
    const complete = await read();
    expect(complete.facts.find((f) => f.metric === 'settled_sales_minor')).toMatchObject({
      value: '2000',
      coverage: 'COMPLETE',
    });
    expect(complete.facts.find((f) => f.metric === 'posted_margin_minor')?.value).toBe('1460');
    expect(JSON.stringify(complete)).not.toContain(customers[0].id);
    expect(JSON.stringify(complete)).not.toContain(asset.medicineId);
    const saved = await tx((db) =>
      saveGrowthInsight(db, scope, {
        ...result,
        input: complete,
        inputHash: createHash('sha256').update(JSON.stringify(complete)).digest('hex'),
      })
    );
    const reviewed = await tx((db) =>
      reviewGrowthInsight(
        db,
        scope,
        {
          branchId: branch,
          insightId: saved.id,
          recommendation: 0,
          decision: 'APPROVE',
          edit: { name: 'Synthetic diagnostic', templateId, scheduledAt: at },
        },
        at
      )
    );
    await tx((db) => approveMarketingCampaign(db, scope, reviewed.campaignId!, at));
    expect(
      await tx((db) => captureMarketingCampaign(db, scope, reviewed.campaignId!, at))
    ).toMatchObject({ prepared: 10 });
    // Withdrawal after capture must suppress sending and reduce eligible cohort below disclosure threshold.
    await tx(async (db) => {
      await writePatientConsent(
        db,
        org,
        scope.actorId,
        {
          patientId: customers[9].patientId,
          purpose: 'MARKETING',
          channel: 'WHATSAPP',
          granted: false,
        },
        at
      );
      await db.pharmacyCustomer.update({
        where: { id: customers[9].id },
        data: { whatsappOptIn: false },
      });
    });
    expect((await read()).facts.some((f) => f.metric === 'consent_eligible_retail_count')).toBe(
      false
    );
    const dispatch = {
      branchId: branch,
      campaignId: reviewed.campaignId!,
      requestKey: randomUUID(),
      outcome: 'DELIVERED' as const,
      retry: false,
    };
    const run = <T>(fn: (db: ScopedDb, s: MarketingScope) => Promise<T>) =>
      tx((db) => fn(db, scope));
    await dispatchSandboxCampaign(run, dispatch, at);
    const attempts = await tx((db) =>
      db.pharmacyCampaignDispatchAttempt.count({
        where: { organizationId: org, capture: { campaignId: reviewed.campaignId! } },
      })
    );
    await dispatchSandboxCampaign(run, dispatch, at);
    expect(
      await tx((db) =>
        db.pharmacyCampaignDispatchAttempt.count({
          where: { organizationId: org, capture: { campaignId: reviewed.campaignId! } },
        })
      )
    ).toBe(attempts);
    const receiptId = await receipt(customers[0].id, new Date(at.getTime() + 3600000), true);
    const diagnostic = await tx((db) => readGrowthSandboxDiagnostic(db, scope, saved.id, cutoff));
    expect(diagnostic).toMatchObject({
      environment: 'TEST_SANDBOX',
      method: 'SYNTHETIC_SANDBOX_RECEIPT_FINANCE_V1',
      messageCostMinor: null,
    });
    expect(diagnostic.rows).toEqual([
      {
        receiptId,
        campaignId: reviewed.campaignId,
        captureId: expect.any(String),
        salesMinor: '200',
        marginMinor: '146',
      },
    ]);
    expect(
      (
        await tx((db) =>
          readGrowthSandboxDiagnostic(db, { ...scope, branchId: sibling }, saved.id, cutoff)
        )
      ).rows
    ).toEqual([]);
    const report = await tx((db) =>
      readPharmacyMarketingReport(db, org, {
        branchIds: [branch],
        from: '2026-10-01',
        to: '2026-10-09',
      })
    );
    expect(report).toMatchObject({
      delivered: 0,
      providerAccepted: 0,
      sandbox: { delivered: 9, suppressed: 1 },
      attribution: { attributedReceipts: 0, recoveredSalesMinor: 0 },
    });
    expect((await read()).facts.some((f) => f.metric.startsWith('meta_'))).toBe(false);
    // Synthetic Meta namespace evidence for aggregate-reader proof only; no external provider call.
    await tx(async (db) => {
      const captures = await db.pharmacyCampaignCapture.findMany({
        where: { organizationId: org, campaignId: reviewed.campaignId! },
      });
      for (const capture of captures) {
        const attempt = await db.pharmacyCampaignDispatchAttempt.create({
          data: {
            organizationId: org,
            captureId: capture.id,
            requestKey: randomUUID(),
            attemptNumber: 2,
            provider: 'meta',
            senderId: 'synthetic-growth-meta',
            reservedAt: at,
          },
        });
        const acceptance = await db.pharmacyCampaignDeliveryEvent.create({
          data: {
            organizationId: org,
            attemptId: attempt.id,
            provider: 'meta',
            senderId: attempt.senderId,
            eventKey: randomUUID(),
            state: 'PROVIDER_ACCEPTED',
            providerMessageId: randomUUID(),
            occurredAt: at,
          },
        });
        await db.pharmacyCampaignDeliveryEvent.create({
          data: {
            organizationId: org,
            attemptId: attempt.id,
            provider: 'meta',
            senderId: attempt.senderId,
            eventKey: randomUUID(),
            state: 'DELIVERED',
            providerMessageId: acceptance.providerMessageId,
            acceptanceId: acceptance.id,
            occurredAt: at,
          },
        });
      }
    });
    await tx((db) => generateMarketingAttribution(db, scope, new Date('2026-10-01'), cutoff));
    let measured = await read();
    expect(measured.facts.find((f) => f.metric === 'meta_delivered_count')?.value).toBe('10');
    // Ten deliveries and one converted customer must not disclose a one-customer money fact.
    expect(measured.facts.some((f) => f.metric === 'meta_attributed_sales_minor')).toBe(false);
    for (const customer of customers.slice(1))
      await receipt(customer.id, new Date(at.getTime() + 3600000), true);
    await tx((db) => generateMarketingAttribution(db, scope, new Date('2026-10-01'), cutoff));
    measured = await read();
    expect(measured.facts.find((f) => f.metric === 'meta_attributed_sales_minor')).toMatchObject({
      value: '2000',
      cohortSize: 10,
      coverage: 'PARTIAL',
    });
    // Separate diagnostic still reflects only its nine sandbox-delivered customers, never Meta-only evidence.
    expect(
      (await tx((db) => readGrowthSandboxDiagnostic(db, scope, saved.id, cutoff))).rows
    ).toHaveLength(9);
  }, 30000);
});
