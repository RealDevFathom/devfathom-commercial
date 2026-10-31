// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { handleInboundWhatsAppMessage } from './inbound';
import { processDueWhatsAppKhataReminders } from './khata-reminders';
import { MockWhatsAppProvider, readWhatsAppConfig } from './provider';

// Isolate lock ordering from licensing; all consent, claim and reminder queries
// below use the production functions and real PostgreSQL transactions.
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({}),
}));

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const now = new Date('2026-10-31T08:00:00Z');

async function fixture() {
  const organizationId = `org_wa_concurrency_${randomBytes(6).toString('hex')}`;
  return withTenantDb(organizationId, async (db) => {
    await db.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: 'Consent concurrency test',
        displayName: 'Consent concurrency test',
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: 'Asia/Karachi',
      },
    });
    await db.organizationDepartment.create({
      data: { organizationId, key: 'TEST', name: 'Test' },
    });
    const actor = await db.user.create({
      data: {
        organizationId,
        name: 'Test owner',
        email: `${organizationId}@example.test`,
        role: 'ADMIN',
        department: 'TEST',
        title: 'Owner',
      },
    });
    const branch = await db.pharmacyBranch.create({
      data: {
        organizationId,
        code: 'TEST',
        name: 'Test',
        addressLine: 'Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branch.id);
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: 'Test patient', phone: '03001234567' },
    });
    const customer = await db.pharmacyCustomer.create({
      data: { organizationId, patientId: patient.id, displayName: 'Test', whatsappOptIn: true },
    });
    await db.patientConsent.create({
      data: {
        organizationId,
        patientId: patient.id,
        purpose: 'REMINDERS',
        channel: 'WHATSAPP',
        version: 1,
        granted: true,
        recordedByUserId: actor.id,
        recordedAt: new Date('2026-01-01'),
      },
    });
    const family = await db.pharmacyFamilyAccount.create({
      data: {
        organizationId,
        branchId: branch.id,
        payerCustomerId: customer.id,
        displayName: 'Test',
      },
    });
    const member = await db.pharmacyFamilyMember.create({
      data: {
        organizationId,
        branchId: branch.id,
        familyAccountId: family.id,
        customerId: customer.id,
      },
    });
    await db.pharmacyKhataEvent.create({
      data: {
        organizationId,
        branchId: branch.id,
        familyAccountId: family.id,
        memberId: member.id,
        kind: 'CHARGE',
        amountMinor: 50_000,
        dueAt: new Date('2026-10-01'),
        actorId: actor.id,
      },
    });
    return { organizationId, patientId: patient.id, customerId: customer.id };
  });
}

/** Wait for actual lock contention, rather than assuming a scheduling delay. */
async function waitForPatientWaiters(client: Client, count: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await client.query('SELECT pg_stat_clear_snapshot()');
    const result = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND usename = current_user
        AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
        AND query LIKE '%SELECT id FROM pharmacy_patients%'
    `);
    if (result.rows[0].count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the consent lock queue.');
}

suite('WhatsApp consent concurrency in PostgreSQL', () => {
  it.each(['STOP', 'reminder'] as const)(
    'commits concurrent STOP and reminder with %s queued first',
    async (first) => {
      const f = await fixture();
      const config = readWhatsAppConfig({
        PHARMACY_WHATSAPP_ORGANIZATION_ID: f.organizationId,
        PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'test-sender',
        PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER: 'khata_en',
      });
      const provider = new MockWhatsAppProvider(config);
      const blocker = new Client({ connectionString: url });
      await blocker.connect();
      const pending: Array<Promise<unknown>> = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query("SELECT set_config('app.current_organization_id', $1, true)", [
          f.organizationId,
        ]);
        await blocker.query('SELECT id FROM pharmacy_patients WHERE id = $1 FOR UPDATE', [
          f.patientId,
        ]);
        const stop = () =>
          handleInboundWhatsAppMessage(
            f.organizationId,
            provider,
            {
              providerMessageId: `stop-${randomBytes(6).toString('hex')}`,
              from: '923001234567',
              text: 'STOP',
              receivedAt: now,
              phoneNumberId: config.phoneNumberId,
            },
            now
          );
        const remind = () => processDueWhatsAppKhataReminders({ now, config, provider });
        pending.push(first === 'STOP' ? stop() : remind());
        await waitForPatientWaiters(blocker, 1);
        pending.push(first === 'STOP' ? remind() : stop());
        const settled = Promise.allSettled(pending);
        await waitForPatientWaiters(blocker, 2);
        await blocker.query('COMMIT');

        expect((await settled).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        const customer = await withTenantDb(f.organizationId, (db) =>
          db.pharmacyCustomer.findUniqueOrThrow({ where: { id: f.customerId } })
        );
        expect(customer.whatsappOptIn).toBe(false);
        expect(customer.whatsappOptInChangedAt).toEqual(now);
        const logs = await withTenantDb(f.organizationId, (db) => db.pharmacyMessageLog.findMany());
        expect(logs.filter((log) => log.kind === 'OPT_OUT')).toHaveLength(1);
        expect(provider.calls.filter((call) => call.kind === 'template')).toHaveLength(
          first === 'STOP' ? 0 : 1
        );
        const retry = await processDueWhatsAppKhataReminders({ now, config, provider });
        expect(retry).toMatchObject({ skippedNoConsent: 1, prepared: 0, sent: 0 });
      } finally {
        await blocker.query('ROLLBACK');
        await Promise.allSettled(pending);
        await blocker.end();
      }
    },
    15_000
  );
});
