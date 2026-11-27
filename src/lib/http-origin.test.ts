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

describe('trusted request origin (DEV-957 phase 2)', () => {
  it('reads the forwarded host only behind a proxy on an internal address', async () => {
    const { trustedRequestOrigin } = await import('./http-origin');
    const behindProxy = new Request('http://localhost:4331/api/pharmacy/counter/establish', {
      headers: { 'x-forwarded-host': 'tenant.example', 'x-forwarded-proto': 'https' },
    });
    expect(trustedRequestOrigin(behindProxy)).toBe('https://tenant.example');
    for (const internal of ['10.0.0.7:3000', '192.168.1.4', '172.20.0.2:3000', 'app', '[::1]:3000'])
      expect(
        trustedRequestOrigin(
          new Request('http://placeholder/x', {
            headers: { host: internal, 'x-forwarded-host': 'tenant.example', 'x-forwarded-proto': 'https' },
          })
        )
      ).toBe('https://tenant.example');
  });

  it('ignores a client-supplied X-Forwarded-Host on a request to the public host', async () => {
    const { trustedRequestOrigin } = await import('./http-origin');
    const direct = new Request('https://tenant.example/api/pharmacy/counter/establish', {
      headers: { host: 'tenant.example', 'x-forwarded-host': 'evil.example' },
    });
    expect(trustedRequestOrigin(direct)).toBe('https://tenant.example');
    const noHostHeader = new Request('https://tenant.example/x', {
      headers: { 'x-forwarded-host': 'evil.example' },
    });
    expect(trustedRequestOrigin(noHostHeader)).toBe('https://tenant.example');
    // A TLS-terminating proxy may still say https for the host the client really reached.
    const tls = new Request('http://tenant.example/x', {
      headers: { host: 'tenant.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' },
    });
    expect(trustedRequestOrigin(tls)).toBe('https://tenant.example');
  });
});
