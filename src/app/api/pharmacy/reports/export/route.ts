import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { PHARMACY_REPORT_EXPORTS } from '@/lib/pharmacy/report-csv';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';

const query = z
  .object({
    report: z.enum(PHARMACY_REPORT_EXPORTS),
    branch: z.string().min(1).max(128).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
};

/** Downloads a pharmacy Reports table as CSV. Authorization lives in the procedure. */
export async function GET(request: Request) {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return new Response('Invalid pharmacy report export filters.', { status: 400 });
  }
  try {
    const ctx = await createTRPCContext({ req: request });
    const file = await pharmacyReportsRouter.createCaller(ctx).exportCsv({
      report: parsed.data.report,
      ...(parsed.data.branch ? { branchId: parsed.data.branch } : {}),
      from: parsed.data.from,
      to: parsed.data.to,
    });
    return new Response(file.content, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Content-Type': file.contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof TRPCError && STATUS[error.code])
      return new Response(error.message, { status: STATUS[error.code] });
    // createCaller wraps unexpected failures as INTERNAL_SERVER_ERROR; never echo their message.
    console.error('Pharmacy report export failed', error);
    return new Response('Pharmacy report export failed.', {
      status: 500,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
}
