import 'server-only';

import { TRPCError } from '@trpc/server';
import { readFiscalExceptions } from '@/lib/pharmacy/accounts/fiscal-exceptions.reader';
import { recordTrpcAudit } from '@/server/audit';
import { createTRPCContext } from '@/server/trpc';
import { fiscalExceptionDefaults } from './query';

/** Page and CSV share this local audited entry point; no shared report loader is changed. */
export async function loadFiscalExceptionRegister(input: unknown, request?: Request) {
  const ctx = await createTRPCContext(request ? { req: request } : undefined);
  const start = Date.now();
  let failure: TRPCError | undefined;
  try {
    // Missing dates default to the organisation's last seven days; the reader validates them.
    const dated = input && typeof input === 'object'
      ? fiscalExceptionDefaults(input as Record<string, unknown>, ctx.organization?.timezone)
      : input;
    return await readFiscalExceptions(ctx, dated);
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
