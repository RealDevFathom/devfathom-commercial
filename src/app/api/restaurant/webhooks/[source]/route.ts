import { readBoundedBody } from '@/lib/http/read-bounded-body';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import {
  recordInboundWebhook,
  WebhookAdmissionError,
  webhookEnvelopeSchema,
  verifyWebhookProvider,
} from '@/lib/restaurant/webhook-inbox';
import { terminalEventSchema } from '@/lib/restaurant/terminal-payments';
import { freshTerminalTimestamp } from '@/lib/restaurant/terminal-webhook-keys';
import { requestHost, resolveExplicitOrganizationByHost } from '@/lib/tenancy/host';
import { createTenantDb } from '@/lib/tenancy/scoped-db';

/**
 * POST /api/restaurant/webhooks/[source]
 *
 * M7-L2 / D21 — the inbound-webhook receiver seam. An external provider (`[source]`)
 * POSTs a strict envelope; the receiver resolves the tenant STRICTLY from the
 * request host (an explicit tenant host, never the default organization), records
 * the envelope in that org's `restaurant_webhook_inbox` (deduplicated by the
 * `(organization, source, externalEventId)` unique constraint), records signature
 * verification status, and enqueues a `webhook.process` job for the scheduler to
 * drain inside the tenant's RLS context. No provider event is processed on the
 * request path. A repeat of the same event id returns 200 and enqueues nothing.
 *
 * This is an UNAUTHENTICATED public endpoint (a webhook source carries no session),
 * so it is IP rate-limited and never trusts a client-supplied organization — the
 * host is the only tenant signal, and an unknown host is a flat 404 (no tenant
 * enumeration). All accepted sources require `x-webhook-timestamp` and an HMAC over
 * the timestamp, source, configuration id and raw body (legacy format during
 * changeover), and are rejected outside ±5
 * minutes. Only providers configured for webhooks on this tenant are admitted.
 */

/** A provider slug: lowercase-ish, no path traversal. */
const SOURCE = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

const SIGNATURE_HEADER = 'x-webhook-signature';
const TIMESTAMP_HEADER = 'x-webhook-timestamp';
const IP_LIMIT = 120;
const IP_WINDOW_MS = 60_000;

export async function POST(
  request: Request,
  context: { params: Promise<{ source: string }> }
): Promise<Response> {
  const ip = clientIp(request);
  const gate = await rateLimit(`restaurant-webhook:ip:${ip}`, IP_LIMIT, IP_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } }
    );
  }

  const { source: rawSource } = await context.params;
  const source = SOURCE.safeParse(rawSource);
  if (!source.success) {
    return NextResponse.json({ error: 'Unknown webhook source.' }, { status: 404 });
  }

  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (
    !freshTerminalTimestamp(timestamp) ||
    !signature ||
    !/^(?:sha256=)?[a-f0-9]{64}$/i.test(signature)
  ) {
    return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 401 });
  }

  // Tenant resolution: explicit host only — never the DEFAULT_ORGANIZATION_ID
  // fallback, and never a client-supplied org. An unknown host is indistinguishable
  // from an absent one: a flat 404.
  const organization = await resolveExplicitOrganizationByHost(requestHost(request));
  if (!organization || organization.isDemo) {
    return NextResponse.json({ error: 'Unknown tenant.' }, { status: 404 });
  }

  let rawBody;
  try {
    rawBody = await readBoundedBody(request, 256 * 1024);
  } catch {
    return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 401 });
  }
  if (rawBody === null) return NextResponse.json({ error: 'Body too large.' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
  } catch {
    // An explicit config header can authenticate even malformed JSON.
    body = undefined;
  }
  const selector = z
    .object({ eventType: z.string(), payload: z.object({ terminalId: z.string() }) })
    .safeParse(body);
  const providerSignature = {
    rawBody,
    timestamp,
    signature,
    configId: request.headers.get('x-webhook-config-id'),
    terminalId:
      selector.success && selector.data.eventType.startsWith('terminal.')
        ? selector.data.payload.terminalId
        : null,
  };
  const db = createTenantDb(organization.id);
  try {
    await verifyWebhookProvider(db, source.data, providerSignature);
  } catch (error) {
    if (error instanceof WebhookAdmissionError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  if (body === undefined)
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });

  const parsed = webhookEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid webhook envelope.', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const terminalEvent = parsed.data.eventType?.startsWith('terminal.')
    ? terminalEventSchema.safeParse(parsed.data.payload)
    : null;
  if (terminalEvent && !terminalEvent.success) {
    return NextResponse.json({ error: 'Invalid terminal event.' }, { status: 400 });
  }
  let result;
  try {
    result = await recordInboundWebhook(db, {
      source: source.data,
      externalEventId: parsed.data.externalEventId,
      eventType: parsed.data.eventType ?? null,
      payload: parsed.data.payload as unknown as Prisma.InputJsonValue,
      verificationStatus: 'VERIFIED',
      providerSignature,
    });
  } catch (error) {
    if (error instanceof WebhookAdmissionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  // 202 for a freshly-accepted envelope (enqueued for processing); 200 for a
  // duplicate that was already received (idempotent, nothing enqueued).
  return NextResponse.json(
    {
      inboxId: result.inbox.id,
      source: result.inbox.source,
      externalEventId: result.inbox.externalEventId,
      status: result.inbox.status,
      verificationStatus: result.inbox.verificationStatus,
      deduplicated: result.deduplicated,
      jobId: result.enqueuedJobId,
    },
    { status: result.deduplicated ? 200 : 202 }
  );
}
