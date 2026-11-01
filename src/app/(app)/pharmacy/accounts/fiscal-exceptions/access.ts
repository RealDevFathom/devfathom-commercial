import 'server-only';

import { TRPCError } from '@trpc/server';
import { readFiscalExceptions } from '@/lib/pharmacy/accounts/fiscal-exceptions.reader';
import { recordTrpcAudit } from '@/server/audit';
import { createTRPCContext } from '@/server/trpc';

/** Page and CSV share this local audited entry point; no shared report loader is changed. */
export async function loadFiscalExceptionRegister(input: unknown, request?: Request) {
  const ctx = await createTRPCContext(request ? { req: request } : undefined);
  const start = Date.now();
  let failure: TRPCError | undefined;
  try {
    return await readFiscalExceptions(ctx, input);
  } catch (error) {
    failure = error instanceof TRPCError ? error : new TRPCError({
      code: 'INTERNAL_SERVER_ERROR', message: 'Fiscal evidence is unavailable.',
    });
    throw failure;
  } finally {
    // Retain the existing sensitive-read audit, without document data or raw query input.
    await recordTrpcAudit({
      ctx: {
        ...ctx,
        audit: {
          ...ctx.audit,
          detail: { category: 'PHARMACY_ACCOUNTS', operation: 'READ', skipInput: true },
        },
      },
      path: request ? 'pharmacyAccounts.fiscalExceptionsCsv' : 'pharmacyAccounts.fiscalExceptions',
      type: 'query', input: undefined, outcome: failure ? 'FAILURE' : 'SUCCESS',
      error: failure, durationMs: Date.now() - start,
    });
  }
}
