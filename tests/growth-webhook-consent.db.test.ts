// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const suite = process.env.WA_CONSENT_TEST_DATABASE_URL ? describe : describe.skip;
suite('webhook STOP through the production stores under FORCE RLS', () => {
  it('commits opt-out before HTTP and dedupes confirmations by inbound event, including retries', async () => {
    const { PrismaClient } = await import('../src/generated/prisma/client');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { growthStore, outboundGrowthStore } = await import('../src/lib/growth/whatsapp/store');
    const { handleInboundText } = await import('../src/lib/growth/consent');
    const connectionString = process.env.WA_CONSENT_TEST_DATABASE_URL!;
    const db = new Client({ connectionString });
    await db.connect();
    const schema = 'wa_webhook_' + randomUUID().replaceAll('-', '');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
    const unit: import('../src/lib/growth/whatsapp/queue').StoreUnit = (run) =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          "SELECT set_config('app.current_organization_id','org_test',true)"
        );
        return run(outboundGrowthStore(tx));
      });
    try {
      await db.query(
        `CREATE SCHEMA ${schema}; SET search_path TO ${schema}; CREATE TABLE organizations (id text PRIMARY KEY); INSERT INTO organizations VALUES ('org_test')`
      );
      await db.query(
        readFileSync('prisma/migrations/20261021143000_growth_wa_channel/migration.sql', 'utf8')
      );
      await unit((store) =>
        store.createCustomer({
          organizationId: 'org_test',
          displayName: 'Test',
          whatsappE164: '+923001234567',
          whatsappOptIn: true,
          whatsappOptInAt: new Date(),
          whatsappOptOutAt: null,
        })
      );
      const queued = await unit(async (store) => {
        const customer = await store.customerByPhone('org_test', '+923001234567');
        return store.insertMessage({
          organizationId: 'org_test',
          customerId: customer!.id,
          direction: 'out',
          waMessageId: null,
          body: 'Reply STOP to opt out.',
          status: 'queued',
          campaignId: null,
          recipientId: null,
          error: null,
        });
      });
      expect((await unit((store) => store.claimQueued('org_test', queued.id)))?.status).toBe(
        'sending'
      );
      const sends: string[] = [];
      const deferred: Array<() => Promise<void>> = [];
      const provider = {
        async sendText(_phone: string, body: string) {
          // A new transaction sees committed consent; HTTP cannot roll it back.
          expect(
            (await unit((store) => store.customerByPhone('org_test', '+923001234567')))
              ?.whatsappOptIn
          ).toBe(false);
          expect(body).toContain('آپ کو');
          sends.push(body);
          return { providerMessageId: 'ack' };
        },
        async getStatus() {
          return 'connected' as const;
        },
      };
      const inbound = () =>
        prisma.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(
            "SELECT set_config('app.current_organization_id','org_test',true)"
          );
          return handleInboundText({
            store: growthStore(tx),
            provider,
            organizationId: 'org_test',
            fromE164: '+923001234567',
            text: 'STOP',
            waMessageId: 'event_1',
            businessName: 'Test shop',
            now: new Date(),
            afterCommit: (send) => deferred.push(send),
            confirmationUnit: unit,
          });
        });
      expect(await inbound()).toBe('opt_out');
      expect(sends).toHaveLength(0);
      expect(await inbound()).toBe('duplicate');
      await deferred[0]!();
      await deferred[0]!();
      expect(sends).toHaveLength(1);
      expect(await inbound()).toBe('duplicate');
      const messages = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          "SELECT set_config('app.current_organization_id','org_test',true)"
        );
        return tx.growthWaMessage.findMany({ where: { organizationId: 'org_test' } });
      });
      expect(messages).toHaveLength(3);
      expect(messages.find((m) => m.id === queued.id)).toMatchObject({
        status: 'failed',
        error: 'cancelled:opt_out',
      });
      expect(messages.find((m) => m.waMessageId?.startsWith('opt-out:'))).toMatchObject({
        status: 'sent',
        waMessageId: expect.stringMatching(/^opt-out:/),
      });
    } finally {
      await prisma.$disconnect();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  });
});
