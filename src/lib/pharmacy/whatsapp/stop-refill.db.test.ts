// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { WhatsAppProvider } from './provider';

/**
 * Loyalty 5 hold fix: `STOP REFILL` is its own intent. Run through the real
 * inbound handler against PostgreSQL as the restricted runtime role (FORCE
 * RLS): it changes only the refill-reminder preference, never the customer's
 * WhatsApp consent flag or its timestamp, whatever that timestamp is.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG = `org_stop_refill_${suffix}`;
const NOW = new Date('2026-10-20T12:00:00.000Z');
/** The customer's last customer-wide consent change (a START). */
const CONSENT_AT = new Date('2026-10-20T10:00:00.000Z');
const minutes = (base: Date, delta: number) => new Date(base.getTime() + delta * 60_000);

type Deps = {
  scoped: typeof import('@/lib/tenancy/scoped-db');
  inbound: typeof import('./inbound');
  refill: typeof import('@/lib/pharmacy/refill-reminder-sender');
  messages: typeof import('./messages');
};
let deps: Deps;

const sent: Array<{ to: string; body: string }> = [];
const provider = {
  name: 'mock',
  async sendText(input: { to: string; body: string }) {
    sent.push(input);
    return { providerMessageId: `mock-${sent.length}-${suffix}`, acceptedByProvider: false };
  },
  async sendTemplate() {
    throw new Error('not used');
  },
  verifyWebhook: () => false,
  parseInbound: () => [],
} as unknown as WhatsAppProvider;

let sequence = 0;
type Customer = { label: string; patientId: string; customerId: string; waId: string };

/** One customer per case: active, opted in to WhatsApp at CONSENT_AT. */
async function customer(label: string): Promise<Customer> {
  sequence += 1;
  const patientId = `patient_${label}_${suffix}`;
  const customerId = `customer_${label}_${suffix}`;
  const local = `0300${String(1_234_500 + sequence)}`;
  await deps.scoped.withPlatformDb(async (db) => {
    await db.$executeRawUnsafe(
      `INSERT INTO pharmacy_patients (id, "organizationId", "displayName", phone, "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      patientId,
      ORG,
      `Patient ${label}`,
      local
    );
    await db.$executeRawUnsafe(
      `INSERT INTO pharmacy_customers
        (id, "organizationId", "patientId", "displayName", active, "whatsappOptIn",
         "whatsappOptInChangedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, true, true, $5, now())`,
      customerId,
      ORG,
      patientId,
      `Customer ${label}`,
      CONSENT_AT
    );
  });
  return { label, patientId, customerId, waId: deps.messages.normalizeWhatsAppNumber(local)! };
}

function inbound(
  who: Customer,
  text: string,
  receivedAt: Date,
  messageId = `${who.label}-${text}`
) {
  return deps.inbound.handleInboundWhatsAppMessage(
    ORG,
    provider,
    {
      providerMessageId: `wamid.${messageId}.${suffix}`,
      from: who.waId,
      text,
      receivedAt,
      phoneNumberId: 'sender',
    },
    NOW
  );
}

function staffChoice(who: Customer, optedOut: boolean, at: Date) {
  return deps.scoped.withTenantDb(ORG, (db) =>
    deps.refill.setRefillReminderPreference(db, {
      organizationId: ORG,
      patientId: who.patientId,
      optedOut,
      source: 'STAFF',
      actorUserId: 'staff_user',
      now: at,
    })
  );
}

async function state(who: Customer) {
  return deps.scoped.withTenantDb(ORG, async (db) => {
    const consent = await db.pharmacyCustomer.findFirstOrThrow({
      where: { organizationId: ORG, id: who.customerId },
      select: { whatsappOptIn: true, whatsappOptInChangedAt: true },
    });
    const preference = await db.$queryRawUnsafe<
      Array<{ optedOut: boolean; source: string; changedAt: Date }>
    >(
      `SELECT "optedOut", source, "changedAt" FROM pharmacy_refill_reminder_preferences
       WHERE "organizationId" = $1 AND "patientId" = $2`,
      ORG,
      who.patientId
    );
    const logs = await db.pharmacyMessageLog.findMany({
      where: { organizationId: ORG, customerId: who.customerId, direction: 'INBOUND' },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, status: true, error: true },
    });
    return { ...consent, preference: preference[0] ?? null, logs };
  });
}

/** The customer-wide WhatsApp consent exactly as seeded. */
const UNCHANGED_CONSENT = { whatsappOptIn: true, whatsappOptInChangedAt: CONSENT_AT };

