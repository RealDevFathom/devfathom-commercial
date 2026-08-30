import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

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
type ResolvedAddress = { address: string; family: number };
type Transport = (input: {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  body: string;
}) => Promise<number>;

const deniedIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  deniedIpv4.addSubnet(network, prefix, 'ipv4');
}

const deniedIpv6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  deniedIpv6.addSubnet(network, prefix, 'ipv6');
}

function isLocalRuntime() {
  return process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? address;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const family = isIP(normalized);
  if (mapped) return deniedIpv4.check(mapped, 'ipv4');
  if (family === 4) return deniedIpv4.check(normalized, 'ipv4');
  if (family !== 6) return false;
  // Only globally-routable unicast (2000::/3) is eligible, excluding IANA special ranges.
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return first < 0x2000 || first > 0x3fff || deniedIpv6.check(normalized, 'ipv6');
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

async function resolveSafeWebhookTarget(value: string, lookup: Lookup) {
  const url = await assertSafeWebhookUrl(value, lookup);
  if (isLocalRuntime()) {
    return { url, address: { address: url.hostname, family: isIP(url.hostname) || 4 } };
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Webhook endpoint may not resolve to a local or private network.');
  }
  return { url, address: addresses[0]! };
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

const pinnedHttpsTransport: Transport = ({ url, address, headers, body }) =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: 'POST',
        headers,
        servername: url.hostname,
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family as 4 | 6),
      },
      (response) => {
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > WEBHOOK_MAX_RESPONSE_BYTES) {
            request.destroy(new Error('Webhook response exceeded the allowed size.'));
          }
        });
        response.on('end', () => resolve(response.statusCode ?? 0));
      }
    );
    request.setTimeout(WEBHOOK_TIMEOUT_MS, () =>
      request.destroy(new Error('Webhook request timed out.'))
    );
    request.on('error', reject);
    request.end(body);
  });

function safeFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'Webhook request timed out.';
  const message = error instanceof Error ? error.message : 'Webhook delivery failed.';
  return message.slice(0, 500);
}

export function createNotificationWebhookConsumer(
  options: { transport?: Transport; lookup?: Lookup } = {}
): OutboxConsumer {
  const transport = options.transport ?? pinnedHttpsTransport;
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
      const { url, address } = await resolveSafeWebhookTarget(config.endpointUrl, lookup);
      const secret = decryptSecret(config.encryptedSigningSecret);
      const status = await transport({
        url,
        address,
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
      if (status < 200 || status >= 300)
        throw new Error(`Webhook endpoint returned HTTP ${status}.`);
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
