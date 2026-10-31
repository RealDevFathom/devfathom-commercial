import { NextResponse } from 'next/server';
import { createReceiptOtpCode, receiptPhoneMatches } from '@/lib/pharmacy/whatsapp/hosted-receipt';
import {
  authorizeHostedReceiptRecord,
  tenantHostedReceiptRecipientOptedOut,
} from '@/lib/pharmacy/whatsapp/hosted-receipt-store';
import { sendAndLog } from '@/lib/pharmacy/whatsapp/message-log';
import { normalizeWhatsAppNumber, phoneLast4 } from '@/lib/pharmacy/whatsapp/messages';
import { createWhatsAppProvider } from '@/lib/pharmacy/whatsapp/provider';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

const privateHeaders = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
const OTP_WINDOW_MS = 5 * 60_000;
/** Same answer whether or not the number matched, so the endpoint is not a phone oracle. */
const ACCEPTED = 'If this is the number the receipt was sent to, a new code is on its way.';

/**
 * Sends a fresh verification code for an Rx receipt to the WhatsApp number the
 * link was bound to. The customer proves knowledge of that number; the code is
 * only ever delivered to it, never returned in the response.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const secret = process.env.PHARMACY_HOSTED_RECEIPT_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: 'Receipt service unavailable.' },
      { status: 503, headers: privateHeaders }
    );
  for (const [key, limit, windowMs] of [
    [`pharmacy-receipt-code:${clientIp(request)}`, 10, 60 * 60_000],
    [`pharmacy-receipt-code:${token.slice(0, 24)}`, 3, 15 * 60_000],
  ] as const) {
    const gate = await rateLimit(key, limit, windowMs);
    if (!gate.ok)
      return NextResponse.json(
        { error: 'Too many code requests. Try again later.' },
        { status: 429, headers: { ...privateHeaders, 'Retry-After': String(gate.retryAfter) } }
      );
  }
  const body = (await request.json().catch(() => null)) as { phone?: unknown } | null;
  const phone =
    body && typeof body.phone === 'string' && body.phone.length <= 32
      ? normalizeWhatsAppNumber(body.phone)
      : null;
  if (!phone)
    return NextResponse.json(
      { error: 'Enter the WhatsApp number this receipt was sent to.' },
      { status: 400, headers: privateHeaders }
    );
  let record: Awaited<ReturnType<typeof authorizeHostedReceiptRecord>>;
  try {
    record = await authorizeHostedReceiptRecord(token, secret);
  } catch {
    return NextResponse.json(
      { error: 'Receipt link is unavailable.' },
      { status: 410, headers: privateHeaders }
    );
  }
  const { id, receipt } = record;
  if (!receipt.rx)
    return NextResponse.json(
      { error: 'This receipt does not need a code.' },
      { status: 400, headers: privateHeaders }
    );
  try {
    if (
      receiptPhoneMatches(receipt, phone, secret) &&
      !(await tenantHostedReceiptRecipientOptedOut(receipt.organizationId, phone, receipt.saleId))
    ) {
      const now = new Date();
      const window = Math.floor(now.getTime() / OTP_WINDOW_MS);
      const provider = createWhatsAppProvider();
      // One code message per receipt per window; a repeat request in the same
      // window is a duplicate of a code the customer already received.
      const dedupeKey = `hosted-receipt-code:${id}:${window}`;
      const outcome = await sendAndLog(
        {
          organizationId: receipt.organizationId,
          branchId: receipt.branchId,
          kind: 'HOSTED_RECEIPT',
          dedupeKey,
          phoneLast4: phoneLast4(phone),
          orderId: receipt.saleId,
        },
        () =>
          provider.sendText({
            to: phone,
            body: `Your receipt verification code is ${createReceiptOtpCode(token, secret, now)}. It expires in 5 minutes.`,
          })
      );
      // A duplicate only confirms delivery if the earlier attempt was accepted.
      // Failed, mock, and uncertain attempts retain their claim until the next
      // code window, so repeated requests must not turn them into success.
      const sent =
        outcome === 'SENT' ||
        (outcome === 'DUPLICATE' &&
          (await withTenantDb(receipt.organizationId, (db) =>
            db.pharmacyMessageLog.findFirst({
              where: { organizationId: receipt.organizationId, dedupeKey, status: 'SENT' },
              select: { id: true },
            })
          )));
      if (!sent)
        return NextResponse.json(
          {
            error: 'Code delivery could not be confirmed. Try again in 5 minutes or contact the pharmacy.',
          },
          { status: 503, headers: { ...privateHeaders, 'Retry-After': '300' } }
        );
    }
  } catch {
    return NextResponse.json(
      { error: 'A code could not be sent. Try again later.' },
      { status: 503, headers: privateHeaders }
    );
  }
  return NextResponse.json(
    { ok: true, message: ACCEPTED },
    { status: 202, headers: privateHeaders }
  );
}
