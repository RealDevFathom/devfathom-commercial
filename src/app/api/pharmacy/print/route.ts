import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { publicRequestOrigin } from '@/lib/http-origin';
import { readBoundedJson } from '@/lib/http/read-bounded-body';
import { appRouter } from '@/server/routers/_app';
import { createTRPCContext } from '@/server/trpc';

const input = z
  .object({
    branchId: z.string().trim().min(1).max(128),
    saleId: z.string().trim().min(1).max(128),
    locale: z.enum(['en', 'ur']).default('en'),
  })
  .strict();

const STATUS: Partial<Record<TRPCError['code'], number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

/**
 * PH-A7 Pharmacy receipt print bridge. Returns a validated ESC/POS `RECEIPT`
 * job (shared `PrintDocumentSchema` + bytes) for a local bridge hand-off; it
 * queues nothing and cannot confirm paper. Every POST claims the next durable
 * copy number. Called through the app router so the
 * `pharmacySales.*` path keeps session, module and branch-scope enforcement.
 */
export function GET() {
  return NextResponse.json(
    { error: 'Receipt print jobs must be requested with POST.' },
    { status: 405, headers: { ...headers, Allow: 'POST' } }
  );
}

function isSameOriginJson(request: Request): boolean {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  try {
    return (
      origin !== null &&
      new URL(origin).origin.toLowerCase() === publicRequestOrigin(request) &&
      (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none') &&
      mediaType === 'application/json'
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isSameOriginJson(request)) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403, headers });
  }
  const body = await readBoundedJson(request, 4 * 1024).catch(() => null);
  if (body?.tooLarge)
    return NextResponse.json({ error: 'Request body is too large.' }, { status: 413, headers });
  const parsed = input.safeParse(body?.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid receipt print request.' }, { status: 400, headers });
  }
  try {
    const ctx = await createTRPCContext({ req: request });
    const result = await appRouter.createCaller(ctx).pharmacySales.counterReceiptPrintJob({
      branchId: parsed.data.branchId,
      saleId: parsed.data.saleId,
      locale: parsed.data.locale,
    });
    if (result.status === 'FALLBACK') {
      // Same error contract as the Restaurant print bridge: no payload in errors.
      return NextResponse.json(
        { error: result.message, code: result.code, fallback: result.fallback, retryable: false },
        { status: 422, headers }
      );
    }
    return NextResponse.json({ mode: 'ESC_POS_JOB', ...result }, { headers });
  } catch (error) {
    if (!(error instanceof TRPCError) || error.code === 'INTERNAL_SERVER_ERROR') throw error;
    return NextResponse.json(
      { error: error.message },
      { status: STATUS[error.code] ?? 400, headers }
    );
  }
}
