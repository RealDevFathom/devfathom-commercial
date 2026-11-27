import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { drainBusinessWallets } from '@/lib/wallet/drain';
import { drainDueOrganizations } from '@/lib/side-effects/drain';

export const maxDuration = 300;

const PRIVATE_HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Drain every organization's due outbox. Schedule: every minute. See docs/admin-platform/operations.md. */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get('authorization');
  if (!secret || !authorization || !safeEqual(authorization, `Bearer ${secret}`)) {
    return json({ error: 'Unauthorized.' }, 401);
  }

  const [summary] = await Promise.all([drainDueOrganizations(), drainBusinessWallets()]);
  return json(summary);
}
