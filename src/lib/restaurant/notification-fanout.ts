import 'server-only';

import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';
import {
  restaurantOutboxConsumers,
  type OutboxConsumer,
  type OutboxConsumerRegistry,
} from '@/lib/restaurant/outbox-dispatcher';
import {
  NotificationRequestSchema,
  fanOutNotification,
  type NotificationRequest,
} from '@/lib/restaurant/notifications';
import { createTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M7-L5 / D21 — the fan-out drivers: the two durable seams that turn a queued
 * notification request into an in-app row + per-channel deliveries via
 * {@link fanOutNotification}. Both are idempotent (at-least-once safe) and do only
 * DB work; neither talks to a real provider (external channels are STUBBED).
 *
 *   1. Scheduler job (`notification.fanOut`) — registered in `job-handlers.ts`.
 *      The worker hands the handler a tenant-scoped `db` bound to the job's org,
 *      so the payload is the bare {@link NotificationRequest}.
 *
 *   2. Outbox consumer (`restaurant.notification.requested`) — registered into
 *      `restaurantOutboxConsumers`. A producing lane appends an outbox row IN THE
 *      SAME transaction as its state change (via {@link appendNotificationRequest})
 *      so the notification is exactly as durable as the change that triggered it.
 *      The dispatcher hands the consumer only the record (no db/org), so the
 *      outbox payload carries `organizationId` and the consumer binds its own
 *      tenant client — its writes land in a separate transaction from the row
 *      settle, which is why the fan-out's idempotency guard is load-bearing here.
 */

/** Run `work` inside one tenant transaction (same retype the scheduler/outbox use). */
function runInTenantTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

// ---------------------------------------------------------------------------
// 1. Scheduler job handler.
// ---------------------------------------------------------------------------

/** The `RestaurantJob.type` an enqueuer sets to request a fan-out. */
export const NOTIFICATION_FANOUT_JOB = 'notification.fanOut';

/**
 * Scheduler handler: validate the job payload as a notification request and fan it
 * out inside the job's tenant scope. Idempotent — a retried job re-runs the same
 * request and the fan-out's guard prevents a duplicate notification.
 */
export async function notificationFanoutHandler({ db, job }: RestaurantJobContext): Promise<void> {
  const request = NotificationRequestSchema.parse(job.payload);
  await runInTenantTransaction(db, (tx) => fanOutNotification(tx, request));
}

// ---------------------------------------------------------------------------
// 2. Outbox consumer.
// ---------------------------------------------------------------------------

/** The outbox `eventType` a producing lane advertises for a notification request. */
export const NOTIFICATION_REQUESTED_EVENT = 'restaurant.notification.requested';

/** The aggregate kind for a notification-request outbox row. */
export const NOTIFICATION_AGGREGATE_TYPE = 'restaurant.notification';

/**
 * The outbox payload for a notification request. `organizationId` is transport
 * metadata (NOT a row column): the dispatcher hands the consumer only the record,
 * so the consumer needs the org to bind a tenant client. `request` is the bare
 * notification-request contract.
 */
export const NotificationOutboxPayloadSchema = z
  .object({
    organizationId: z.string().min(1),
    request: NotificationRequestSchema,
  })
  .strict();

export type NotificationOutboxPayload = z.infer<typeof NotificationOutboxPayloadSchema>;

/**
 * Build an outbox consumer that fans a notification request out. The tenant-client
 * factory is injectable so unit tests drive it without a DB (defaults to
 * `createTenantDb`, which sets the org's RLS context per operation).
 */
export function createNotificationOutboxConsumer(
  resolveTenantDb: (organizationId: string) => ScopedDb = createTenantDb
): OutboxConsumer {
  return async (record) => {
    const { organizationId, request } = NotificationOutboxPayloadSchema.parse(record.payload);
    const db = resolveTenantDb(organizationId);
    await runInTenantTransaction(db, (tx) => fanOutNotification(tx, request));
  };
}

/** The process-wide consumer (bound to the default tenant-client factory). */
export const notificationRequestedConsumer: OutboxConsumer = createNotificationOutboxConsumer();

/**
 * Register the notification outbox consumer into a registry (defaults to the
 * process-wide one the worker drives). Idempotent — safe to call from more than
 * one import path (e.g. the worker's `job-handlers` bootstrap and a test) without
 * tripping the registry's duplicate-registration guard.
 */
export function registerNotificationOutboxConsumer(
  registry: OutboxConsumerRegistry = restaurantOutboxConsumers,
  consumer: OutboxConsumer = notificationRequestedConsumer
): void {
  if (registry.has(NOTIFICATION_REQUESTED_EVENT)) return;
  registry.register(NOTIFICATION_REQUESTED_EVENT, consumer);
}

// ---------------------------------------------------------------------------
// Producer helper (transactional enqueue via the outbox).
// ---------------------------------------------------------------------------

/** The minimal client the producer helper needs: the outbox delegate. */
export type NotificationOutboxProducerClient = Pick<
  Prisma.TransactionClient,
  'restaurantEventOutbox'
>;

/**
 * Append ONE notification-request outbox row inside the caller's transaction, so
 * the request commits atomically with the state change that triggered it. The
 * dispatcher delivers it to {@link notificationRequestedConsumer} on a later pass.
 * `aggregateId` defaults to a deterministic key derived from the request so
 * diagnostics can group a request's rows; it is not a uniqueness constraint.
 */
export async function appendNotificationRequest(
  tx: NotificationOutboxProducerClient,
  input: { organizationId: string; request: NotificationRequest; aggregateId?: string }
): Promise<{ outboxId: string }> {
  const request = NotificationRequestSchema.parse(input.request);
  const aggregateId =
    input.aggregateId ??
    [request.recipientStaffProfileId, request.category, request.entityType ?? '', request.entityId ?? '']
      .join(':');
  const payload: NotificationOutboxPayload = { organizationId: input.organizationId, request };
  const row = await tx.restaurantEventOutbox.create({
    data: {
      eventType: NOTIFICATION_REQUESTED_EVENT,
      aggregateType: NOTIFICATION_AGGREGATE_TYPE,
      aggregateId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { outboxId: row.id };
}
