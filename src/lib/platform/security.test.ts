import { describe, expect, it } from 'vitest';

import { assertPlatformMutationOrigin, PlatformSecurityError } from './security';

function request(headers: Record<string, string>) {
  return new Request('http://internal-runtime:3000/api/platform/session', { headers });
}

describe('platform mutation origin', () => {
  it('accepts the exact public origin supplied by the reverse proxy', () => {
    expect(() =>
      assertPlatformMutationOrigin(
        request({
          origin: 'http://admin.localhost:3000',
          'x-forwarded-host': 'admin.localhost:3000',
          'x-forwarded-proto': 'http',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        })
      )
    ).not.toThrow();
  });

  it('rejects cross-origin and non-JSON mutation attempts', () => {
    expect(() =>
      assertPlatformMutationOrigin(
        request({
          origin: 'https://attacker.example',
          'x-forwarded-host': 'admin.example.com',
          'x-forwarded-proto': 'https',
          'sec-fetch-site': 'cross-site',
          'content-type': 'application/json',
        })
      )
    ).toThrow(PlatformSecurityError);

    expect(() =>
      assertPlatformMutationOrigin(
        request({
          origin: 'https://admin.example.com',
          'x-forwarded-host': 'admin.example.com',
          'x-forwarded-proto': 'https',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/x-www-form-urlencoded',
        })
      )
    ).toThrow('Content-Type must be application/json.');
  });
});
