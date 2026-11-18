import { TRPCError } from '@trpc/server';
import type { FiscalExceptionInput } from '@/lib/pharmacy/accounts/fiscal-exceptions';

export type FiscalExceptionQuery = Record<string, string | string[] | undefined>;

const allowedKeys = new Set(['branchId', 'from', 'to', 'page', 'pageSize']);

/** Reject unknown URL keys explicitly; Zod's strict object check skips __proto__. */
export function fiscalExceptionQuery(query: FiscalExceptionQuery) {
  if (Object.keys(query).some((key) => !allowedKeys.has(key))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unsupported fiscal evidence query field.' });
  }
  // Preserve duplicate and malformed values for rejection by the reader schema.
  const today = new Date();
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const from = new Date(midnight - 6 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(midnight + 86_400_000).toISOString().slice(0, 10);
  const number = (value: string | string[] | undefined) => value === undefined
    ? undefined : typeof value === 'string' && /^(0|[1-9]\d{0,5})$/.test(value) ? Number(value) : NaN;
  return {
    ...query,
    branchId: query.branchId ?? '', from: query.from ?? from, to: query.to ?? to,
    page: number(query.page), pageSize: number(query.pageSize),
  };
}

export function fiscalExceptionHref(input: FiscalExceptionInput, csv = false) {
  const query = new URLSearchParams({ branchId: input.branchId, from: input.from, to: input.to });
  if (input.page !== undefined) query.set('page', String(input.page));
  if (input.pageSize !== undefined) query.set('pageSize', String(input.pageSize));
  return `/pharmacy/accounts/fiscal-exceptions${csv ? '/csv' : ''}?${query}`;
}

export function fiscalExceptionError(error: unknown) {
  return error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)
    ? 'Access denied. An active pharmacy workspace, ADMIN role, Reports module, both operational and financial report capabilities, and an active branch in this organization are required.'
    : error instanceof TRPCError && error.code === 'BAD_REQUEST'
      ? 'Enter an active branch ID and real calendar dates. The end date is not included, the window must be 1–92 days, page size is 1–100, and pages are limited to 20.'
      : 'Fiscal evidence could not be loaded. Try again; contact support if the problem continues.';
}
