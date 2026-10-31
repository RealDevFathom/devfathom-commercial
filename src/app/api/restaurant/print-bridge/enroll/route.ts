import { NextResponse } from 'next/server';
import { z } from 'zod';
import { exchangePrintBridgeEnrollmentCode } from '@/lib/restaurant/print-bridge-enrollment';
const bodySchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^pbe_[A-Za-z0-9_-]{32}$/),
  })
  .strict();
const headers = { 'Cache-Control': 'no-store' };
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Invalid enrollment code.' }, { status: 400, headers });
  try {
    const result = await exchangePrintBridgeEnrollmentCode(parsed.data.code);
    if (!result)
      return NextResponse.json(
        { error: 'Enrollment code is invalid, expired, or already used.' },
        { status: 410, headers }
      );
    return NextResponse.json(result, { headers });
  } catch {
    // A response can be lost after commit. Never retry the exchange automatically.
    return NextResponse.json(
      { error: 'Enrollment could not be confirmed. Contact your administrator before retrying.' },
      { status: 500, headers }
    );
  }
}
