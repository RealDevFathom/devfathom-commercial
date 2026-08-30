import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { z } from 'zod';

import { decryptSecret } from '@/lib/secret-crypto';
import {
  OutboxConsumerRegistry,
  restaurantOutboxConsumers,
  type OutboxConsumer,
  type OutboxDispatchRecord,
} from '@/lib/restaurant/outbox-dispatcher';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const NOTIFICATION_WEBHOOK_EVENT_TYPE = 'restaurant.notification.webhook.v1';
export const NOTIFICATION_WEBHOOK_PAYLOAD_VERSION = '1.0';
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 16_384;

const payloadSchema = z
  .object({
    notificationId: z.string().min(1),
    version: z.literal(NOTIFICATION_WEBHOOK_PAYLOAD_VERSION),
  })
  .strict();

type Lookup = typeof dnsLookup;
type Fetch = typeof fetch;

function isLocalRuntime() {
  return process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? address;
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : null);
  if (!ipv4) return false;
  const octets = ipv4.split('.').map(Number);
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a !== undefined && a >= 224)
  );
}

/** Validate both the literal host and every current DNS result before delivery. */
export async function assertSafeWebhookUrl(
  value: string,
  lookup: Lookup = dnsLookup
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Webhook endpoint must be a valid URL.');
  }
  if (url.username || url.password)
    throw new Error('Webhook endpoint must not contain credentials.');
  if (url.protocol !== 'https:' && !(isLocalRuntime() && url.protocol === 'http:')) {
    throw new Error('Webhook endpoint must use HTTPS.');
  }
  if (url.port && url.port !== '443' && !isLocalRuntime()) {
    throw new Error('Webhook endpoint must use the standard HTTPS port.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host)) {
    throw new Error('Webhook endpoint may not target a local or private network.');
  }
  if (!isLocalRuntime() && isIP(host) === 0) {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error('Webhook endpoint may not resolve to a local or private network.');
    }
  }
  return url;
}

export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string
): boolean {
  const expected = Buffer.from(webhookSignature(secret, timestamp, body));
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function consumeBoundedBody(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      total += chunk.value.byteLength;
      if (total > WEBHOOK_MAX_RESPONSE_BYTES)
        throw new Error('Webhook response exceeded the allowed size.');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function safeFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'Webhook request timed out.';
  const message = error instanceof Error ? error.message : 'Webhook delivery failed.';
  return message.slice(0, 500);
}

export function createNotificationWebhookConsumer(
  options: { fetch?: Fetch; lookup?: Lookup } = {}
): OutboxConsumer {
  const request = options.fetch ?? fetch;
  const lookup = options.lookup ?? dnsLookup;
  return async (record: OutboxDispatchRecord, tx: ScopedDb) => {
    const payload = payloadSchema.parse(record.payload);
    if (
      record.aggregateType !== 'restaurant.notification' ||
      record.aggregateId !== payload.notificationId
    ) {
      throw new Error('Notification webhook outbox identity does not match its payload.');
    }
    const config = await tx.restaurantNotificationWebhook.findFirst();
    // Disabled or deleted endpoints are an intentional stop condition, not a retryable outage.
    if (!config?.enabled) return;

    const notification = await tx.restaurantNotification.findFirst({
      where: { id: payload.notificationId },
      select: {
        id: true,
        branchId: true,
        category: true,
        title: true,
        body: true,
        entityType: true,
        entityId: true,
        createdAt: true,
      },
    });
    if (!notification) throw new Error('Notification webhook source no longer exists.');

    const event = {
      version: NOTIFICATION_WEBHOOK_PAYLOAD_VERSION,
      id: record.id,
      type: 'restaurant.sop.notification',
      occurredAt: notification.createdAt.toISOString(),
      data: notification,
    };
    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const attempt = record.attempts + 1;
    const deliveryId = `${record.id}:attempt:${attempt}`;

    try {
      const url = await assertSafeWebhookUrl(config.endpointUrl, lookup);
      const secret = decryptSecret(config.encryptedSigningSecret);
      const response = await request(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'DevFathom-Restaurant-Webhook/1.0',
          'x-devfathom-event-id': record.id,
          'x-devfathom-idempotency-key': record.id,
          'x-devfathom-timestamp': timestamp,
          'x-devfathom-signature': webhookSignature(secret, timestamp, body),
        },
        body,
      });
      await consumeBoundedBody(response);
      if (!response.ok) throw new Error(`Webhook endpoint returned HTTP ${response.status}.`);
      await tx.restaurantNotificationDelivery.createMany({
        data: [
          {
            id: deliveryId,
            notificationId: notification.id,
            channel: 'WEBHOOK',
            status: 'DELIVERED_WEBHOOK',
            attempt,
          },
        ],
        skipDuplicates: true,
      });
      await tx.restaurantNotificationWebhook.update({
        where: { id: config.id },
        data: { lastSuccessAt: new Date(), lastFailure: null },
      });
    } catch (error) {
      const failure = safeFailure(error);
      await tx.restaurantNotificationDelivery.createMany({
        data: [
          {
            id: deliveryId,
            notificationId: notification.id,
            channel: 'WEBHOOK',
            status: 'FAILED',
            attempt,
            error: failure,
          },
        ],
        skipDuplicates: true,
      });
      await tx.restaurantNotificationWebhook.update({
        where: { id: config.id },
        data: { lastFailureAt: new Date(), lastFailure: failure },
      });
      throw new Error(failure);
    }
  };
}

export const notificationWebhookConsumer = createNotificationWebhookConsumer();

export function registerNotificationWebhookConsumer(registry: OutboxConsumerRegistry): void {
  registry.register(NOTIFICATION_WEBHOOK_EVENT_TYPE, notificationWebhookConsumer);
}

registerNotificationWebhookConsumer(restaurantOutboxConsumers);
