import { TRPCError } from '@trpc/server';

import { ShiftError } from '@/lib/restaurant/shifts';
import { WorkforceError } from '@/lib/restaurant/workforce';

function hasSqlState(error: unknown, sqlState: string, seen = new Set<unknown>()): boolean {
  if (!error || (typeof error !== 'object' && typeof error !== 'string') || seen.has(error)) {
    return false;
  }
  if (typeof error === 'string') return error.includes(sqlState);
  seen.add(error);
  const record = error as Record<string, unknown>;
  if (record.code === sqlState || record.sqlState === sqlState) return true;
  return ['cause', 'originalError', 'driverError', 'meta', 'database_error'].some((key) =>
    hasSqlState(record[key], sqlState, seen)
  );
}

/** Translate a shift-domain error into the right tRPC status; rethrow anything else. */
export function mapShiftError(err: unknown): never {
  if (err instanceof ShiftError) {
    const code =
      err.reason === 'OVERLAP' ||
      err.reason === 'VERSION_CONFLICT' ||
      err.reason === 'ALREADY_CANCELLED'
        ? 'CONFLICT'
        : err.reason === 'SHIFT_NOT_FOUND' ||
            err.reason === 'BRANCH_NOT_FOUND' ||
            err.reason === 'STAFF_NOT_FOUND'
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (hasSqlState(err, '23P01')) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This operator already has an overlapping shift on the roster.',
    });
  }
  throw err;
}

export function mapWorkforceError(err: unknown): never {
  if (err instanceof WorkforceError) {
    const code =
      err.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : err.reason === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : err.reason === 'INVALID'
            ? 'BAD_REQUEST'
            : 'CONFLICT';
    throw new TRPCError({ code, message: err.message });
  }
  if (hasSqlState(err, '23P01')) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'Approving this swap would create an overlapping shift for the replacement operator.',
    });
  }
  throw err;
}
