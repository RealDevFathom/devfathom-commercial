import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/secret-crypto', () => ({
  decryptSecret: vi.fn(() => 'test-signing-secret-that-is-long-enough'),
}));

import {
  assertSafeWebhookUrl,
  createNotificationWebhookConsumer,
  verifyWebhookSignature,
  webhookSignature,
} from '@/lib/restaurant/notification-webhook';

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

function db(enabled = true) {
  return {
    restaurantNotificationWebhook: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'config_1',
        endpointUrl: 'https://hooks.example.com/sop',
        encryptedSigningSecret: '[encrypted]',
        enabled,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    restaurantNotification: { findFirst: vi.fn().mockResolvedValue(notification) },
    restaurantNotificationDelivery: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
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

  it('sends stable identity headers and records a successful attempt without exposing the secret', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const transport = vi.fn().mockResolvedValue(204);
    const client = db();
    await createNotificationWebhookConsumer({ transport })(record, client as never);
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
    await expect(
      createNotificationWebhookConsumer({ transport })(record, client as never)
    ).rejects.toThrow('HTTP 503');
    expect(client.restaurantNotificationDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: 'FAILED',
            error: 'Webhook endpoint returned HTTP 503.',
          }),
        ],
      })
    );

    const disabled = db(false);
    await createNotificationWebhookConsumer({ transport })(record, disabled as never);
    expect(disabled.restaurantNotification.findFirst).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects mixed DNS answers and passes the validated public address to transport', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const mixedLookup = vi.fn().mockResolvedValue([
      { address: '203.0.113.8', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]);
    await expect(
      createNotificationWebhookConsumer({ lookup: mixedLookup, transport: vi.fn() })(
        record,
        db() as never
      )
    ).rejects.toThrow(/private/);

    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const transport = vi.fn().mockResolvedValue(204);
    await createNotificationWebhookConsumer({ lookup, transport })(record, db() as never);
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ address: { address: '93.184.216.34', family: 4 } })
    );
  });
});
