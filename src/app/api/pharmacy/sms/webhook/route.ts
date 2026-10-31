import { NextResponse } from 'next/server';

import { handleInboundSms } from '@/lib/pharmacy/sms/inbound';
import { createSmsProvider, readSmsConfig } from '@/lib/pharmacy/sms/provider';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import {
  isTenantLifecycleAccessible,
  requestHost,
  resolveExplicitOrganizationByHost,
} from '@/lib/tenancy/host';

/**
 * #723 — inbound SMS webhook (STOP / START only). POST is unauthenticated, so
 * it verifies the `X-SMS-Signature: sha256=<hex>` HMAC over the raw body BEFORE
 * parsing (fail closed when no secret is configured), resolves the tenant
 * strictly from an explicit pharmacy host, requires the configured SMS sender
 * to be bound to that tenant, and handles each message idempotently by
 * gateway message id. See docs/pharmacy/sms.md.
 */

const PRIVATE_HEADERS = { 'cache-control': 'no-store' };
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
  const rawBody = await request.text();
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
  // A shared webhook secret does not establish sender ownership for the host tenant.
  if (!config.organizationId || config.organizationId !== organization.id) {
    return json({ error: 'Sender is not bound to this tenant.' }, 403);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const messages = provider.parseInbound(payload);
  const outcomes = [];
  for (const message of messages) {
    outcomes.push(await handleInboundSms(organization.id, config, provider, message));
  }
  // Gateways retry non-2xx responses; handled and ignored messages both return 200.
  return json({ received: messages.length, outcomes });
}
