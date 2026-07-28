import { describe, expect, it } from 'vitest';
import { publicRequestOrigin, publicRequestUrl } from './http-origin';

describe('public request URLs', () => {
  it('uses the reverse-proxy host instead of the internal runtime URL', () => {
    const request = new Request('http://internal-runtime:3000/callback?code=abc', {
      headers: {
        'x-forwarded-host': 'devfathom.localhost:3000',
        'x-forwarded-proto': 'http',
      },
    });

    expect(publicRequestOrigin(request)).toBe('http://devfathom.localhost:3000');
    expect(publicRequestUrl(request).toString()).toBe(
      'http://devfathom.localhost:3000/callback?code=abc'
    );
  });
});
