import { afterEach, describe, expect, it } from 'vitest';

import { contentSecurityPolicy } from './content-security-policy';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('contentSecurityPolicy', () => {
  it('allows production scripts only through the request nonce', () => {
    process.env.NODE_ENV = 'production';

    const policy = contentSecurityPolicy('unique-request-nonce');
    const scriptDirective = policy.match(/script-src[^;]+/)?.[0];

    expect(scriptDirective).toBe(
      "script-src 'self' 'nonce-unique-request-nonce' 'strict-dynamic'"
    );
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
  });

  it('limits unsafe-eval to development without weakening inline-script protection', () => {
    process.env.NODE_ENV = 'development';

    const scriptDirective = contentSecurityPolicy('dev-nonce').match(/script-src[^;]+/)?.[0];

    expect(scriptDirective).toContain("'nonce-dev-nonce'");
    expect(scriptDirective).toContain("'unsafe-eval'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
  });
});
