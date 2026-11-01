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
    if (error instanceof TRPCError) {
      const status = error.code === 'UNAUTHORIZED' ? 401 : error.code === 'FORBIDDEN' ? 403 : 400;
      return new Response(error.message, { status });
    }
    return new Response('Pharmacy report export failed.', { status: 500 });
  }
}
