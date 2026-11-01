import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

import { z } from 'zod';

import { decryptSecret } from '@/lib/secret-crypto';
import type { RestaurantJobHandler } from '@/lib/restaurant/job-handlers-core';
import {
  OutboxConsumerRegistry,
  restaurantOutboxConsumers,
  type OutboxConsumer,
  type OutboxDispatchRecord,
} from '@/lib/restaurant/outbox-dispatcher';
import { createTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { enqueue } from '@/lib/restaurant/scheduler';
import { isDemoTenant } from '@/lib/tenancy/demo-isolation';

export const NOTIFICATION_WEBHOOK_EVENT_TYPE = 'restaurant.notification.webhook.v1';
export const NOTIFICATION_WEBHOOK_JOB_TYPE = 'notification.webhook.deliver.v1';
export const NOTIFICATION_WEBHOOK_PAYLOAD_VERSION = '1.0';
export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 16_384;

export const notificationWebhookPayloadSchema = z
  .object({
    notificationId: z.string().min(1),
    version: z.literal(NOTIFICATION_WEBHOOK_PAYLOAD_VERSION),
  })
  .strict();

export const notificationWebhookJobPayloadSchema = z
  .object({
    eventId: z.string().min(1),
    notificationId: z.string().min(1).optional(),
    synthetic: z.boolean().optional(),
    attemptOffset: z.number().int().min(0).default(0),
    version: z.literal(NOTIFICATION_WEBHOOK_PAYLOAD_VERSION),
  })
  .strict()
  .refine((value) => value.synthetic === true || Boolean(value.notificationId));

type Lookup = typeof dnsLookup;
type ResolvedAddress = { address: string; family: number };
export type NotificationWebhookTransport = (input: {
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
function parseWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Webhook endpoint must be a valid URL.');
  }
  if (url.username || url.password)
    throw new Error('Webhook endpoint must not contain credentials.');
  if (url.protocol !== 'https:') {
    throw new Error('Webhook endpoint must use HTTPS.');
  }
  if (url.port && url.port !== '443' && !isLocalRuntime()) {
    throw new Error('Webhook endpoint must use the standard HTTPS port.');
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host)) {
    throw new Error('Webhook endpoint may not target a local or private network.');
  }
  return url;
}

async function resolveSafeWebhookTarget(value: string, lookup: Lookup) {
  const url = parseWebhookUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Webhook endpoint may not resolve to a local or private network.');
  }
  return { url, address: addresses[0]! };
}

export async function assertSafeWebhookUrl(
  value: string,
  lookup: Lookup = dnsLookup
): Promise<URL> {
  return (await resolveSafeWebhookTarget(value, lookup)).url;
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

export const createPinnedHttpsTransport =
  (requestImpl: typeof httpsRequest = httpsRequest): NotificationWebhookTransport =>
  ({ url, address, headers, body }) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (work: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        work();
      };
      const request = requestImpl(
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
              const error = new Error('Webhook response exceeded the allowed size.');
              response.destroy(error);
              request.destroy(error);
              finish(() => reject(error));
            }
          });
        }
      );
      const deadline = setTimeout(
        () => request.destroy(new Error('Webhook request timed out.')),
        WEBHOOK_TIMEOUT_MS
      );
      request.on('response', (response) =>
        response.on('end', () => finish(() => resolve(response.statusCode ?? 0)))
      );
      request.on('error', (error) => finish(() => reject(error)));
      request.end(body);
    });
const pinnedHttpsTransport = createPinnedHttpsTransport();

function safeFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'Webhook request timed out.';
  const message = error instanceof Error ? error.message : 'Webhook delivery failed.';
  return message.slice(0, 500);
}

export function createNotificationWebhookConsumer(): OutboxConsumer {
  return async (record: OutboxDispatchRecord, tx: ScopedDb) => {
    const payload = notificationWebhookPayloadSchema.parse(record.payload);
    if (
      record.aggregateType !== 'restaurant.notification' ||
      record.aggregateId !== payload.notificationId
    ) {
      throw new Error('Notification webhook outbox identity does not match its payload.');
    }
    if (await isDemoTenant(tx)) return;
    await enqueue(tx, {
      type: NOTIFICATION_WEBHOOK_JOB_TYPE,
      idempotencyKey: `notification-webhook:${record.id}:initial`,
      payload: {
        eventId: record.id,
        notificationId: payload.notificationId,
        attemptOffset: 0,
        version: payload.version,
      },
    });
  };
}

