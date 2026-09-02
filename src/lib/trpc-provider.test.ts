/**
 * WHA-1181 — a restaurant administrator with no staff profile saw the
 * notification poll denied, then retried twice more: three identical 403s in one
 * page load, repeated on every poll after it.
 */
import { TRPCClientError } from '@trpc/client';
import { describe, expect, it } from 'vitest';

import { retryQuery } from './trpc-provider';

/** A client error shaped the way the tRPC HTTP link builds one. */
function clientError(code: string) {
  const error = new TRPCClientError('denied');
  Object.defineProperty(error, 'data', { value: { code }, configurable: true });
  return error;
}

describe('retryQuery', () => {
  it('does not retry a FORBIDDEN answer even on the first failure', () => {
    expect(retryQuery(0, clientError('FORBIDDEN'))).toBe(false);
  });

  it('does not retry UNAUTHORIZED, which is already handled by a redirect', () => {
    expect(retryQuery(0, clientError('UNAUTHORIZED'))).toBe(false);
  });

  it.each(['INTERNAL_SERVER_ERROR', 'TIMEOUT', 'TOO_MANY_REQUESTS'])(
    'keeps the default three attempts for %s',
    (code) => {
      expect(retryQuery(0, clientError(code))).toBe(true);
      expect(retryQuery(2, clientError(code))).toBe(true);
      expect(retryQuery(3, clientError(code))).toBe(false);
    }
  );

  it('keeps retrying a transport failure that carries no tRPC code at all', () => {
    expect(retryQuery(0, new Error('network down'))).toBe(true);
    expect(retryQuery(3, new Error('network down'))).toBe(false);
  });
});
