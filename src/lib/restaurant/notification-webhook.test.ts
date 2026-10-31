import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('@/lib/secret-crypto', () => ({
  decryptSecret: vi.fn(() => 'test-signing-secret-that-is-long-enough'),
}));

import {
  NOTIFICATION_WEBHOOK_EVENT_TYPE,
  assertSafeWebhookUrl,
  createNotificationWebhookConsumer,
  createNotificationWebhookJobHandler,
  createPinnedHttpsTransport,
  registerNotificationWebhookConsumer,
  verifyWebhookSignature,
  webhookSignature,
} from '@/lib/restaurant/notification-webhook';
import { OutboxConsumerRegistry } from '@/lib/restaurant/outbox-dispatcher';

const notification = {
  id: 'notification_1',
  branchId: 'branch_1',
  category: 'sop.escalation',
  title: 'SOP late',
  body: 'Opening checklist is late.',
  entityType: 'sopOccurrence',
  entityId: 'occurrence_1',
  createdAt: new Date('2026-08-30T07:00:00.000Z'),
};

function db(enabled = true, isDemo = false) {
  const client = {
    organization: { findFirst: vi.fn().mockResolvedValue({ isDemo }) },
    restaurantNotificationWebhook: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'config_1',
        organizationId: 'org_1',
        endpointUrl: 'https://hooks.example.com/sop',
        encryptedSigningSecret: '[encrypted]',
        enabled,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    restaurantNotification: { findFirst: vi.fn().mockResolvedValue(notification) },
    restaurantNotificationDelivery: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    restaurantJob: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'job_1', ...data })),
    },
  };
  return { ...client, $transaction: vi.fn(async (work) => work(client)) };
}

const record = {
  id: 'event_1',
  status: 'PENDING' as const,
  attempts: 0,
  nextAttemptAt: null,
  eventType: 'restaurant.notification.webhook.v1',
  aggregateType: 'restaurant.notification',
  aggregateId: notification.id,
  payload: { notificationId: notification.id, version: '1.0' },
};

const job = {
  id: 'job_1',
  organizationId: 'org_1',
  type: 'notification.webhook.deliver.v1',
  payload: {
    eventId: record.id,
    notificationId: notification.id,
    attemptOffset: 0,
    version: '1.0',
  },
  attempts: 1,
  maxAttempts: 5,
  claimedBy: 'worker_1',
  claimToken: 'notification-webhook-test-claim',
  startedAt: new Date('2026-08-30T07:01:00.000Z'),
};
const publicLookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

