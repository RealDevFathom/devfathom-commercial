import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';
import { runNightlyCustomerMetrics } from '@/lib/growth/nightly-customer-metrics';

export const maxDuration = 300;
const PRIVATE_HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };

function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  const supplied = request.headers.get('authorization');
  if (!expected || !supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(`Bearer ${expected}`);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Invoke once nightly. Collection is tenant-scoped and never sends campaigns. */
export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json(
      { error: 'Unauthorized.' },
      { status: 401, headers: PRIVATE_HEADERS }
    );
  }
  return NextResponse.json(await runNightlyCustomerMetrics(), { headers: PRIVATE_HEADERS });
}
