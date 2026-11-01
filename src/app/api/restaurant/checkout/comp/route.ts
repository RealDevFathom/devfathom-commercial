import { NextResponse } from 'next/server';

/**
 * POST /api/restaurant/checkout/comp
 *
 * Complimentary items are outside the MVP scope. Keep the endpoint as an explicit,
 * side-effect-free denial so stale clients and direct callers cannot reach the retained
 * comp domain logic. Historical comp amounts remain available to read in receipts and
 * reports.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Complimentary items are not available in this version.' },
    { status: 403 }
  );
}
