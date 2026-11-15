import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  sendHostedReceiptOtp,
  verifyHostedReceiptOtp,
} from '@/lib/pharmacy/hosted-receipt-service';
import { HOSTED_RECEIPT_TOKEN_PATTERN } from '@/lib/pharmacy/hosted-receipt';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import {
  isTenantLifecycleAccessible,
  requestHost,
  resolveOrganizationForRequest,
} from '@/lib/tenancy/host';

const TEN_MINUTES = 10 * 60_000;
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
};

const token = z.string().regex(HOSTED_RECEIPT_TOKEN_PATTERN);
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), token }).strict(),
  z.object({ action: z.literal('verify'), token, otp: z.string().regex(/^\d{6}$/) }).strict(),
]);

const INVALID = {
  ok: false,
  message: 'This request could not be completed. Ask the pharmacy to send your receipt again.',
} as const;

function reply(body: object, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...headers, ...extra } });
}

const fingerprint = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

/**
 * DEV-16: one-time code that unlocks a hosted receipt's items. The tenant comes
 * from the host, the phone from the customer record; the caller supplies only
 * the link token and the code. Failures are deliberately indistinguishable.
 */
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  try {
    if (origin && new URL(origin).host.toLowerCase() !== requestHost(request))
      return reply(INVALID, 403);
  } catch {
    return reply(INVALID, 403);
  }
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return reply(INVALID, 400);
  const organization = await resolveOrganizationForRequest(request);
  if (
    !organization ||
    organization.vertical !== 'PHARMACY' ||
    !isTenantLifecycleAccessible(organization.status)
  )
    return reply(INVALID, 400);

  const gates = [
    await rateLimit(`hosted-receipt:ip:${clientIp(request)}`, 30, TEN_MINUTES),
    await rateLimit(`hosted-receipt:token:${fingerprint(parsed.data.token)}`, 20, TEN_MINUTES),
  ];
  const blocked = gates.find((gate) => !gate.ok);
  if (blocked)
    return reply({ ok: false, message: 'Please wait before trying again.' }, 429, {
      'Retry-After': String(Math.max(1, blocked.retryAfter)),
    });

  if (parsed.data.action === 'send') {
    const result = await sendHostedReceiptOtp({
      organizationId: organization.id,
      token: parsed.data.token,
    });
    if (result === 'WAIT')
      return reply({ ok: false, message: 'A code was just sent. Please wait a minute.' }, 429, {
        'Retry-After': '60',
      });
    return result === 'SENT'
      ? reply({ ok: true, message: 'We sent a code to the WhatsApp number on file.' })
      : reply(INVALID, 400);
  }

  const receipt = await verifyHostedReceiptOtp({
    organizationId: organization.id,
    token: parsed.data.token,
    otp: parsed.data.otp,
  });
  return receipt
    ? reply({ ok: true, message: 'Code accepted.', receipt })
    : reply({ ok: false, message: 'That code is not valid. Check it or request a new one.' }, 400);
}
