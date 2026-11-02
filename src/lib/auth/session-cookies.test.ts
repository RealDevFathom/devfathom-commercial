import { describe, expect, it } from 'vitest';

import { authSessionCookieNames } from './session-cookies';

describe('authSessionCookieNames', () => {
  it.each([null, ''])('includes both unsuffixed names without cookies (%s)', (header) => {
    expect(authSessionCookieNames(header)).toEqual([
      'authjs.session-token',
      '__Secure-authjs.session-token',
    ]);
  });

  it('discovers local and secure chunks, deduplicating names and ignoring value contents', () => {
    expect(
      authSessionCookieNames(
        'authjs.session-token=base==; __Secure-authjs.session-token=secure-base; ' +
          'authjs.session-token.0=first==; authjs.session-token.12=last; ' +
          '__Secure-authjs.session-token.0=secure-first; ' +
          '__Secure-authjs.session-token.123=secure-last==; ' +
          'authjs.session-token.0=duplicate; __Secure-authjs.session-token.123=duplicate'
      )
    ).toEqual([
      'authjs.session-token',
      '__Secure-authjs.session-token',
      'authjs.session-token.0',
      'authjs.session-token.12',
      '__Secure-authjs.session-token.0',
      '__Secure-authjs.session-token.123',
    ]);
  });

  it('ignores malformed chunks, missing separators, unrelated cookies and names in values', () => {
    expect(
      authSessionCookieNames(
        'authjs.session-token.invalid=preserved; authjs.session-token.2; ' +
          '__Secure-authjs.session-token.-1=preserved; authjs.session-token.1.extra=preserved; ' +
          'authjs.session-token.=preserved; authjs.session-token-other=preserved; ' +
          'unrelated=authjs.session-token.3=value; =missing-name; ; '
      )
    ).toEqual(['authjs.session-token', '__Secure-authjs.session-token']);
  });
});
