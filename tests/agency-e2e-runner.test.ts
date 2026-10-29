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
  NEXT_PUBLIC_APP_URL: 'https://agency-e2e.example.test',
  EMAIL_DELIVERY_MODE: 'send',
  BREVO_API_KEY: 'test-api-key',
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

  test('requires an HTTPS public URL and real invite email delivery settings', () => {
    const base = { AGENCY_E2E_DATABASE_URL: target, ...credentials };
    expect(() => agencyE2eEnvironment({ ...base, NEXT_PUBLIC_APP_URL: undefined })).toThrow(
      'NEXT_PUBLIC_APP_URL is required'
    );
    expect(() =>
      agencyE2eEnvironment({ ...base, NEXT_PUBLIC_APP_URL: 'http://example.test' })
    ).toThrow('must use HTTPS');
    expect(() => agencyE2eEnvironment({ ...base, EMAIL_DELIVERY_MODE: 'capture' })).toThrow(
      'EMAIL_DELIVERY_MODE=send'
    );
    expect(() => agencyE2eEnvironment({ ...base, BREVO_API_KEY: undefined })).toThrow(
      'BREVO_API_KEY is required'
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
