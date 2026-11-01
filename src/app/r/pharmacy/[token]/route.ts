import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  createReceiptOtpProofFromCode,
  hasValidReceiptOtp,
} from '@/lib/pharmacy/whatsapp/hosted-receipt';
import {
  authorizeHostedReceipt,
  authorizeHostedReceiptRecord,
} from '@/lib/pharmacy/whatsapp/hosted-receipt-store';
import { clientIp, rateLimit } from '@/lib/rate-limit';

const privateHeaders = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  Vary: 'Accept',
};
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  // Preserve the JSON API while giving browser links a customer receipt page.
  if (request.headers.get('accept')?.includes('text/html'))
    return new NextResponse(null, {
      status: 303,
      headers: { ...privateHeaders, Location: `/r/pharmacy/${encodeURIComponent(token)}/view` },
    });
  const secret = process.env.PHARMACY_HOSTED_RECEIPT_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: 'Receipt service unavailable.' },
      { status: 503, headers: privateHeaders }
    );
  try {
    const receipt = await authorizeHostedReceipt(token, secret);
    if (receipt.rx) {
      const proof = (await cookies()).get('pharmacy_receipt_otp')?.value;
      if (!hasValidReceiptOtp(token, proof, secret))
        return NextResponse.json({ otpRequired: true }, { status: 401, headers: privateHeaders });
    }
    return NextResponse.json(
      {
        branch: receipt.branch,
        receiptNumber: receipt.receiptNumber,
        total: receipt.total,
        paymentMethod: receipt.paymentMethod,
        issuedAt: receipt.issuedAt,
        expiresAt: receipt.expiresAt,
        rx: receipt.rx,
        ...(receipt.fbrInvoiceNumber ? { fbrInvoiceNumber: receipt.fbrInvoiceNumber } : {}),
        ...(receipt.fbrQrUrl ? { fbrQrUrl: receipt.fbrQrUrl } : {}),
      },
      { headers: privateHeaders }
    );
  } catch (error) {
    // Never echo internal (database/driver) error text to an anonymous caller.
    const expired = error instanceof Error && error.message === 'Receipt link has expired.';
    return NextResponse.json(
      { error: expired ? 'Receipt link has expired.' : 'Receipt link is unavailable.' },
      { status: 410, headers: privateHeaders }
    );
  }
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const secret = process.env.PHARMACY_HOSTED_RECEIPT_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: 'Receipt service unavailable.' },
      { status: 503, headers: privateHeaders }
    );
  const gate = await rateLimit(
    `pharmacy-receipt-otp:${clientIp(request)}:${token.slice(0, 24)}`,
    5,
    10 * 60_000
  );
  if (!gate.ok)
    return NextResponse.json(
      { error: 'Too many verification attempts.' },
      { status: 429, headers: { ...privateHeaders, 'Retry-After': String(gate.retryAfter) } }
    );
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  if (!body || typeof body.code !== 'string')
    return NextResponse.json(
      { error: 'A six-digit code is required.' },
      { status: 400, headers: privateHeaders }
    );
  try {
    const { id, receipt } = await authorizeHostedReceiptRecord(token, secret);
    if (!receipt.rx) return NextResponse.json({ ok: true }, { headers: privateHeaders });
    // The shared Postgres limiter reserves an attempt before checking the code.
    // All IPs and workers consume the same receipt budget, including concurrent
    // guesses. Resending a code does not reset this budget.
    const receiptGate = await rateLimit(
      `pharmacy-receipt-otp:receipt:${receipt.organizationId}:${id}`,
      5,
      10 * 60_000
    );
    if (!receiptGate.ok)
      return NextResponse.json(
        { error: 'Too many verification attempts. Try again later.' },
        {
          status: 429,
          headers: { ...privateHeaders, 'Retry-After': String(receiptGate.retryAfter) },
        }
      );
    const proof = createReceiptOtpProofFromCode(token, body.code, secret);
    const response = NextResponse.json({ ok: true }, { headers: privateHeaders });
    response.cookies.set('pharmacy_receipt_otp', proof, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: `/r/pharmacy/${token}`,
      maxAge: 15 * 60,
    });
    return response;
  } catch {
    return NextResponse.json(
      { error: 'The verification code is invalid or expired.' },
      { status: 400, headers: privateHeaders }
    );
  }
}