describe('restaurant notification webhook', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('signs timestamp and exact body with a verifiable HMAC', () => {
    const signature = webhookSignature('secret', '1770000000', '{"ok":true}');
    expect(verifyWebhookSignature('secret', '1770000000', '{"ok":true}', signature)).toBe(true);
    expect(verifyWebhookSignature('secret', '1770000001', '{"ok":true}', signature)).toBe(false);
  });

  it('denies loopback, private DNS, credentials, and non-HTTPS in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(assertSafeWebhookUrl('http://example.com/hook')).rejects.toThrow(/HTTPS/);
    await expect(assertSafeWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow(/private/);
    await expect(assertSafeWebhookUrl('https://[fc00::1]/hook')).rejects.toThrow(/private/);
    await expect(assertSafeWebhookUrl('https://user:pass@example.com/hook')).rejects.toThrow(
      /credentials/
    );
    await expect(
      assertSafeWebhookUrl(
        'https://hooks.example.com/hook',
        vi.fn().mockResolvedValue([{ address: '10.0.0.8', family: 4 }])
      )
    ).rejects.toThrow(/private/);
  });

  it('rejects HTTP consistently in test and development runtimes', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    await expect(assertSafeWebhookUrl('http://example.com/hook', publicLookup)).rejects.toThrow(
      /HTTPS/
    );
    vi.stubEnv('NODE_ENV', 'development');
    await expect(assertSafeWebhookUrl('http://example.com/hook', publicLookup)).rejects.toThrow(
      /HTTPS/
    );
  });

  it('rejects redirects and enforces an absolute request deadline', async () => {
    const redirect = vi.fn().mockResolvedValue(302);
    const client = db();
    await expect(
      createNotificationWebhookJobHandler({
        transport: redirect,
        lookup: publicLookup,
        failureDb: () => client as never,
      })({
        db: client as never,
        job,
      })
    ).rejects.toThrow('HTTP 302');

    vi.useFakeTimers();
    const request = new EventEmitter() as EventEmitter & {
      end: (body: string) => void;
      destroy: (error: Error) => void;
    };
    request.end = vi.fn();
    request.destroy = (error) => request.emit('error', error);
    const transport = createPinnedHttpsTransport(vi.fn(() => request) as never);
    const pending = transport({
      url: new URL('https://hooks.example.com/hook'),
      address: { address: '93.184.216.34', family: 4 },
      headers: {},
      body: '{}',
    });
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    vi.useRealTimers();
  });

  it('aborts when a receiver exceeds the bounded response body', async () => {
    const request = new EventEmitter() as EventEmitter & {
      end: (body: string) => void;
      destroy: (error: Error) => void;
    };
    const response = new EventEmitter() as EventEmitter & {
      statusCode: number;
      destroy: (error: Error) => void;
    };
    response.statusCode = 200;
    response.destroy = vi.fn();
    request.destroy = (error) => request.emit('error', error);
    const requestImpl = vi.fn((_url, _options, callback) => {
      request.end = () => {
        callback(response);
        request.emit('response', response);
        response.emit('data', Buffer.alloc(16_385));
      };
      return request;
    });
    const transport = createPinnedHttpsTransport(requestImpl as never);
    await expect(
      transport({
        url: new URL('https://hooks.example.com/hook'),
        address: { address: '93.184.216.34', family: 4 },
        headers: {},
        body: '{}',
      })
    ).rejects.toThrow('exceeded');
    expect(response.destroy).toHaveBeenCalled();
  });

  it('outbox consumer only enqueues one deterministic durable job', async () => {
    const client = db();
    await createNotificationWebhookConsumer()(record, client as never);
    expect(client.restaurantJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'notification.webhook.deliver.v1',
        idempotencyKey: `notification-webhook:${record.id}:initial`,
      }),
    });
    expect(client.restaurantNotificationWebhook.findFirst).not.toHaveBeenCalled();
  });

  it('registers the outbox consumer only once', () => {
    const registry = new OutboxConsumerRegistry();

    registerNotificationWebhookConsumer(registry);
    expect(() => registerNotificationWebhookConsumer(registry)).not.toThrow();
    expect(registry.has(NOTIFICATION_WEBHOOK_EVENT_TYPE)).toBe(true);
  });

  it('sinks both outbox scheduling and delivery for a demo tenant', async () => {
    const client = db(true, true);
    const transport = vi.fn();

    await createNotificationWebhookConsumer()(record, client as never);
    await createNotificationWebhookJobHandler({ transport, lookup: publicLookup })({
      db: client as never,
      job,
    });

    expect(client.restaurantJob.create).not.toHaveBeenCalled();
    expect(client.restaurantNotificationWebhook.findFirst).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('job sends stable identity headers and records a successful attempt without exposing the secret', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const transport = vi.fn().mockResolvedValue(204);
    const client = db();
    await createNotificationWebhookJobHandler({ transport, lookup: publicLookup })({
      db: client as never,
      job,
    });
    const request = transport.mock.calls[0]?.[0];
    expect(request.headers).toMatchObject({
      'x-devfathom-event-id': record.id,
      'x-devfathom-idempotency-key': record.id,
    });
    expect(JSON.parse(String(request.body))).toMatchObject({
      version: '1.0',
      id: record.id,
      type: 'restaurant.sop.notification',
    });
    expect(JSON.stringify(transport.mock.calls)).not.toContain('[encrypted]');
    expect(client.restaurantNotificationDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ channel: 'WEBHOOK', status: 'DELIVERED_WEBHOOK', attempt: 1 }),
        ],
      })
    );
  });

  it('records a redacted failure for retry and stops cleanly when disabled', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const transport = vi.fn().mockResolvedValue(503);
    const client = db();
    const evidence = db();
    await expect(
      createNotificationWebhookJobHandler({
        transport,
        lookup: publicLookup,
        failureDb: () => evidence as never,
      })({
        db: client as never,
        job,
      })
    ).rejects.toThrow('HTTP 503');
    expect(client.restaurantNotificationDelivery.createMany).not.toHaveBeenCalled();
    expect(evidence.restaurantNotificationDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: 'FAILED',
            error: 'Webhook endpoint returned HTTP 503.',
          }),
        ],
      })
    );
    expect(evidence.restaurantNotificationWebhook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastFailure: expect.any(String) }),
      })
    );

    const disabled = db(false);
    await createNotificationWebhookJobHandler({ transport, lookup: publicLookup })({
      db: disabled as never,
      job,
    });
    expect(disabled.restaurantNotification.findFirst).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects mixed DNS answers and passes the validated public address to transport', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const client = db();
    const mixedLookup = vi.fn().mockResolvedValue([
      { address: '203.0.113.8', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]);
    await expect(
      createNotificationWebhookJobHandler({
        lookup: mixedLookup,
        transport: vi.fn(),
        failureDb: () => client as never,
      })({
        db: client as never,
        job,
      })
    ).rejects.toThrow(/private/);

    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const transport = vi.fn().mockResolvedValue(204);
    await createNotificationWebhookJobHandler({ lookup, transport })({ db: db() as never, job });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ address: { address: '93.184.216.34', family: 4 } })
    );
  });

  it('pins DNS in test runtime and keeps manual retry attempts monotonic', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const transport = vi.fn().mockResolvedValue(204);
    const client = db();
    await createNotificationWebhookJobHandler({ lookup, transport })({
      db: client as never,
      job: { ...job, attempts: 2, payload: { ...job.payload, attemptOffset: 5 } },
    });
    expect(lookup).toHaveBeenCalled();
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ address: { address: '93.184.216.34', family: 4 } })
    );
    expect(client.restaurantNotificationDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ attempt: 7 })] })
    );
  });
});
