import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { appRouter } from '@/server/routers/_app';
import { createTRPCContext } from '@/server/trpc';

const query = z
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
 * cannot confirm paper. The router durably assigns the original/reprint marker.
 * Called through the app router so the
 * `pharmacySales.*` path keeps session, module and branch-scope enforcement.
 */
export async function GET(request: Request) {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
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
