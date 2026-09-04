import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { restaurantReportsRouter } from '@/server/routers/restaurant-reports';
import { createTRPCContext } from '@/server/trpc';

const query = z
  .object({
    section: z.enum([
      'overview',
      'payments',
      'inventory',
      'wastage',
      'stock-movements',
      'purchasing',
      'workforce',
      'sop',
    ]),
    branch: z.string().min(1).max(200),
    stockLocation: z.string().min(1).max(200).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export async function GET(request: Request) {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return new Response('Invalid Restaurant report export filters.', { status: 400 });
  }
  try {
    const ctx = await createTRPCContext({ req: request });
    const file = await restaurantReportsRouter.createCaller(ctx).exportCsv({
      section: parsed.data.section,
      ...(parsed.data.branch === 'all' ? {} : { branchId: parsed.data.branch }),
      ...(parsed.data.stockLocation ? { stockLocationId: parsed.data.stockLocation } : {}),
      from: parsed.data.from,
      to: parsed.data.to,
    });
    return new Response(file.content, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Content-Type': file.contentType,
        'X-Content-Type-Options': 'nosniff',
        'X-Report-Truncated': String(file.truncated),
      },
    });
  } catch (error) {
    if (error instanceof TRPCError) {
      const status = error.code === 'UNAUTHORIZED' ? 401 : error.code === 'FORBIDDEN' ? 403 : 400;
      return new Response(error.message, { status });
    }
    return new Response('Restaurant report export failed.', { status: 500 });
  }
}
