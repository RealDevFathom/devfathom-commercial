/** Opt in with an isolated *_webhook_quota_test database. Only the test owner
 * seeds aggregate counts. All queue and inbox operations use the runtime role. */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';

const runtimeUrl = process.env.RESTAURANT_WEBHOOK_QUOTA_TEST_DATABASE_URL;

it.skipIf(!runtimeUrl)(
  'serializes cross-business admissions at both deployment thresholds',
  async () => {
    const runtime = new URL(runtimeUrl!);
    const owner = new URL(process.env.MIGRATION_DATABASE_URL!);
    expect(runtime.pathname).toMatch(/_webhook_quota_test$/);
    expect([owner.host, owner.pathname]).toEqual([runtime.host, runtime.pathname]);
    expect(owner.username).not.toBe(runtime.username);
    process.env.DATABASE_URL = runtime.href;
    const { withPlatformDb, withTenantDb, createTenantDb } =
      await import('@/lib/tenancy/scoped-db');
    const { recordInboundWebhook } = await import('@/lib/restaurant/webhook-inbox');
    const { enqueue } = await import('@/lib/restaurant/scheduler');
    const fixture = new Client({ connectionString: owner.href });
    await fixture.connect();
    const seedCount = (count: number) =>
      fixture.query(
        'UPDATE restaurant_queue_private.webhook_capacity SET pending = $1 WHERE singleton',
        [count]
      );
    const count = async () =>
      Number(
        (
          await fixture.query(
            'SELECT pending FROM restaurant_queue_private.webhook_capacity WHERE singleton'
          )
        ).rows[0].pending
      );
    try {
      const roleSql = 'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user';
      expect((await fixture.query(roleSql)).rows).toEqual([
        { rolsuper: false, rolbypassrls: false },
      ]);
      expect(
        await withPlatformDb(
          (db) => db.$queryRaw`
      SELECT rolsuper, rolbypassrls, has_schema_privilege(current_user, 'restaurant_queue_private', 'USAGE') AS access
      FROM pg_roles WHERE rolname = current_user
    `
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false, access: false }]);
      const ids = [randomUUID(), randomUUID()];
      for (const id of ids) {
        await withPlatformDb((db) =>
          db.organization.create({
            data: {
              id,
              slug: id,
              legalName: 'Quota fixture',
              displayName: 'Quota fixture',
              status: 'ACTIVE',
            },
          })
        );
        await withTenantDb(id, async (db) => {
          const branch = await db.restaurantBranch.create({ data: { name: 'Fixture' } });
          const device = await db.restaurantRegisteredDevice.create({
            data: {
              branchId: branch.id,
              name: 'Terminal',
              deviceSecretHash: randomUUID(),
            },
          });
          await db.restaurantTerminalProviderConfig.create({
            data: {
              source: 'fixture',
              externalTerminalId: 'fixture-terminal',
              mode: 'WEBHOOK',
              deviceId: device.id,
              branchId: branch.id,
            },
          });
        });
      }
      const ordinary = {
        source: 'fixture',
        verificationStatus: 'VERIFIED' as const,
        externalEventId: 'ordinary',
        eventType: 'restaurant.event',
        payload: {},
      };
      const payment = {
        ...ordinary,
        externalEventId: 'payment',
        eventType: 'terminal.payment',
        payload: {
          terminalId: 'fixture-terminal',
          status: 'approved',
          reference: 'fixture-bill',
          amount: '1.00',
          staffProfileId: 'fixture-staff',
          providerReference: 'fixture-payment',
        },
      };
      // Each pair runs on two independent runtime transactions with distinct
      // tenant advisory locks. Only the deployment counter is shared.
      async function race(input: typeof ordinary, before: number) {
        await seedCount(before);
        const outcomes = await Promise.allSettled(
          ids.map((id) => recordInboundWebhook(createTenantDb(id), input))
        );
        expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes).toContainEqual({
          status: 'rejected',
          reason: expect.objectContaining({ status: 429 }),
        });
        expect(await count()).toBe(before + 1);
        const inboxCounts = await Promise.all(
          ids.map((id) =>
            createTenantDb(id).restaurantWebhookInbox.count({
              where: { externalEventId: input.externalEventId },
            })
          )
        );
        expect(inboxCounts.toSorted()).toEqual([0, 1]);
        const winner = ids[inboxCounts.indexOf(1)]!;
        const duplicate = await recordInboundWebhook(createTenantDb(winner), input);
        expect(duplicate.deduplicated).toBe(true);
        expect(await count()).toBe(before + 1);
        return { db: createTenantDb(winner), inboxId: duplicate.inbox.id };
      }
      const generic = await race(ordinary, 39_999);
      await expect(
        enqueue(generic.db, { type: 'webhook.process', payload: { inboxId: generic.inboxId } })
      ).rejects.toMatchObject({ reason: 'WEBHOOK_CAPACITY' });
      await expect(
        recordInboundWebhook(generic.db, {
          ...payment,
          externalEventId: 'unknown-terminal',
          payload: { ...payment.payload, terminalId: 'unconfigured' },
        })
      ).rejects.toMatchObject({ status: 429 });
      expect(
        await generic.db.restaurantWebhookInbox.count({
          where: { externalEventId: 'unknown-terminal' },
        })
      ).toBe(0);
      const signed = await race(payment, 49_999);
      const existing = await signed.db.restaurantJob.findFirstOrThrow({
        where: { idempotencyKey: `webhook.process:${signed.inboxId}` },
      });
      await expect(
        enqueue(signed.db, { type: 'webhook.process', payload: { inboxId: signed.inboxId } })
      ).rejects.toMatchObject({ reason: 'WEBHOOK_CAPACITY' });
      await seedCount(49_998);
      await expect(
        enqueue(signed.db, { type: 'webhook.process', payload: { inboxId: signed.inboxId } })
      ).rejects.toMatchObject({ reason: 'WEBHOOK_CAPACITY' });
      expect(await count()).toBe(49_998);
      await seedCount(50_000);
      await signed.db.restaurantJob.update({
        where: { id: existing.id },
        data: { status: 'RUNNING' },
      });
      expect(await count()).toBe(50_000);
      await signed.db.restaurantJob.update({
        where: { id: existing.id },
        data: { status: 'DEAD' },
      });
      expect(await count()).toBe(49_999);
      const requeued = await enqueue(signed.db, {
        type: 'webhook.process',
        payload: { inboxId: signed.inboxId },
      });
      expect(requeued.job.id).not.toBe(existing.id);
      expect(await count()).toBe(50_000);
      expect(
        (await signed.db.restaurantJob.findUniqueOrThrow({ where: { id: existing.id } })).status
      ).toBe('DEAD');
    } finally {
      // Remove only the synthetic count offset. Leave existing and fixture jobs intact.
      try {
        await fixture.query('BEGIN');
        await fixture.query('LOCK TABLE public.restaurant_jobs IN SHARE ROW EXCLUSIVE MODE');
        await fixture.query("SET LOCAL app.is_platform_admin = 'true'");
        await fixture.query(`UPDATE restaurant_queue_private.webhook_capacity SET pending = (
        SELECT count(*) FROM public.restaurant_jobs WHERE type = 'webhook.process' AND status IN ('QUEUED','RUNNING')
      ) WHERE singleton`);
        await fixture.query('COMMIT');
      } finally {
        await fixture.end();
      }
    }
  },
  30_000
);
