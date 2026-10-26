import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { processPlatformJobs } from '@/lib/platform/jobs';
import { processDueOwnerDigests } from '@/lib/pharmacy/owner-digest';
import { processDueResignationOffboarding } from '@/lib/resignation-offboarding';

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
  const [jobs, ownerDigests, resignationOffboarding] = await Promise.all([
    processPlatformJobs(maxJobs),
    processDueOwnerDigests(new Date(), maxJobs),
    processDueResignationOffboarding(),
  ]);
  return NextResponse.json({ ...jobs, ownerDigests, resignationOffboarding });
}

export const GET = POST;
