import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const store = vi.hoisted(() => ({ selection: null as Prisma.Sql | null }));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({
      $queryRaw: async (query: Prisma.Sql) => {
        store.selection = query;
        return [];
      },
    }),
  withTenantDb: vi.fn(() => {
    throw new Error('Selection probes must not send messages.');
  }),
}));

import { readSmsConfig } from '../sms/provider';
import { readWhatsAppConfig } from './provider';
import { processDueWhatsAppRefillReminders } from './refill-reminders';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const NOW = new Date('2026-10-21T08:00:00.000Z');
let client: Client;

suite('refill batch selection (PostgreSQL)', () => {
  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await processDueWhatsAppRefillReminders({
      now: NOW,
      limit: 1,
      config: readWhatsAppConfig({
        PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org_a',
        PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'sender',
        PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER: 'refill',
      }),
      smsConfig: readSmsConfig({ PHARMACY_SMS_ORGANIZATION_ID: 'org_a' }),
    });
    expect(store.selection).not.toBeNull();
  });

  afterAll(async () => client?.end());

  async function select(input: {
    channel: 'SMS' | 'WHATSAPP';
    status?: 'FAILED' | 'UNKNOWN' | 'SENT';
    smsGranted?: boolean;
    revoked?: boolean;
    stopped?: boolean;
    whatsappGranted?: boolean;
  }) {
    // CTEs shadow the production tables with small fixtures. Execute the actual
    // parameterized selection on PostgreSQL without creating or mutating rows.
    const query = Prisma.sql`
      WITH pharmacy_refill_reminder_captures AS (
        SELECT id, 'org_a'::text AS "organizationId", 'branch'::text AS "branchId",
          id AS "prescriptionFillId", id AS "patientId", channel,
          'Medicine'::text AS "medicineName", 'Once daily'::text AS "directionsEnglish",
          30 AS "quantityDispensed", due AS "expectedExhaustionAt"
        FROM (VALUES
          ('old'::text, ${input.channel}::text, '2026-10-22T08:00:00Z'::timestamptz),
          ('new'::text, 'SMS'::text, '2026-10-23T08:00:00Z'::timestamptz)
        ) fixture(id, channel, due)
      ), pharmacy_prescription_fills AS (
        SELECT id, "organizationId", id AS "prescriptionLineId",
          "expectedExhaustionAt" - interval '30 days' AS "dispensedAt"
        FROM pharmacy_refill_reminder_captures
      ), pharmacy_prescription_lines AS (
        SELECT id, "organizationId", id AS "medicineId" FROM pharmacy_refill_reminder_captures
      ), pharmacy_customers AS (
        SELECT id AS "patientId", "organizationId", true AS active,
          id = 'old' AND ${input.whatsappGranted ?? false} AS "whatsappOptIn",
          NOT (id = 'old' AND ${input.stopped ?? false}) AS "smsOptIn"
        FROM pharmacy_refill_reminder_captures
      ), pharmacy_patient_consents AS (
        SELECT 'org_a'::text AS "organizationId", 'REMINDERS'::text AS purpose,
          patient AS "patientId", channel, version, granted, revoked AS "revokedAt",
          '2026-10-01T00:00:00Z'::timestamptz AS "recordedAt"
        FROM (VALUES
          ('new'::text, 'SMS'::text, 1, true, NULL::timestamptz),
          ('old'::text, 'SMS'::text, 1, true, NULL::timestamptz),
          ('old'::text, 'SMS'::text, 2, ${input.smsGranted ?? false},
            ${input.revoked ? NOW : null}::timestamptz),
          ('old'::text, 'WHATSAPP'::text, 1, ${input.whatsappGranted ?? false}, NULL::timestamptz)
        ) fixture(patient, channel, version, granted, revoked)
      ), pharmacy_message_logs AS (
        SELECT 'org_a'::text AS "organizationId", 'old'::text AS "refillCaptureId",
          'WHATSAPP'::text AS channel, ${input.status ?? null}::text AS status
        WHERE ${Boolean(input.status)}
      )
      ${store.selection!}
    `;
    const result = await client.query<{ id: string }>(query.text, query.values);
    return result.rows.map((row) => row.id);
  }

  it.each([
    { channel: 'SMS' as const },
    { channel: 'WHATSAPP' as const },
    { channel: 'WHATSAPP' as const, status: 'FAILED' as const, whatsappGranted: true },
    { channel: 'SMS' as const, smsGranted: true, revoked: true },
    { channel: 'SMS' as const, smsGranted: true, stopped: true },
  ])('does not let an ineligible older capture crowd out a newer one: %j', async (input) => {
    await expect(select(input)).resolves.toEqual(['new']);
  });

  it('retains a failed WhatsApp capture when SMS consent becomes available', async () => {
    await expect(select({
      channel: 'WHATSAPP', status: 'FAILED', whatsappGranted: true, smsGranted: true,
    })).resolves.toEqual(['old']);
  });

  it('keeps an eligible WhatsApp capture without requiring SMS consent', async () => {
    await expect(select({ channel: 'WHATSAPP', whatsappGranted: true })).resolves.toEqual(['old']);
  });

  it.each(['UNKNOWN', 'SENT'] as const)('never falls back on a %s WhatsApp claim', async (status) => {
    await expect(select({
      channel: 'WHATSAPP', status, whatsappGranted: true, smsGranted: true,
    })).resolves.toEqual(['new']);
  });
});
