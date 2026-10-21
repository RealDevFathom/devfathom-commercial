import { NextResponse } from 'next/server';
import { getDemoSeatOptions } from '@/lib/demo/access';
import { isDemoEnabled } from '@/lib/demo/config';
import { isSharedHost, requestHost } from '@/lib/tenancy/host';

const PRIVATE_HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };

export async function GET(request: Request) {
  if (!isDemoEnabled() || !isSharedHost(requestHost(request))) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404, headers: PRIVATE_HEADERS });
  }
  return NextResponse.json({ seats: await getDemoSeatOptions() }, { headers: PRIVATE_HEADERS });
}