describeIfDatabase('STOP REFILL against PostgreSQL (runtime role, FORCE RLS)', () => {
  beforeAll(async () => {
    const [scoped, inboundModule, refill, messages, roleGuard] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./inbound'),
      import('@/lib/pharmacy/refill-reminder-sender'),
      import('./messages'),
      import('@/lib/testing/rls-role-guard'),
    ]);
    deps = { scoped, inbound: inboundModule, refill, messages };
    await roleGuard.assertRlsEnforcingRole(scoped.withPlatformDb);
    await scoped.withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `INSERT INTO organizations
          (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $2, 'Stop Refill', 'Stop Refill', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
        ORG,
        `${ORG}-slug`
      )
    );
  });

  it('stops refill reminders only and leaves the WhatsApp opt-in alone', async () => {
    const who = await customer('newer');
    const at = minutes(CONSENT_AT, 30);
    await expect(inbound(who, 'STOP REFILL', at)).resolves.toBe('REFILL_OPTED_OUT');
    await expect(state(who)).resolves.toEqual({
      ...UNCHANGED_CONSENT,
      preference: { optedOut: true, source: 'KEYWORD', changedAt: at },
      logs: [{ kind: 'REFILL_OPT_OUT', status: 'RECEIVED', error: null }],
    });
    expect(sent.at(-1)).toEqual({
      to: who.waId,
      body: deps.messages.WHATSAPP_REPLIES.refillOptedOut,
    });
  });

  it('does not touch the opt-in when STOP REFILL has the same timestamp as the last START', async () => {
    const who = await customer('equal');
    await expect(inbound(who, 'stop refill', CONSENT_AT)).resolves.toBe('REFILL_OPTED_OUT');
    await expect(state(who)).resolves.toMatchObject({
      ...UNCHANGED_CONSENT,
      preference: { optedOut: true, changedAt: CONSENT_AT },
    });
  });

  it('records an older STOP REFILL for refills only, without reading the opt-in clock', async () => {
    const who = await customer('older');
    const at = minutes(CONSENT_AT, -45);
    await expect(inbound(who, 'STOP REFILL', at)).resolves.toBe('REFILL_OPTED_OUT');
    await expect(state(who)).resolves.toMatchObject({
      ...UNCHANGED_CONSENT,
      preference: { optedOut: true, changedAt: at },
    });
  });

  it('ignores a replayed STOP REFILL, even after staff re-enabled reminders', async () => {
    const who = await customer('replay');
    const at = minutes(CONSENT_AT, 10);
    await expect(inbound(who, 'STOP REFILL', at, 'replay')).resolves.toBe('REFILL_OPTED_OUT');
    await staffChoice(who, false, minutes(CONSENT_AT, 20));
    await expect(inbound(who, 'STOP REFILL', at, 'replay')).resolves.toBe('DUPLICATE');
    await expect(state(who)).resolves.toMatchObject({
      ...UNCHANGED_CONSENT,
      preference: { optedOut: false, source: 'STAFF', changedAt: minutes(CONSENT_AT, 20) },
      logs: [{ kind: 'REFILL_OPT_OUT', status: 'RECEIVED' }],
    });
  });

  it('ignores a STOP REFILL older than the stored refill decision', async () => {
    const who = await customer('stale');
    await staffChoice(who, false, minutes(CONSENT_AT, 20));
    const replies = sent.length;
    await expect(inbound(who, 'STOP REFILL', minutes(CONSENT_AT, 5))).resolves.toBe(
      'STALE_CONSENT'
    );
    await expect(state(who)).resolves.toMatchObject({
      ...UNCHANGED_CONSENT,
      preference: { optedOut: false, source: 'STAFF' },
      logs: [{ kind: 'REFILL_OPT_OUT', status: 'IGNORED', error: 'STALE_CONSENT' }],
    });
    expect(sent).toHaveLength(replies);
  });

  it('lets the opt-out win an equal refill-decision timestamp', async () => {
    const who = await customer('tie');
    const at = minutes(CONSENT_AT, 15);
    await staffChoice(who, false, at);
    await expect(inbound(who, 'STOP REFILL', at)).resolves.toBe('REFILL_OPTED_OUT');
    await expect(state(who)).resolves.toMatchObject({
      ...UNCHANGED_CONSENT,
      preference: { optedOut: true, source: 'KEYWORD', changedAt: at },
    });
  });

  it('keeps a global STOP clearing the WhatsApp opt-in and stopping refill reminders', async () => {
    const who = await customer('global');
    const at = minutes(CONSENT_AT, 30);
    await expect(inbound(who, 'STOP', at)).resolves.toBe('OPTED_OUT');
    await expect(state(who)).resolves.toMatchObject({
      whatsappOptIn: false,
      whatsappOptInChangedAt: at,
      preference: { optedOut: true, source: 'KEYWORD' },
      logs: [{ kind: 'OPT_OUT', status: 'RECEIVED' }],
    });
  });
});
