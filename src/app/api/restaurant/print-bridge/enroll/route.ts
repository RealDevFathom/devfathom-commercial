import { NextResponse } from 'next/server';
import { z } from 'zod';

import { exchangePrintBridgeEnrollmentCode } from '@/lib/restaurant/print-bridge-enrollment';

const bodySchema = z.object({ code: z.string().trim().min(1).max(128) }).strict();

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Invalid enrollment code.' }, { status: 400 });
  const result = await exchangePrintBridgeEnrollmentCode(parsed.data.code);
  if (!result)
    return NextResponse.json(
      { error: 'Enrollment code is invalid, expired, or already used.' },
      { status: 410 }
    );
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
