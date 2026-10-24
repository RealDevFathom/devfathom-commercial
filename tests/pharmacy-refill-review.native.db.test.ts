// @vitest-environment node
/** Native committed-schema G9 probes. No Prisma/service mocks or schema rewrite.
 * The only provider allowed is the repository's MockWhatsAppProvider; PREPARED
 * is not SENT. All fixtures are synthetic and each scenario has its own tenant.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { WhatsAppConfig } from '@/lib/pharmacy/whatsapp/provider';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeDb = url ? describe : describe.skip;
const NOW = new Date('2026-10-24T10:00:00Z');
const DAY = 86_400_000;
let tenancy: typeof import('@/lib/tenancy/scoped-db');
let reviews: typeof import('@/lib/pharmacy/refill-reminder-review');
let consent: typeof import('@/lib/pharmacy/consent-writer');
let scheduler: typeof import('@/lib/pharmacy/whatsapp/refill-reminders');
let providers: typeof import('@/lib/pharmacy/whatsapp/provider');
let inbound: typeof import('@/lib/pharmacy/whatsapp/inbound');
let moduleId: string;

beforeAll(async () => {
  if (!url) return;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Native G9 probes require a loopback synthetic database');
  [tenancy, reviews, consent, scheduler, providers, inbound] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/pharmacy/refill-reminder-review'),
    import('@/lib/pharmacy/consent-writer'),
    import('@/lib/pharmacy/whatsapp/refill-reminders'),
    import('@/lib/pharmacy/whatsapp/provider'),
    import('@/lib/pharmacy/whatsapp/inbound'),
  ]);
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(tenancy.withPlatformDb);
  moduleId = await tenancy.withPlatformDb(async (db) => {
    await db.platformModule.createMany({
      data: [
        {
          id: `g9-module-${randomUUID()}`,
          key: 'pharmacy-crm',
          name: 'Synthetic Pharmacy CRM',
          category: 'pharmacy',
          band: 'VERTICAL_OPTIONAL',
          vertical: 'PHARMACY',
        },
      ],
      skipDuplicates: true,
    });
    return (await db.platformModule.findUniqueOrThrow({ where: { key: 'pharmacy-crm' } })).id;
  });
}, 120_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const suffix = randomUUID();
  const organizationId = `g9-org-${suffix}`;
  const scope = { organizationId, branchId: `g9-branch-${suffix}`, actorId: `g9-user-${suffix}` };
  await tenancy.withPlatformDb((db) =>
    db.organization.createMany({
      data: [
        {
          id: organizationId,
          slug: `g9-${suffix}`,
          legalName: 'Synthetic G9',
          displayName: 'Synthetic G9',
          vertical: 'PHARMACY',
          status: 'ACTIVE',
          timezone: 'Asia/Karachi',
        },
      ],
    })
  );
  return tenancy.withTenantDb(organizationId, async (db) => {
    await db.organizationDepartment.create({
      data: { organizationId, key: 'Pharmacy', name: 'Synthetic pharmacy' },
    });
    await db.user.createMany({
      data: [
        {
          id: scope.actorId,
          organizationId,
          name: 'Synthetic pharmacist',
          email: `g9-${suffix}@example.invalid`,
          department: 'Pharmacy',
          title: 'Pharmacist',
        },
      ],
    });
    await db.organizationModule.create({
      data: {
        organizationId,
        moduleId,
        startsAt: new Date(NOW.getTime() - DAY),
        status: 'ENABLED',
      },
    });
    for (const [id, code] of [
      [scope.branchId, 'A'],
      [`other-${scope.branchId}`, 'B'],
    ])
      await db.pharmacyBranch.create({
        data: {
          id,
          organizationId,
          code,
          name: `Synthetic ${code}`,
          addressLine: 'Synthetic road',
          city: 'Karachi',
          provinceCode: 'SD',
        },
      });
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: 'Synthetic patient', phone: '+923000000000' },
    });
    const customerId = `g9-customer-${suffix}`;
    // createMany deliberately seeds only existing consent fields; it does not
    // fabricate inherited G1 columns in a disposable database/schema/client.
    await db.pharmacyCustomer.createMany({
      data: [
        {
          id: customerId,
          organizationId,
          patientId: patient.id,
          displayName: 'Synthetic customer',
          whatsappOptIn: true,
        },
      ],
    });
    const prescriber = await db.pharmacyPrescriber.create({
      data: {
        organizationId,
        name: 'Synthetic prescriber',
        registrationNumber: `SYNTHETIC-${suffix}`,
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: 'Synthetic utility item',
        productFamily: 'PHARMACEUTICAL',
        rx: false,
        otc: true,
        presentations: { create: { organizationId, presentation: 'Tablet', dosageForm: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const prescription = await db.prescription.create({
      data: {
        organizationId,
        patientId: patient.id,
        prescriberId: prescriber.id,
        sourceKind: 'PAPER_IMAGE',
        sourceFileRef: 'synthetic-only',
        validFrom: new Date(NOW.getTime() - 10 * DAY),
        validUntil: new Date(NOW.getTime() + 20 * DAY),
        capturedByUserId: scope.actorId,
      },
    });
    const line = await db.prescriptionLine.create({
      data: {
        organizationId,
        prescriptionId: prescription.id,
        lineNumber: 1,
        medicineId: medicine.id,
        presentationId: medicine.presentations[0]!.id,
        authorizedCanonicalUnits: 10,
        directions: 'One tablet daily',
      },
    });
    const fill = await db.prescriptionFill.create({
      data: {
        organizationId,
        prescriptionLineId: line.id,
        fillSequence: 1,
        quantityCanonicalUnits: 10,
        dispensedByUserId: scope.actorId,
        dispensedAt: new Date(NOW.getTime() - 7 * DAY),
        idempotencyKey: `fill-${suffix}`,
      },
    });
    await consent.writePatientConsent(
      db,
      organizationId,
      scope.actorId,
      { patientId: patient.id, purpose: 'REMINDERS', channel: 'WHATSAPP', granted: true },
      new Date(NOW.getTime() - DAY)
    );
    return { scope, patientId: patient.id, customerId, fillId: fill.id, key: `capture-${suffix}` };
  });
}

function enroll(f: Fixture) {
  return tenancy.withTenantDb(f.scope.organizationId, (db) =>
    reviews.captureRefillReminderForReview(db, f.scope, {
      fillId: f.fillId,
      directionsUrdu: 'روزانہ ایک گولی',
      idempotencyKey: f.key,
    })
  );
}
function decide(f: Fixture, captureId: string, decision: 'APPROVED' | 'SKIPPED') {
  return tenancy.withTenantDb(f.scope.organizationId, (db) =>
    reviews.reviewRefillReminder(db, f.scope, { captureId, decision }, NOW)
  );
}
function config(f: Fixture): WhatsAppConfig {
  return providers.readWhatsAppConfig({
    PHARMACY_WHATSAPP_PROVIDER: 'mock',
    PHARMACY_WHATSAPP_ORGANIZATION_ID: f.scope.organizationId,
    PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'synthetic-sender',
    PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER: 'synthetic_utility_refill',
  });
}
async function logs(f: Fixture) {
  return tenancy.withTenantDb(f.scope.organizationId, (db) =>
    db.pharmacyMessageLog.findMany({
      where: { organizationId: f.scope.organizationId },
      select: { kind: true, status: true, error: true, dedupeKey: true, refillCaptureId: true },
    })
  );
}
async function metric(db: ScopedDb, f: Fixture) {
  return db.customerMetrics.create({
    data: { organizationId: f.scope.organizationId, customerId: f.customerId, computedAt: NOW },
  });
}

describeDb('native CustomerMetrics relation and forced tenant isolation', () => {
  it('uses a non-superuser/non-BYPASSRLS application role and FORCE RLS table', async () => {
    const f = await fixture();
    const rows = await tenancy.withTenantDb(f.scope.organizationId, (db) =>
      db.$queryRawUnsafe<
        Array<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>
      >(`SELECT rolsuper,rolbypassrls,relrowsecurity,relforcerowsecurity FROM pg_roles,pg_class
       WHERE rolname=current_user AND relname='customer_metrics'`)
    );
    expect(rows).toEqual([
      { rolsuper: false, rolbypassrls: false, relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });
  it('persists native metrics and follows the composite customer relation', async () => {
    const f = await fixture();
    await tenancy.withTenantDb(f.scope.organizationId, (db) => metric(db, f));
    const found = await tenancy.withTenantDb(f.scope.organizationId, (db) =>
      db.customerMetrics.findUnique({
        where: {
          organizationId_customerId: {
            organizationId: f.scope.organizationId,
            customerId: f.customerId,
          },
        },
        select: { customerId: true, customer: { select: { id: true, organizationId: true } } },
      })
    );
    expect(found).toEqual({
      customerId: f.customerId,
      customer: { id: f.customerId, organizationId: f.scope.organizationId },
    });
  });
  it('rejects a duplicate native metric and hides metrics from another tenant', async () => {
    const f = await fixture();
    await tenancy.withTenantDb(f.scope.organizationId, (db) => metric(db, f));
    await expect(
      tenancy.withTenantDb(f.scope.organizationId, (db) => metric(db, f))
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(
      await tenancy.withTenantDb(`foreign-${randomUUID()}`, (db) =>
        db.customerMetrics.findMany({
          where: { customerId: f.customerId },
        })
      )
    ).toEqual([]);
  });
  it('refuses a foreign-tenant customer binding even with a matching local tenant GUC', async () => {
    const f = await fixture();
    await expect(
      tenancy.withTenantDb(`foreign-${randomUUID()}`, (db) =>
        db.customerMetrics.create({
          data: { customerId: f.customerId, computedAt: NOW },
        })
      )
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});

describeDb('native G9 capture → review → existing mock outbox path', () => {
  it('atomically captures a DRAFT and retries without rewriting clinical evidence or sending', async () => {
    const f = await fixture();
    const first = await enroll(f);
    expect(await enroll(f)).toEqual(first);
    const queue = await tenancy.withTenantDb(f.scope.organizationId, (db) =>
      reviews.listRefillReminderReviews(db, f.scope)
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ captureId: first.id, status: 'DRAFT', dispatchStatus: null });
    const c = config(f),
      provider = new providers.MockWhatsAppProvider(c);
    expect(
      (await scheduler.processDueWhatsAppRefillReminders({ now: NOW, config: c, provider }))
        .prepared
    ).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(await logs(f)).toEqual([]);
  });
  it('approves once, prepares through the existing mock helper, logs not-SENT, and never duplicates', async () => {
    const f = await fixture(),
      capture = await enroll(f);
    await decide(f, capture.id, 'APPROVED');
    expect(await decide(f, capture.id, 'APPROVED')).toMatchObject({
      status: 'APPROVED',
      decidedByUserId: f.scope.actorId,
    });
    const c = config(f),
      provider = new providers.MockWhatsAppProvider(c);
    const result = await scheduler.processDueWhatsAppRefillReminders({
      now: NOW,
      config: c,
      provider,
    });
    expect(result).toMatchObject({ prepared: 1, sent: 0, unknown: 0, failed: 0 });
    expect(provider.calls).toHaveLength(1);
    expect(await logs(f)).toEqual([
      expect.objectContaining({
        kind: 'REFILL_REMINDER',
        status: 'IGNORED',
        error: 'MOCK_PREPARED',
        refillCaptureId: capture.id,
      }),
    ]);
    expect(
      (await scheduler.processDueWhatsAppRefillReminders({ now: NOW, config: c, provider }))
        .prepared
    ).toBe(0);
    expect(provider.calls).toHaveLength(1);
  });
  it('keeps SKIPPED terminal and outside the scheduler', async () => {
    const f = await fixture(),
      capture = await enroll(f);
    await decide(f, capture.id, 'SKIPPED');
    await expect(decide(f, capture.id, 'APPROVED')).rejects.toMatchObject({
      reason: 'REFILL_REVIEW_ALREADY_DECIDED',
    });
    const c = config(f),
      provider = new providers.MockWhatsAppProvider(c);
    await scheduler.processDueWhatsAppRefillReminders({ now: NOW, config: c, provider });
    expect(provider.calls).toHaveLength(0);
    expect(await logs(f)).toEqual([]);
  });
  it('rechecks latest patient consent before approval and preserves the prior audit version', async () => {
    const f = await fixture(),
      capture = await enroll(f);
    await tenancy.withTenantDb(f.scope.organizationId, (db) =>
      consent.writePatientConsent(
        db,
        f.scope.organizationId,
        f.scope.actorId,
        { patientId: f.patientId, purpose: 'REMINDERS', channel: 'WHATSAPP', granted: false },
        NOW
      )
    );
    await expect(decide(f, capture.id, 'APPROVED')).rejects.toMatchObject({
      reason: 'REFILL_REVIEW_CONSENT_REQUIRED',
    });
    const history = await tenancy.withTenantDb(f.scope.organizationId, (db) =>
      db.patientConsent.findMany({
        where: { patientId: f.patientId },
        orderBy: { version: 'asc' },
        select: { version: true, granted: true },
      })
    );
    expect(history).toEqual([
      { version: 1, granted: true },
      { version: 2, granted: false },
    ]);
  });
  it('refuses another branch and tenant while leaving the enrolled capture unchanged', async () => {
    const f = await fixture(),
      capture = await enroll(f);
    await expect(
      tenancy.withTenantDb(f.scope.organizationId, (db) =>
        reviews.reviewRefillReminder(
          db,
          { ...f.scope, branchId: `other-${f.scope.branchId}` },
          { captureId: capture.id, decision: 'APPROVED' },
          NOW
        )
      )
    ).rejects.toMatchObject({ reason: 'REFILL_REVIEW_NOT_FOUND' });
    const other = await fixture();
    await expect(decide(other, capture.id, 'APPROVED')).rejects.toMatchObject({
      reason: 'REFILL_REVIEW_NOT_FOUND',
    });
    expect(await enroll(f)).toEqual(capture);
  });
  it('honors actual STOP after approval: customer opt-out blocks refill preparation', async () => {
    const f = await fixture(),
      capture = await enroll(f);
    await decide(f, capture.id, 'APPROVED');
    const c = config(f),
      provider = new providers.MockWhatsAppProvider(c);
    const receivedAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    expect(
      await inbound.handleInboundWhatsAppMessage(
        f.scope.organizationId,
        provider,
        {
          providerMessageId: `synthetic-stop-${randomUUID()}`,
          from: '923000000000',
          text: 'STOP',
          receivedAt,
          phoneNumberId: c.phoneNumberId,
        },
        NOW
      )
    ).toBe('OPTED_OUT');
    const result = await scheduler.processDueWhatsAppRefillReminders({
      now: NOW,
      config: c,
      provider,
    });
    expect(result.prepared).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(await logs(f)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'REFILL_REMINDER' })])
    );
  });
});

describeDb('G9 scheduler reuses the accepted shared original/retry authority', () => {
  it('commits UNKNOWN before mock entry, blocks overlapping retry and preserves terminal mock evidence', async () => {
    const f = await fixture();
    const capture = await enroll(f);
    await decide(f, capture.id, 'APPROVED');
    const c = config(f);
    const provider = new providers.MockWhatsAppProvider(c);
    const messageLog = await import('@/lib/pharmacy/whatsapp/message-log');
    const { deferred } = await import('./support/whatsapp-message-log-store');
    const entered = deferred();
    const release = deferred();
    const prepare = provider.sendTemplate.bind(provider);
    let providerEntries = 0;
    provider.sendTemplate = async (input) => {
      providerEntries += 1;
      entered.resolve();
      await release.promise;
      return prepare(input);
    };
    const read = () =>
      tenancy.withTenantDb(f.scope.organizationId, (db) =>
        db.pharmacyMessageLog.findFirstOrThrow({
          where: { organizationId: f.scope.organizationId, refillCaptureId: capture.id },
          select: {
            id: true,
            organizationId: true,
            dedupeKey: true,
            direction: true,
            status: true,
            error: true,
            providerMessageId: true,
          },
        })
      );
    const original = scheduler.processDueWhatsAppRefillReminders({ now: NOW, config: c, provider });
    let pending!: Awaited<ReturnType<typeof read>>;
    let retryEntry!: import('@/lib/pharmacy/whatsapp/message-log').MessageLogEntry;
    try {
      await entered.promise;
      pending = await read();
      expect(pending).toMatchObject({
        organizationId: f.scope.organizationId,
        direction: 'OUTBOUND',
        status: 'PENDING',
        error: 'UNKNOWN_PROVIDER_OUTCOME',
        providerMessageId: null,
      });
      retryEntry = {
        organizationId: f.scope.organizationId,
        kind: 'REFILL_REMINDER',
        dedupeKey: pending.dedupeKey,
        branchId: f.scope.branchId,
        refillCaptureId: capture.id,
      };
      const losingRetry = await messageLog.sendClaimedMessage(retryEntry, pending.id, () =>
        provider.sendTemplate({ to: '923001234567', template: 'refillReminder', parameters: [] })
      );
      expect(losingRetry).toBe('DUPLICATE');
      expect(providerEntries).toBe(1);
      expect(provider.calls).toHaveLength(0);
      expect(await read()).toEqual(pending);
    } finally {
      release.resolve();
      await original;
    }
    expect(await original).toMatchObject({ prepared: 1, sent: 0, unknown: 0, failed: 0 });
    const prepared = await read();
    expect(prepared).toMatchObject({ status: 'IGNORED', error: 'MOCK_PREPARED' });
    expect(prepared.providerMessageId).toBeTruthy();
    const sendAgain = () =>
      provider.sendTemplate({ to: '923001234567', template: 'refillReminder', parameters: [] });
    expect(await messageLog.sendClaimedMessage(retryEntry!, pending!.id, sendAgain)).toBe(
      'DUPLICATE'
    );
    expect(await messageLog.sendAndLog(retryEntry!, sendAgain)).toBe('DUPLICATE');
    expect(
      (await scheduler.processDueWhatsAppRefillReminders({ now: NOW, config: c, provider }))
        .prepared
    ).toBe(0);
    expect(providerEntries).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(await read()).toEqual(prepared);
  });
});
