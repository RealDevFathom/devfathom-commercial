import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@/generated/prisma/client';
import { hasModule } from '@/lib/entitlements';
import type { EntitlementView } from '@/lib/module-catalog';
import { deliverWebhookRequest } from '@/lib/webhooks/safe-url';

/**
 * ============================================================================
 * OUTBOUND WEBHOOKS / EVENTS (IMP-REST-03)
 * ============================================================================
 * Fire-and-forget event fan-out to admin-registered HTTP endpoints. The same
 * contract as logActivity / notify: emitting an event must NEVER throw, block,
 * or roll back the caller's mutation — all the real work happens off the hot
 * path and any failure is swallowed (and recorded as a WebhookDelivery row).
 *
 * Each delivery is signed so the receiver can verify authenticity:
 *   X-DevFathom-Signature: sha256=<HMAC-SHA256(rawBody, webhook.secret)>
 *
 * NOTE: this module pulls in `node:crypto`, so it is server-only. Client code
 * (e.g. the Settings UI) must NOT import from here — mirror WEBHOOK_EVENTS
 * locally instead.
 */

/** Known event names. The webhooks router validates subscriptions against this. */
export const WEBHOOK_EVENTS = ['invoice.paid', 'task.created'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Abort a hung delivery so a slow/black-hole endpoint can't pile up sockets. */
const DELIVERY_TIMEOUT_MS = 5_000;

/**
 * Fire an event to every active webhook subscribed to it. Returns immediately;
 * the network work + delivery logging run detached. Safe to call inline right
 * after a successful write.
 */
export function emitEvent(
  db: PrismaClient,
  entitlements: EntitlementView,
  event: string,
  payload: unknown
): void {
  if (!hasModule(entitlements, 'webhooks')) return;
  void dispatch(db, entitlements.organizationId, event, payload).catch((err) => {
    console.error('[webhooks] dispatch failed for', event, err);
  });
}

async function dispatch(
  db: PrismaClient,
  organizationId: string,
  event: string,
  payload: unknown
): Promise<void> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { isDemo: true },
  });
  if (organization?.isDemo) return;
  const hooks = await db.webhook.findMany({
    where: { active: true, events: { has: event } },
    select: { id: true, url: true, secret: true },
  });
  if (hooks.length === 0) return;

  const timestamp = new Date().toISOString();
  // The raw body is identical for every subscriber; only the signature differs.
  const body = JSON.stringify({ event, data: payload, timestamp });

  await Promise.all(hooks.map((hook) => deliver(db, hook, event, payload, body)));
}

async function deliver(
  db: PrismaClient,
  hook: { id: string; url: string; secret: string },
  event: string,
  payload: unknown,
  body: string
): Promise<void> {
  const signature = createHmac('sha256', hook.secret).update(body).digest('hex');
  const result = await deliverWebhookRequest(hook.url, {
    headers: {
      'Content-Type': 'application/json',
      'X-DevFathom-Event': event,
      'X-DevFathom-Signature': `sha256=${signature}`,
    },
    body,
    timeoutMs: DELIVERY_TIMEOUT_MS,
  });
  const statusCode = result.statusCode;
  const success = result.success;
  const error = result.error;

  await db.webhookDelivery
    .create({
      data: {
        webhookId: hook.id,
        event,
        payload: (payload ?? {}) as never,
        statusCode,
        success,
        error,
      },
    })
    .catch((e) => {
      console.error('[webhooks] failed to record delivery for', hook.id, e);
    });
}
