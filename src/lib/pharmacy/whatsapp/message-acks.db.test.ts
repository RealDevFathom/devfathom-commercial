// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Loyalty 5 hold fix: provider acknowledgements drive the outbound message log
 * and, for a refill reminder, its capture. Run against PostgreSQL as the
 * restricted runtime role (FORCE RLS) through the real tenant transaction.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const id = (label: string) => `ack_${label}_${suffix}`;
const ORG_A = id('org_a');
const ORG_B = id('org_b');
const A1 = id('branch_a1');
const A2 = id('branch_a2');
const NOW = new Date('2026-10-20T12:00:00.000Z');
const T1 = new Date('2026-10-20T09:00:00.000Z');
const T2 = new Date('2026-10-20T09:05:00.000Z');

type Deps = {
  scoped: typeof import('@/lib/tenancy/scoped-db');
  acks: typeof import('./message-acks');
  log: typeof import('./message-log');
  refill: typeof import('@/lib/pharmacy/refill-reminder-sender');
};
let deps: Deps;

function platform(sql: string, ...values: unknown[]) {
  return deps.scoped.withPlatformDb((db) => db.$executeRawUnsafe(sql, ...values));
}

let fills = 0;
type Reminder = { captureId: string; logId: string; providerMessageId: string };

/**
 * A QUEUED refill capture in ORG_A / `branchId` and its outbox claim
 * (`refill-capture:<id>`), as `queueDueRefillReminders` writes them; the log
 * is in `status` with `providerMessageId`.
 */
async function queuedReminder(
  label: string,
  input: { branchId?: string; status: 'PENDING' | 'SENT'; providerMessageId?: string | null }
): Promise<Reminder> {
  fills += 1;
  const branchId = input.branchId ?? A1;
  const fillId = id(`fill_${label}`);
  const captureId = id(`capture_${label}`);
  const logId = id(`log_${label}`);
  const providerMessageId = input.providerMessageId ?? `wamid.${label}.${suffix}`;
  await platform(
    `INSERT INTO pharmacy_prescription_fills
      ("id", "organizationId", "prescriptionLineId", "fillSequence", "quantityCanonicalUnits",
       "dispensedByUserId", "idempotencyKey")
     VALUES ($1, $2, $3, $4, 1, 'pharmacist', $5)`,
    fillId,
    ORG_A,
    id('line'),
    fills,
    fillId
  );
  await platform(
    `INSERT INTO pharmacy_refill_reminder_captures
      ("id", "organizationId", "branchId", "prescriptionFillId", "patientId", "channel",
       "consentEventId", "medicineName", "strength", "dosageForm", "directionsEnglish",
       "directionsUrdu", "quantityDispensed", "dosesPerDay", "expectedExhaustionAt",
       "reminderAt", "capturedByUserId", "idempotencyKey", "status", "queuedAt")
     VALUES ($1, $2, $3, $4, $5, 'WHATSAPP', $6, 'Medicine', '1 mg', 'Tablet', 'Once daily',
       'روزانہ', 30, 1, $7, $8, 'pharmacist', $9, 'QUEUED', $8)`,
    captureId,
    ORG_A,
    branchId,
    fillId,
    id('patient'),
    id('consent'),
    new Date('2026-11-01T00:00:00.000Z'),
    new Date('2026-10-19T00:00:00.000Z'),
    captureId
  );
  await platform(
    `INSERT INTO pharmacy_message_logs
      ("id", "organizationId", "branchId", "patientId", "direction", "kind", "status",
       "dedupeKey", "templateName", "refillCaptureId", "providerMessageId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'OUTBOUND', 'REFILL_REMINDER', $5, $6,
       'refill_reminder_bilingual_v1', $7, $8, $9, $9)`,
    logId,
    ORG_A,
    branchId,
    id('patient'),
    input.status,
    `refill-capture:${captureId}`,
    captureId,
    input.providerMessageId === null ? null : providerMessageId,
    new Date('2026-10-19T00:00:00.000Z')
  );
  return { captureId, logId, providerMessageId };
}

function ack(
  organizationId: string,
  providerMessageId: string,
  state: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED',
  occurredAt: Date
) {
  return deps.scoped.withTenantDb(organizationId, (db) =>
    deps.acks.applyProviderAck(db, organizationId, { providerMessageId, state, occurredAt }, NOW)
  );
}

async function read(reminder: Reminder) {
  return deps.scoped.withPlatformDb(async (db) => {
    const log = await db.pharmacyMessageLog.findUniqueOrThrow({
      where: { id: reminder.logId },
      select: {
        status: true,
        statusAt: true,
        deliveredAt: true,
        readAt: true,
        error: true,
        providerMessageId: true,
      },
    });
    const capture = await db.$queryRawUnsafe<Array<{ status: string; sentAt: Date | null }>>(
      `SELECT status, "sentAt" FROM pharmacy_refill_reminder_captures WHERE id = $1`,
      reminder.captureId
    );
    return { log, capture: capture[0] };
  });
}

