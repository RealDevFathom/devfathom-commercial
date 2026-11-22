import { readBoundedBody } from '@/lib/http/read-bounded-body';
import { NextResponse } from 'next/server';

import { handleInboundSmsMessage } from '@/lib/pharmacy/sms/inbound';
import { createSmsProvider, readSmsConfig } from '@/lib/pharmacy/sms/provider';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import {
  isTenantLifecycleAccessible,
  requestHost,
  resolveExplicitOrganizationByHost,
} from '@/lib/tenancy/host';

/**
 * DEV-87 — inbound SMS gateway callback so STOP / START work on SMS too.
 *
 * Unauthenticated, so the `X-Sms-Signature` HMAC over the raw body is verified
 * BEFORE parsing (fail closed when no secret is configured), the tenant comes
 * strictly from an explicit pharmacy host, and the sender must be bound to that
 * tenant. Each message is handled idempotently by gateway message id.
 */

const PRIVATE_HEADERS = { 'cache-control': 'no-store' };
const MAX_BODY_BYTES = 256 * 1024;
const IP_LIMIT = 120;
const IP_WINDOW_MS = 60_000;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

export async function POST(request: Request) {
  const gate = await rateLimit(`pharmacy-sms:ip:${clientIp(request)}`, IP_LIMIT, IP_WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { ...PRIVATE_HEADERS, 'Retry-After': String(gate.retryAfter) } }
    );
  }

  const config = readSmsConfig();
  const provider = createSmsProvider(config);
  const rawBody = await readBoundedBody(request, MAX_BODY_BYTES);
  if (rawBody === null) return json({ error: 'Body too large.' }, 413);
  if (!provider.verifyWebhook(rawBody, request.headers.get('x-sms-signature'))) {
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
  if (config.organizationId !== organization.id) {
    return json({ error: 'Sender is not bound to this tenant.' }, 403);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const messages = provider.parseInbound(payload);
  const outcomes = [];
  for (const message of messages) {
    outcomes.push(await handleInboundSmsMessage(organization.id, provider, message));
  }
  return json({ received: messages.length, outcomes });
}
