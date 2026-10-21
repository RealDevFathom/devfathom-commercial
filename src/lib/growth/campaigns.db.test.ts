// @vitest-environment node
// Run against a disposable migrated local DB as NOSUPERUSER NOBYPASSRLS, with TZ=UTC.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { dispatchCampaignMessage } from './campaigns';
import { budgetMonthStart } from './budget';

const url = process.env.GROWTH_TEST_DATABASE_URL;
const organizationId = `growth_${randomUUID()}`;
const otherOrganizationId = `growth_${randomUUID()}`;
const now = new Date('2026-10-21T08:00:00Z');

describe.skipIf(!url)('campaign dispatch: restricted real PostgreSQL', () => {
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))
      throw new Error('Use a disposable local database.');
    vi.stubEnv('DATABASE_URL', url!);
    expect(
      await db.$queryRaw`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    for (const id of [organizationId, otherOrganizationId]) {
      await withTenantDb(id, async (tx) => {
        await tx.organization.create({
          data: {
            id,
            slug: id,
            legalName: 'Dispatch test',
            displayName: 'Test shop',
            timezone: 'Asia/Karachi',
            currency: 'PKR',
          },
        });
      });
    }
    await withTenantDb(organizationId, async (tx) => {
      await tx.growthSettings.create({ data: { organizationId } });
      const patient = await tx.pharmacyPatient.create({
        data: { organizationId, displayName: 'Test' },
      });
      const customer = await tx.pharmacyCustomer.create({
        data: {
          organizationId,
          patientId: patient.id,
          displayName: 'Test',
          whatsappOptIn: true,
          whatsappE164: '+923001234567',
        },
      });
      const template = await tx.messageTemplate.create({
        data: {
          organizationId,
          key: 'dispatch_test',
          body: 'Hello {{name}}. {{discount}}. Reply STOP.',
        },
      });
      const campaign = await tx.campaign.create({
        data: {
          organizationId,
          templateId: template.id,
          kind: 'manual',
          status: 'sending',
          name: 'Front shop',
          segment: { type: 'all' },
          sendAt: now,
          createdBy: 'test',
          discountType: 'fixed',
          discountValue: 1250,
          budgetCapMinor: 5000,
          codeExpiresAt: new Date('2026-10-22T08:00:00Z'),
        },
      });
      await tx.campaignRecipient.create({
        data: { organizationId, campaignId: campaign.id, customerId: customer.id },
      });
    });
  });
  afterAll(async () => {
    if (!url) return;
    for (const id of [organizationId, otherOrganizationId]) {
      await withTenantDb(id, async (tx) => {
        await tx.pharmacyMessageLog.deleteMany({ where: { organizationId: id } });
        await tx.campaignRecipient.deleteMany({ where: { organizationId: id } });
        await tx.campaign.deleteMany({ where: { organizationId: id } });
        await tx.messageTemplate.deleteMany({ where: { organizationId: id } });
        await tx.pharmacyCustomer.deleteMany({ where: { organizationId: id } });
        await tx.pharmacyPatient.deleteMany({ where: { organizationId: id } });
        await tx.growthSettings.deleteMany({ where: { organizationId: id } });
        await tx.organization.deleteMany({ where: { id } });
      });
    }
    await db.$disconnect();
    vi.unstubAllEnvs();
  });
  it('claims, sends and records exactly once, with FORCE RLS tenant isolation', async () => {
    const tables = await db.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('campaigns', 'campaign_recipients', 'pharmacy_message_logs')`;
    expect(tables).toHaveLength(3);
    expect(tables.every((t) => t.relrowsecurity && t.relforcerowsecurity)).toBe(true);
    const sendText = vi.fn(async () => ({
      acceptedByProvider: true,
      providerMessageId: 'test-message',
    }));
    const provider = {
      name: 'mock' as const,
      sendText,
      sendTemplate: sendText,
      verifyWebhook: () => false,
      parseInbound: () => [],
    };
    expect(await dispatchCampaignMessage(organizationId, now, provider)).toBe('SENT');
    await dispatchCampaignMessage(organizationId, new Date(now.getTime() + 10000), provider);
    expect(sendText).toHaveBeenCalledExactlyOnceWith({
      to: '+923001234567',
      body: 'Hello Test. PKR 12.50 on non-medicine products only. Reply STOP.',
    });
    await withTenantDb(organizationId, async (tx) => {
      const logs = await tx.pharmacyMessageLog.findMany({ where: { organizationId } });
      const recipients = await tx.campaignRecipient.findMany({ where: { organizationId } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        kind: 'GROWTH_CAMPAIGN',
        status: 'SENT',
        providerMessageId: 'test-message',
        recipientId: recipients[0].id,
      });
      expect(recipients[0]).toMatchObject({ status: 'sent', error: null });
      expect(recipients[0].sentAt?.toISOString()).toBe(now.toISOString());
    });
    await withTenantDb(otherOrganizationId, async (tx) => {
      expect(await tx.pharmacyMessageLog.count({ where: { organizationId } })).toBe(0);
      expect(await tx.campaignRecipient.count({ where: { organizationId } })).toBe(0);
    });
  });
  it('uses the org month across UTC boundaries and DST', async () => {
    await withTenantDb(organizationId, async (tx) => {
      expect(
        (await budgetMonthStart(tx, organizationId, new Date('2026-10-31T20:00:00Z'))).toISOString()
      ).toBe('2026-10-31T19:00:00.000Z');
      await tx.organization.update({
        where: { id: organizationId },
        data: { timezone: 'America/New_York' },
      });
      expect(
        (await budgetMonthStart(tx, organizationId, new Date('2026-11-20T08:00:00Z'))).toISOString()
      ).toBe('2026-11-01T04:00:00.000Z');
    });
  });
});
