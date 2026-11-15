import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { processPlatformJobs } from '@/lib/platform/jobs';
import { processDueChurnScoring } from '@/lib/pharmacy/churn-scoring';
import { processDueOwnerDigests } from '@/lib/pharmacy/owner-digest';
import { processDuePharmacyLoyaltyExpiries } from '@/lib/pharmacy/loyalty-expiry';

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
  const input = (await request.json().catch(() => ({}))) as { maxJobs?: unknown };
  const maxJobs =
    typeof input.maxJobs === 'number' && Number.isFinite(input.maxJobs) ? input.maxJobs : 25;
  const [jobs, ownerDigests, churnScoring, loyaltyExpiry] = await Promise.all([
    processPlatformJobs(maxJobs),
    processDueOwnerDigests(new Date(), maxJobs),
    processDueChurnScoring(new Date(), maxJobs),
    // DEV-764: pharmacy points expire as the owner's program says, one ledger entry per lot.
    processDuePharmacyLoyaltyExpiries(new Date(), maxJobs),
  ]);
  return NextResponse.json({ ...jobs, ownerDigests, churnScoring, loyaltyExpiry });
}

export const GET = POST;
