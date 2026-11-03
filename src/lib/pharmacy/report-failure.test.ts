import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { reportFailureKind, reportFailureMessage } from './report-failure';

describe('reportFailureKind', () => {
  it.each([
    ['FORBIDDEN', 'forbidden'],
    ['UNAUTHORIZED', 'forbidden'],
    ['NOT_FOUND', 'not-found'],
    ['BAD_REQUEST', 'invalid'],
    ['INTERNAL_SERVER_ERROR', 'unavailable'],
    ['TIMEOUT', 'unavailable'],
  ] as const)('maps %s to %s', (code, kind) => {
    expect(reportFailureKind(new TRPCError({ code }))).toBe(kind);
  });

  it('treats a network or unknown failure as unavailable, not a permission problem', () => {
    expect(reportFailureKind(new TypeError('fetch failed'))).toBe('unavailable');
    expect(reportFailureKind(undefined)).toBe('unavailable');
  });
});

describe('reportFailureMessage', () => {
  const subject = 'value-at-risk advice';

  it('mentions permissions only for a refusal', () => {
    expect(reportFailureMessage('forbidden', subject)).toMatch(/permissions are required/);
    for (const kind of ['not-found', 'invalid', 'unavailable'] as const)
      expect(reportFailureMessage(kind, subject)).not.toMatch(/permissions are required/);
  });

  it('names an outage as a server or network problem', () => {
    expect(reportFailureMessage('unavailable', subject)).toBe(
      'Value-at-risk advice could not be loaded because of a server or network problem. This is not a permission issue; reload the page to try again.'
    );
  });

  it('names a missing branch or record as not found', () => {
    expect(reportFailureMessage('not-found', subject)).toMatch(/could not be found/);
  });
});
