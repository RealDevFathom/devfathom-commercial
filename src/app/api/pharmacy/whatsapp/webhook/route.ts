import { readBoundedBody } from '@/lib/http/read-bounded-body';
import { z } from 'zod';
import { recordMarketingCallback } from '@/lib/pharmacy/marketing-delivery';
import { evaluateMarketingBlockRate } from '@/lib/pharmacy/marketing-send-policy';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { parseAccountChanges, recordAccountChanges } from '@/lib/pharmacy/whatsapp/account-quality';
import { handleInboundWhatsAppMessage } from '@/lib/pharmacy/whatsapp/inbound';
import { createWhatsAppProvider, readWhatsAppConfig } from '@/lib/pharmacy/whatsapp/provider';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import {
  isTenantLifecycleAccessible,
  requestHost,
  resolveExplicitOrganizationByHost,
} from '@/lib/tenancy/host';

/**
 * PH-B3 — Meta WhatsApp Cloud API webhook for pharmacy order intake.
 *
 * GET answers Meta's subscription handshake with the configured verify token.
 * POST is unauthenticated, so it verifies `X-Hub-Signature-256` over the raw
 * body BEFORE parsing (fail closed when no app secret is configured), resolves
 * the tenant strictly from an explicit pharmacy host, and handles each text
 * message idempotently by provider message id. See docs/pharmacy/whatsapp.md.
 */

const PRIVATE_HEADERS = { 'cache-control': 'no-store' };
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const IP_LIMIT = 120;
const IP_WINDOW_MS = 60_000;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const verifyToken = readWhatsAppConfig().verifyToken;
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  if (
    params.get('hub.mode') !== 'subscribe' ||
    !verifyToken ||
    !token ||
    !challenge ||
    !safeEqual(token, verifyToken)
  ) {
    return json({ error: 'Forbidden.' }, 403);
  }
  return new Response(challenge, {
    status: 200,
    headers: { ...PRIVATE_HEADERS, 'content-type': 'text/plain' },
  });
}

export async function POST(request: Request) {
  const gate = await rateLimit(`pharmacy-whatsapp:ip:${clientIp(request)}`, IP_LIMIT, IP_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { ...PRIVATE_HEADERS, 'Retry-After': String(gate.retryAfter) } }
    );
  }

  const config = readWhatsAppConfig();
  const rawBody = await readBoundedBody(
    request,
    config.provider === 'waha' ? 256 * 1024 : MAX_BODY_BYTES
  );
  if (rawBody === null) return json({ error: 'Body too large.' }, 413);
  if (config.provider === 'waha') {
    const { receiveWahaEvent } = await import('@/lib/pharmacy/whatsapp/waha-webhook');
    const status = await receiveWahaEvent(
      rawBody,
      request.headers,
      new URL(request.url).searchParams.get('endpoint') ?? '',
      config
    );
    return json(status === 200 ? { received: true } : { error: 'Webhook rejected.' }, status);
  }
  const provider = createWhatsAppProvider(config);
  if (!provider.verifyWebhook(rawBody, request.headers.get('x-hub-signature-256'))) {
    return json({ error: 'Invalid signature.' }, 401);
  }

  const organization = await resolveExplicitOrganizationByHost(requestHost(request));
  if (
    !organization ||
    organization.isDemo ||
    organization.vertical !== 'PHARMACY' ||
    !isTenantLifecycleAccessible(organization.status)
  ) {
    return json({ error: 'Unknown tenant.' }, 404);
  }
  // A shared app secret does not establish sender ownership for the host tenant.
  if (!config.phoneNumberId || config.organizationId !== organization.id) {
    return json({ error: 'Sender is not bound to this tenant.' }, 403);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const callbackPayload = z
    .object({
      entry: z
        .array(
          z.object({
            changes: z
              .array(
                z.object({
                  value: z.object({
                    metadata: z.object({ phone_number_id: z.string() }).optional(),
                    statuses: z
                      .array(
                        z.object({
                          id: z.string().min(1).max(256),
                          status: z.string(),
                          timestamp: z.string().regex(/^\d+$/),
                        })
                      )
                      .max(500)
                      .optional(),
                  }),
                })
              )
              .max(500),
          })
        )
        .max(500),
    })
    .safeParse(payload);
  if (callbackPayload.success)
    for (const entry of callbackPayload.data.entry)
      for (const change of entry.changes) {
        const value = change.value;
        if (value.metadata?.phone_number_id !== config.phoneNumberId) continue;
        for (const status of value.statuses ?? []) {
          const state =
            status.status === 'delivered' || status.status === 'read'
              ? 'DELIVERED'
              : status.status === 'failed'
                ? 'FAILED'
                : status.status === 'sent'
                  ? 'PROVIDER_ACCEPTED'
                  : null;
          const occurredAt = new Date(Number(status.timestamp) * 1000);
          if (!state || !Number.isFinite(occurredAt.getTime())) continue;
          await withTenantDb(organization.id, (db) =>
            recordMarketingCallback(db, organization.id, config.phoneNumberId!, {
              senderId: value.metadata!.phone_number_id,
              messageId: status.id,
              state,
              occurredAt,
            })
          );
        }
      }
  // DEV-22: account strikes, restrictions and quality flags for the bound account only.
  const accountChanges = parseAccountChanges(payload, config.businessAccountId);
  if (accountChanges.length)
    await withTenantDb(organization.id, (db) =>
      recordAccountChanges(db, organization.id, accountChanges)
    );
  const messages = provider
    .parseInbound(payload)
    .filter(
      (message) => Boolean(message.phoneNumberId) && message.phoneNumberId === config.phoneNumberId
    );
  const outcomes = [];
  for (const message of messages) {
    outcomes.push(await handleInboundWhatsAppMessage(organization.id, provider, message));
  }
  // A STOP is a block signal. Re-check after any handled sender batch, replays
  // included, so a retried request completes a check an earlier attempt missed.
  // The check is idempotent and returns early once sending is paused.
  if (outcomes.length)
    await withTenantDb(organization.id, (db) => evaluateMarketingBlockRate(db, organization.id));
  // Meta retries non-2xx responses; handled and ignored messages both return 200.
  return json({ received: messages.length, outcomes });
}
