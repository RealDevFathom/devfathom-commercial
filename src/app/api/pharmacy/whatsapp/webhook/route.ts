import { z } from 'zod';
import { recordMarketingCallback } from '@/lib/pharmacy/marketing-delivery';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { handleInboundWhatsAppMessage } from '@/lib/pharmacy/whatsapp/inbound';
import { findWhatsAppConnectionByPhoneNumberId } from '@/lib/pharmacy/whatsapp/connection';
import { createWhatsAppProvider, readWhatsAppConfig } from '@/lib/pharmacy/whatsapp/provider';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';

/**
 * PH-B3 — Meta WhatsApp Cloud API webhook for pharmacy order intake.
 *
 * GET answers Meta's subscription handshake with the configured verify token.
 * POST is unauthenticated, so it verifies `X-Hub-Signature-256` over the raw
 * body BEFORE parsing (fail closed when no app secret is configured), resolves
 * the tenant from the globally unique phone_number_id, and handles each text
 * message idempotently by provider message id. See docs/pharmacy/whatsapp.md.
 */

const PRIVATE_HEADERS = { 'cache-control': 'no-store' };
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

  const sharedConfig = readWhatsAppConfig();
  const verifier = createWhatsAppProvider(sharedConfig);
  const rawBody = await request.text();
  if (!verifier.verifyWebhook(rawBody, request.headers.get('x-hub-signature-256'))) {
    return json({ error: 'Invalid signature.' }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  // A webhook delivery belongs to one sender. Refuse missing or mixed sender
  // metadata rather than allowing one tenant's payload to cross a DB scope.
  const senderIds = new Set<string>();
  const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  for (const entry of Array.isArray(root?.entry) ? root.entry : []) {
    const changes =
      entry && typeof entry === 'object' && Array.isArray((entry as Record<string, unknown>).changes)
        ? ((entry as Record<string, unknown>).changes as unknown[])
        : [];
    for (const change of changes) {
      const value =
        change && typeof change === 'object'
          ? (change as Record<string, unknown>).value
          : null;
      const metadata =
        value && typeof value === 'object' ? (value as Record<string, unknown>).metadata : null;
      const sender =
        metadata && typeof metadata === 'object'
          ? (metadata as Record<string, unknown>).phone_number_id
          : null;
      if (typeof sender === 'string') senderIds.add(sender);
    }
  }
  if (senderIds.size !== 1) return json({ error: 'Unknown sender.' }, 404);
  const senderId = [...senderIds][0]!;
  const connection = await findWhatsAppConnectionByPhoneNumberId(senderId);
  if (!connection) return json({ error: 'Unknown sender.' }, 404);
  const { config } = connection;
  const provider = createWhatsAppProvider(config);
  const organization = await withTenantDb(connection.organizationId, (db) =>
    db.organization.findUnique({
      where: { id: connection.organizationId },
      select: { id: true, isDemo: true, vertical: true, status: true },
    })
  );
  if (
    !organization ||
    organization.isDemo ||
    organization.vertical !== 'PHARMACY' ||
    !isTenantLifecycleAccessible(organization.status)
  )
    return json({ error: 'Unknown tenant.' }, 404);

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
  const messages = provider
    .parseInbound(payload)
    .filter(
      (message) => Boolean(message.phoneNumberId) && message.phoneNumberId === config.phoneNumberId
    );
  const outcomes = [];
  for (const message of messages) {
    outcomes.push(await handleInboundWhatsAppMessage(organization.id, provider, message));
  }
  // Meta retries non-2xx responses; handled and ignored messages both return 200.
  return json({ received: messages.length, outcomes });
}
