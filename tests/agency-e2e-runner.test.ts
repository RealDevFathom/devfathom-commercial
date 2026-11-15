import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  agencyE2eEnvironment,
  resolveAgencyE2eDatabaseUrl,
} from '../scripts/agency-e2e-environment';

const target = 'postgresql://runner:secret@127.0.0.1:55434/devfathom_agency_e2e';
const credentials = {
  AGENCY_E2E: '1',
  AGENCY_E2E_ADMIN_EMAIL: 'admin@agency-e2e.test',
  AGENCY_E2E_ADMIN_PASSWORD: 'test-only-password',
  NEXT_PUBLIC_APP_URL: 'https://agency.example.test',
  BREVO_API_KEY: 'test-only-key',
  BREVO_SENDER_EMAIL: 'invites@example.test',
};

describe('Agency E2E fail-closed runner', () => {
  test('requires explicit opt-in, credentials, and one canonical target', () => {
    expect(() => resolveAgencyE2eDatabaseUrl({ AGENCY_E2E_DATABASE_URL: target })).toThrow(
      'explicit opt-in'
    );
    expect(() =>
      agencyE2eEnvironment({ AGENCY_E2E: '1', AGENCY_E2E_DATABASE_URL: target })
    ).toThrow('AGENCY_E2E_ADMIN_EMAIL');
    const env = agencyE2eEnvironment({ AGENCY_E2E_DATABASE_URL: target, ...credentials });
    expect(env.DATABASE_URL).toBe(new URL(target).href);
    expect(env.TEST_DATABASE_URL).toBe(env.DATABASE_URL);
  });

  test('keeps the local CI lane runnable without mail settings or an application URL', () => {
    const local = {
      AGENCY_E2E: '1',
      AGENCY_E2E_ADMIN_EMAIL: 'admin@agency-e2e.test',
      AGENCY_E2E_ADMIN_PASSWORD: 'test-only-password',
      AGENCY_E2E_DATABASE_URL: target,
    };
    expect(agencyE2eEnvironment(local).DATABASE_URL).toBe(new URL(target).href);
    expect(
      agencyE2eEnvironment({ ...local, NEXT_PUBLIC_APP_URL: 'http://localhost:4327' }).DATABASE_URL
    ).toBe(new URL(target).href);
    expect(agencyE2eEnvironment({ ...local, AUTH_URL: 'http://127.0.0.1:4327' }).DATABASE_URL).toBe(
      new URL(target).href
    );
  });

  test.each(['BREVO_API_KEY', 'BREVO_SENDER_EMAIL'] as const)(
    'requires %s before a non-local lane starts',
    (name) => {
      expect(() =>
        agencyE2eEnvironment({
          ...credentials,
          AGENCY_E2E_DATABASE_URL: target,
          [name]: ' ',
        })
      ).toThrow(name);
    }
  );

  test.each([
    '',
    'invalid',
    'javascript:alert(1)',
    'http://staging.example.test',
    'http://agency.example.test',
    'https://user:password@example.test',
    'http://user:password@localhost:4327',
  ])('rejects a malformed or unsafe application URL %s', (url) => {
    expect(() =>
      agencyE2eEnvironment({
        ...credentials,
        AGENCY_E2E_DATABASE_URL: target,
        NEXT_PUBLIC_APP_URL: url,
      })
    ).toThrow(/application URL/);
  });

  test('uses runtime application URL precedence and accepts HTTPS auth fallbacks', () => {
    const env = { ...credentials, AGENCY_E2E_DATABASE_URL: target, NEXT_PUBLIC_APP_URL: undefined };
    expect(
      agencyE2eEnvironment({ ...env, NEXTAUTH_URL: 'https://auth.example.test' }).DATABASE_URL
    ).toBe(new URL(target).href);
    expect(
      agencyE2eEnvironment({ ...env, AUTH_URL: 'https://auth.example.test' }).DATABASE_URL
    ).toBe(new URL(target).href);
    expect(() =>
      agencyE2eEnvironment({
        ...env,
        NEXT_PUBLIC_APP_URL: 'http://staging.example.test',
        AUTH_URL: 'https://auth.example.test',
      })
    ).toThrow('HTTPS');
    expect(() =>
      agencyE2eEnvironment({
        ...env,
        BREVO_API_KEY: undefined,
        AUTH_URL: 'https://auth.example.test',
      })
    ).toThrow('BREVO_API_KEY');
  });

  test('refuses capture mode on a public URL and malformed sender addresses', () => {
    const env = { ...credentials, AGENCY_E2E_DATABASE_URL: target };
    expect(() => agencyE2eEnvironment({ ...env, EMAIL_DELIVERY_MODE: 'capture' })).toThrow(
      'real email delivery'
    );
    expect(() => agencyE2eEnvironment({ ...env, BREVO_SENDER_EMAIL: 'not-an-email' })).toThrow(
      'valid sender'
    );
    expect(() =>
      agencyE2eEnvironment({
        ...env,
        NEXT_PUBLIC_APP_URL: 'http://localhost:4327',
        BREVO_SENDER_EMAIL: 'not-an-email',
      })
    ).toThrow('valid sender');
    expect(agencyE2eEnvironment({ ...env, EMAIL_DELIVERY_MODE: 'send' }).DATABASE_URL).toBe(
      new URL(target).href
    );
  });

  test.each([
    ['postgresql://runner:x@db.example/agency_e2e', 'common PostgreSQL port'],
    ['postgresql://runner:x@db.example:5432/agency_e2e', 'common PostgreSQL port'],
    ['postgresql://runner:x@production.example:55434/agency_e2e', 'production'],
    ['postgresql://runner:x@db.example:55434/devfathom', 'disposable'],
  ])('rejects unsafe database %s', (databaseUrl, message) => {
    expect(() =>
      resolveAgencyE2eDatabaseUrl({ AGENCY_E2E: '1', AGENCY_E2E_DATABASE_URL: databaseUrl })
    ).toThrow(message);
  });

  test('rejects external server reuse and mismatched application databases', () => {
    expect(() =>
      agencyE2eEnvironment({
        AGENCY_E2E_DATABASE_URL: target,
        PLAYWRIGHT_BASE_URL: 'http://localhost:3000',
        ...credentials,
      })
    ).toThrow('PLAYWRIGHT_BASE_URL');
    expect(() =>
      resolveAgencyE2eDatabaseUrl({
        AGENCY_E2E: '1',
        AGENCY_E2E_DATABASE_URL: target,
        DATABASE_URL: 'postgresql://runner:x@127.0.0.1:55435/other_e2e',
      })
    ).toThrow('DATABASE_URL must match');
  });

  test('dedicated config is serial, single-project, and root-excluded', () => {
    const dedicated = readFileSync(resolve('playwright.agency.config.ts'), 'utf8');
    const root = readFileSync(resolve('playwright.config.ts'), 'utf8');
    expect(dedicated).toContain('workers: 1');
    expect(dedicated).toContain('fullyParallel: false');
    expect(dedicated.match(/name: 'agency-acceptance-serial'/g)).toHaveLength(1);
    expect(dedicated).toContain("testDir: './tests/agency-e2e'");
    expect(dedicated).toContain('reuseExistingServer: false');
    expect(root).toContain("testDir: './tests/e2e'");
    expect(root).not.toContain('agency-acceptance.spec.ts');
  });
});
