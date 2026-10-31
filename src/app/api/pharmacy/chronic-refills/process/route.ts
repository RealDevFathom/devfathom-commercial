import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { processDueChronicRefills } from '@/lib/pharmacy/chronic-refills';

/** Scheduler endpoint for recurring non-Rx packs. Rx cycles remain pharmacist-approved. */
export const maxDuration = 300;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get('authorization');
  if (!secret || !authorization || !safeEqual(authorization, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const input = (await request.json().catch(() => ({}))) as { limit?: unknown };
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 100;
  return NextResponse.json(await processDueChronicRefills({ limit }));
}

// Vercel Cron invokes scheduled paths with GET and the same bearer secret.
export const GET = POST;
