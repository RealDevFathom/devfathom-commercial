import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getDemoSeatCount, isDemoEnabled } from '@/lib/demo/config';
import { processDueDemoResetJobs } from '@/lib/demo/jobs';

export const maxDuration = 1_800;

const PRIVATE_HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function POST(request: Request) {
  if (!isDemoEnabled()) return json({ error: 'Not found.' }, 404);

  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get('authorization');
  if (!secret || !authorization || !safeEqual(authorization, `Bearer ${secret}`)) {
    return json({ error: 'Unauthorized.' }, 401);
  }

  const raw = await request.text();
  let input: unknown = {};
  try {
    if (raw) input = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  const parsed = z
    .object({ maxJobs: z.number().int().min(1).max(getDemoSeatCount()).optional() })
    .strict()
    .safeParse(input);
  if (!parsed.success) return json({ error: 'Invalid request.' }, 400);

  return json(
    await processDueDemoResetJobs({
      maxJobs: parsed.data.maxJobs ?? 1,
    })
  );
}
