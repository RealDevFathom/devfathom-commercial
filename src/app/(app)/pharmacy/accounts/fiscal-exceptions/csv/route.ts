import { TRPCError } from '@trpc/server';
import { fiscalExceptionsCsv } from '@/lib/pharmacy/accounts/fiscal-exceptions';
import { loadFiscalExceptionRegister } from '../access';
import { fiscalExceptionQuery } from '../query';

const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query: Record<string, string | string[]> = Object.create(null);
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  try {
    const register = await loadFiscalExceptionRegister(fiscalExceptionQuery(query), request);
    return new Response(fiscalExceptionsCsv(register), {
      headers: {
        ...headers, 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="fiscal-exception-evidence-page.csv"',
      },
    });
  } catch (error) {
    const status = error instanceof TRPCError
      ? error.code === 'UNAUTHORIZED' ? 401 : error.code === 'FORBIDDEN' ? 403
        : error.code === 'BAD_REQUEST' ? 400 : error.code === 'NOT_FOUND' ? 404 : 500
      : 500;
    return new Response('Fiscal evidence export unavailable. Check access, branch and the 92-day date window.', {
      status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