export function createNotificationWebhookJobHandler(
  options: {
    transport?: NotificationWebhookTransport;
    lookup?: Lookup;
    clock?: () => Date;
    failureDb?: (organizationId: string) => ScopedDb;
  } = {}
): RestaurantJobHandler {
  const transport = options.transport ?? pinnedHttpsTransport;
  const lookup = options.lookup ?? dnsLookup;
  const clock = options.clock ?? (() => new Date());
  const failureDb = options.failureDb ?? createTenantDb;
  return async ({ db: tx, job }) => {
    const payload = notificationWebhookJobPayloadSchema.parse(job.payload);
    if (await isDemoTenant(tx)) return;
    const config = await tx.restaurantNotificationWebhook.findFirst();
    // A claimed delivery must never be settled as successful unless an endpoint
    // actually accepted it. Throwing keeps disabled/deleted work on the
    // scheduler's retry/dead-letter path, where an operator can recover it after
    // configuring and enabling an endpoint again.
    if (!config?.enabled) {
      throw new Error('Webhook delivery is paused because the endpoint is disabled or missing.');
    }

    const notification = payload.synthetic
      ? {
          id: 'synthetic',
          branchId: null,
          category: 'webhook.test',
          title: 'Webhook test',
          body: 'DevFathom webhook test delivery.',
          entityType: null,
          entityId: null,
          createdAt: clock(),
        }
      : await tx.restaurantNotification.findFirst({
          where: { id: payload.notificationId! },
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
      id: payload.eventId,
      type: 'restaurant.sop.notification',
      occurredAt: notification.createdAt.toISOString(),
      data: notification,
    };
    const body = JSON.stringify(event);
    const timestamp = Math.floor(clock().getTime() / 1_000).toString();
    const attempt = payload.attemptOffset + job.attempts;
    const deliveryId = `${payload.eventId}:attempt:${attempt}`;

    try {
      const { url, address } = await resolveSafeWebhookTarget(config.endpointUrl, lookup);
      const secret = decryptSecret(config.encryptedSigningSecret);
      const status = await transport({
        url,
        address,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'DevFathom-Restaurant-Webhook/1.0',
          'x-devfathom-event-id': payload.eventId,
          'x-devfathom-idempotency-key': payload.eventId,
          'x-devfathom-timestamp': timestamp,
          'x-devfathom-signature': webhookSignature(secret, timestamp, body),
        },
        body,
      });
      if (status < 200 || status >= 300)
        throw new Error(`Webhook endpoint returned HTTP ${status}.`);
      if (!payload.synthetic)
        await tx.restaurantNotificationDelivery.createMany({
          data: [
            {
              id: deliveryId,
              notificationId: payload.notificationId!,
              channel: 'WEBHOOK',
              status: 'DELIVERED_WEBHOOK',
              attempt,
            },
          ],
          skipDuplicates: true,
        });
      await tx.restaurantNotificationWebhook.update({
        where: { id: config.id },
        data: { lastSuccessAt: clock(), lastFailure: null },
      });
    } catch (error) {
      const failure = safeFailure(error);
      const evidence = failureDb(config.organizationId);
      await evidence.$transaction(async (evidenceTx) => {
        if (!payload.synthetic)
          await evidenceTx.restaurantNotificationDelivery.createMany({
            data: [
              {
                id: deliveryId,
                notificationId: payload.notificationId!,
                channel: 'WEBHOOK',
                status: 'FAILED',
                attempt,
                error: failure,
              },
            ],
            skipDuplicates: true,
          });
        await evidenceTx.restaurantNotificationWebhook.update({
          where: { id: config.id },
          data: { lastFailureAt: clock(), lastFailure: failure },
        });
      });
      throw new Error(failure);
    }
  };
}

export const notificationWebhookConsumer = createNotificationWebhookConsumer();
export const notificationWebhookJobHandler = createNotificationWebhookJobHandler();

export function registerNotificationWebhookConsumer(registry: OutboxConsumerRegistry): void {
  if (registry.has(NOTIFICATION_WEBHOOK_EVENT_TYPE)) return;
  registry.register(NOTIFICATION_WEBHOOK_EVENT_TYPE, notificationWebhookConsumer);
}

registerNotificationWebhookConsumer(restaurantOutboxConsumers);