describeIfDatabase('provider acknowledgements against PostgreSQL (runtime role)', () => {
  beforeAll(async () => {
    const [scoped, acks, log, refill, roleGuard] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./message-acks'),
      import('./message-log'),
      import('@/lib/pharmacy/refill-reminder-sender'),
      import('@/lib/testing/rls-role-guard'),
    ]);
    deps = { scoped, acks, log, refill };
    await roleGuard.assertRlsEnforcingRole(scoped.withPlatformDb);
    await platform(
      `INSERT INTO organizations
        (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'Ack A', 'Ack A', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
              ($3, $4, 'Ack B', 'Ack B', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ORG_A,
      `${ORG_A}-slug`,
      ORG_B,
      `${ORG_B}-slug`
    );
    await platform(
      `INSERT INTO pharmacy_branches
        (id, "organizationId", code, name, "addressLine", city, "provinceCode", active, "createdAt", "updatedAt")
       VALUES ($1, $2, 'A1', 'Branch A1', '1 A Road', 'Lahore', 'PB', true, now(), now()),
              ($3, $2, 'A2', 'Branch A2', '2 A Road', 'Lahore', 'PB', true, now(), now())`,
      A1,
      ORG_A,
      A2
    );
    await platform(
      `INSERT INTO pharmacy_patients (id, "organizationId", "displayName", "updatedAt")
       VALUES ($1, $2, 'Ack patient', now())`,
      id('patient'),
      ORG_A
    );
    await platform(
      `INSERT INTO pharmacy_patient_consents
        (id, "organizationId", "patientId", purpose, channel, version, granted, "recordedByUserId")
       VALUES ($1, $2, $3, 'REMINDERS', 'WHATSAPP', 1, true, 'pharmacist')`,
      id('consent'),
      ORG_A,
      id('patient')
    );
    await platform(
      `INSERT INTO pharmacy_medicines (id, "organizationId", "productName", "productFamily", "updatedAt")
       VALUES ($1, $2, 'Medicine', 'PHARMACEUTICAL', now())`,
      id('medicine'),
      ORG_A
    );
    await platform(
      `INSERT INTO pharmacy_presentations (id, "organizationId", "medicineId", presentation, "updatedAt")
       VALUES ($1, $2, $3, 'tablet', now())`,
      id('presentation'),
      ORG_A,
      id('medicine')
    );
    await platform(
      `INSERT INTO pharmacy_prescribers (id, "organizationId", name, "registrationNumber")
       VALUES ($1, $2, 'Prescriber', $3)`,
      id('prescriber'),
      ORG_A,
      `REG-${suffix}`
    );
    await platform(
      `INSERT INTO pharmacy_prescriptions
        (id, "organizationId", "patientId", "prescriberId", "sourceKind", "sourceFileRef",
         "validFrom", "validUntil", "authorizedRepeats", "capturedByUserId")
       VALUES ($1, $2, $3, $4, 'PAPER_IMAGE', $5, now() - interval '1 day',
         now() + interval '30 days', 50, 'pharmacist')`,
      id('prescription'),
      ORG_A,
      id('patient'),
      id('prescriber'),
      `paper/${suffix}`
    );
    await platform(
      `INSERT INTO pharmacy_prescription_lines
        (id, "organizationId", "prescriptionId", "lineNumber", "medicineId", "presentationId",
         "authorizedCanonicalUnits", directions)
       VALUES ($1, $2, $3, 1, $4, $5, 100, 'Once daily')`,
      id('line'),
      ORG_A,
      id('prescription'),
      id('medicine'),
      id('presentation')
    );
  });

  it('moves sent -> delivered -> read and marks the capture sent once', async () => {
    const reminder = await queuedReminder('lifecycle', { status: 'SENT' });
    await expect(ack(ORG_A, reminder.providerMessageId, 'DELIVERED', T1)).resolves.toBe('APPLIED');
    await expect(read(reminder)).resolves.toMatchObject({
      log: { status: 'DELIVERED', statusAt: T1, deliveredAt: T1, readAt: null },
      capture: { status: 'SENT', sentAt: T1 },
    });
    await expect(ack(ORG_A, reminder.providerMessageId, 'READ', T2)).resolves.toBe('APPLIED');
    await expect(read(reminder)).resolves.toMatchObject({
      log: { status: 'READ', statusAt: T2, deliveredAt: T1, readAt: T2 },
      capture: { status: 'SENT', sentAt: T1 },
    });
  });

  it('ignores a duplicate or stale acknowledgement without regressing', async () => {
    const reminder = await queuedReminder('replays', { status: 'SENT' });
    await ack(ORG_A, reminder.providerMessageId, 'READ', T2);
    const settled = await read(reminder);
    await expect(ack(ORG_A, reminder.providerMessageId, 'READ', T2)).resolves.toBe('DUPLICATE');
    await expect(ack(ORG_A, reminder.providerMessageId, 'DELIVERED', T1)).resolves.toBe('STALE');
    await expect(ack(ORG_A, reminder.providerMessageId, 'SENT', T1)).resolves.toBe('STALE');
    await expect(ack(ORG_A, reminder.providerMessageId, 'FAILED', T2)).resolves.toBe('STALE');
    await expect(read(reminder)).resolves.toEqual(settled);
    expect(settled.log).toMatchObject({ status: 'READ', readAt: T2 });
  });

  it('records FAILED only after SENT and never marks the capture sent for it', async () => {
    const reminder = await queuedReminder('failed', { status: 'SENT' });
    await expect(ack(ORG_A, reminder.providerMessageId, 'FAILED', T1)).resolves.toBe('APPLIED');
    await expect(ack(ORG_A, reminder.providerMessageId, 'DELIVERED', T2)).resolves.toBe('STALE');
    await expect(read(reminder)).resolves.toMatchObject({
      log: { status: 'FAILED', statusAt: T1, error: 'PROVIDER_FAILURE' },
      capture: { status: 'QUEUED', sentAt: null },
    });
  });

  it('cannot create provider acceptance for a log the provider never accepted', async () => {
    const reminder = await queuedReminder('pending', { status: 'PENDING' });
    await expect(ack(ORG_A, reminder.providerMessageId, 'DELIVERED', T1)).resolves.toBe('UNBOUND');
    await expect(read(reminder)).resolves.toMatchObject({
      log: { status: 'PENDING', deliveredAt: null },
      capture: { status: 'QUEUED' },
    });
  });

  it("does not let another tenant acknowledge this tenant's message", async () => {
    const reminder = await queuedReminder('tenant', { status: 'SENT' });
    await expect(ack(ORG_B, reminder.providerMessageId, 'DELIVERED', T1)).resolves.toBe('UNBOUND');
    // Even naming the owning tenant inside another tenant's transaction: RLS.
    await expect(
      deps.scoped.withTenantDb(ORG_B, (db) =>
        deps.acks.applyProviderAck(
          db,
          ORG_A,
          { providerMessageId: reminder.providerMessageId, state: 'DELIVERED', occurredAt: T1 },
          NOW
        )
      )
    ).resolves.toBe('UNBOUND');
    await expect(read(reminder)).resolves.toMatchObject({
      log: { status: 'SENT' },
      capture: { status: 'QUEUED' },
    });
  });

  it("marks a capture sent only through its own outbox claim's accepted log", async () => {
    const reminder = await queuedReminder('evidence', {
      status: 'PENDING',
      providerMessageId: null,
    });
    // A different accepted log in another branch that names this capture.
    const forged = id('log_forged');
    await platform(
      `INSERT INTO pharmacy_message_logs
        ("id", "organizationId", "branchId", "direction", "kind", "status", "dedupeKey",
         "refillCaptureId", "providerMessageId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'OUTBOUND', 'REFILL_REMINDER', 'SENT', $4, $5, $6, now(), now())`,
      forged,
      ORG_A,
      A2,
      `refill-capture:${reminder.captureId}:forged`,
      reminder.captureId,
      `wamid.forged.${suffix}`
    );
    await expect(ack(ORG_A, `wamid.forged.${suffix}`, 'DELIVERED', T1)).resolves.toBe('APPLIED');
    // Identifiers alone, with the capture's own log not accepted, move nothing.
    await expect(
      deps.scoped.withTenantDb(ORG_A, (db) =>
        deps.refill.markRefillReminderSent(db, {
          organizationId: ORG_A,
          branchId: A1,
          captureId: reminder.captureId,
          messageLogId: reminder.logId,
          providerMessageId: reminder.providerMessageId,
          sentAt: T1,
        })
      )
    ).resolves.toBe(0);
    await expect(read(reminder)).resolves.toMatchObject({ capture: { status: 'QUEUED' } });
  });

  it('marks the capture sent in the same transaction as the outbox acceptance', async () => {
    const reminder = await queuedReminder('accepted', {
      status: 'PENDING',
      providerMessageId: null,
    });
    const entry = {
      organizationId: ORG_A,
      kind: 'REFILL_REMINDER' as const,
      dedupeKey: `refill-capture:${reminder.captureId}`,
      branchId: A1,
      refillCaptureId: reminder.captureId,
    };
    await expect(
      deps.log.sendClaimedMessage(entry, reminder.logId, async () => ({
        providerMessageId: reminder.providerMessageId,
        acceptedByProvider: true,
      }))
    ).resolves.toBe('SENT');
    const accepted = await read(reminder);
    expect(accepted.log).toMatchObject({
      status: 'SENT',
      providerMessageId: reminder.providerMessageId,
    });
    expect(accepted.capture).toMatchObject({ status: 'SENT' });

    const prepared = await queuedReminder('prepared', {
      status: 'PENDING',
      providerMessageId: null,
    });
    await expect(
      deps.log.sendClaimedMessage(
        {
          ...entry,
          dedupeKey: `refill-capture:${prepared.captureId}`,
          refillCaptureId: prepared.captureId,
        },
        prepared.logId,
        async () => ({ providerMessageId: prepared.providerMessageId, acceptedByProvider: false })
      )
    ).resolves.toBe('PREPARED');
    await expect(read(prepared)).resolves.toMatchObject({
      log: { status: 'IGNORED' },
      capture: { status: 'QUEUED' },
    });
  });
});
