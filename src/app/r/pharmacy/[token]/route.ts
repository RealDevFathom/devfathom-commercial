import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { hasValidReceiptOtp, readHostedReceipt } from '@/lib/pharmacy/whatsapp/hosted-receipt';

const privateHeaders = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'private, no-store',
};
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const secret = process.env.PHARMACY_HOSTED_RECEIPT_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: 'Receipt service unavailable.' },
      { status: 503, headers: privateHeaders }
    );
  try {
    const receipt = readHostedReceipt(token, secret);
    if (receipt.rx) {
      const proof = (await cookies()).get('pharmacy_receipt_otp')?.value;
      if (!hasValidReceiptOtp(token, proof, secret))
        return NextResponse.json({ otpRequired: true }, { status: 401, headers: privateHeaders });
    }
    return NextResponse.json(receipt, { headers: privateHeaders });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid receipt link.' },
      { status: 410, headers: privateHeaders }
    );
  }
}
