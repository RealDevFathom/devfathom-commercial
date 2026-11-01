import { afterEach, describe, expect, it, vi } from 'vitest';

import { contentSecurityPolicy } from './content-security-policy';

describe('contentSecurityPolicy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires the request nonce for production scripts', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const policy = contentSecurityPolicy('unique-request-nonce');

    expect(policy).toContain("script-src 'self' 'nonce-unique-request-nonce'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it('retains only the development evaluator exception', () => {
    vi.stubEnv('NODE_ENV', 'development');

    const policy = contentSecurityPolicy('development-nonce');

    expect(policy).toContain("script-src 'self' 'nonce-development-nonce' 'unsafe-eval'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});
