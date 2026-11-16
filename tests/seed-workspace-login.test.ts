import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seedWorkspaceLoginUrl } from '../prisma/seed-workspace-login';

afterEach(() => vi.unstubAllEnvs());

describe('seed workspace sign-in addresses', () => {
  it('gives agency and pharmacy distinct local hosts on port 3100', () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', 'localhost');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://devfathom.localhost:3100');

    expect(seedWorkspaceLoginUrl('devfathom')).toBe('http://devfathom.localhost:3100/login');
    expect(seedWorkspaceLoginUrl('pharmacy-counter-e2e')).toBe(
      'http://pharmacy-counter-e2e.localhost:3100/login'
    );
    expect(seedWorkspaceLoginUrl('my-pharmacy')).toBe('http://my-pharmacy.localhost:3100/login');
  });

  it('uses AUTH_URL when NEXT_PUBLIC_APP_URL is unset', () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', 'localhost');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    vi.stubEnv('AUTH_URL', 'http://localhost:3100');
    expect(seedWorkspaceLoginUrl('pharmacy-counter-e2e')).toBe(
      'http://pharmacy-counter-e2e.localhost:3100/login'
    );
  });

  it('defaults to the documented local port without URL configuration', () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', undefined);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    vi.stubEnv('AUTH_URL', undefined);
    expect(seedWorkspaceLoginUrl('devfathom')).toBe('http://devfathom.localhost:3000/login');
  });

  it('preserves a configured standard HTTP port', () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', 'localhost');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost');
    expect(seedWorkspaceLoginUrl('devfathom')).toBe('http://devfathom.localhost/login');
  });

  it('keeps deployed workspace addresses on the configured base domain', () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', 'staging.example.test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3100');
    expect(seedWorkspaceLoginUrl('pharmacy-counter-e2e')).toBe(
      'https://pharmacy-counter-e2e.staging.example.test/login'
    );
  });

  it('prints the agency address after the transaction, including the already-seeded path', () => {
    const source = readFileSync('prisma/seed.ts', 'utf8');
    const main = source.slice(source.indexOf('async function main()'));
    expect(main).toContain('return organization.slug;');
    expect(main).toContain('Agency workspace sign-in: ${seedWorkspaceLoginUrl(workspaceSlug)}');
    expect(main.indexOf('Agency workspace sign-in:')).toBeGreaterThan(
      main.indexOf('{ maxWait: 30_000, timeout: 300_000 }')
    );
  });

  it('prints the same pharmacy slug that the seed persists', () => {
    const source = readFileSync('scripts/seed-pharmacy-e2e.ts', 'utf8');
    expect(source).toContain("const PHARMACY_WORKSPACE_SLUG = 'pharmacy-counter-e2e';");
    expect(source).toContain('slug: PHARMACY_WORKSPACE_SLUG,');
    expect(source).toContain(
      'Pharmacy workspace sign-in: ${seedWorkspaceLoginUrl(PHARMACY_WORKSPACE_SLUG)}'
    );
  });
});

describe('local setup troubleshooting', () => {
  const docs = readFileSync('docs/LOCAL_SETUP.md', 'utf8');

  it('documents the wrong-host symptom and the pharmacy address on port 3100', () => {
    expect(docs).toContain('http://localhost:3100');
    expect(docs).toContain('http://<workspace-slug>.localhost:3100/login');
    expect(docs).toContain('Invalid email or password');
    expect(docs).toContain('that host selects the agency workspace by default');
  });

  it('gives a safe way to clear shell database overrides', () => {
    expect(docs).toContain(
      'An exported `DATABASE_URL` in your shell takes precedence over `.env.local`'
    );
    expect(docs).toContain('unset DATABASE_URL MIGRATION_DATABASE_URL');
  });
});
