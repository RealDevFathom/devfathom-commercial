import { describe, expect, it } from 'vitest';
import {
  assertStagingDemoTarget,
  resolvePharmacyE2eDatabaseUrl,
} from '../scripts/pharmacy-e2e-environment';

const ENDPOINT = 'devfathom-staging.abc123.ap-southeast-1.rds.amazonaws.com';
const URL_OK = `postgresql://app@${ENDPOINT}:5432/devfathom`;
const base = { DEPLOY_ENV: 'staging', STAGING_DB_ENDPOINT: ENDPOINT };
const seedEnv = {
  ...base,
  STAGING_DEMO_SEED: '1',
  STAGING_DEMO_DATABASE_URL: URL_OK,
  PHARMACY_E2E_ADMIN_EMAIL: 'a@b.invalid',
  PHARMACY_E2E_ADMIN_PASSWORD: 'x',
};

describe('assertStagingDemoTarget', () => {
  it('accepts the staging endpoint when DEPLOY_ENV is staging', () => {
    expect(assertStagingDemoTarget(URL_OK, base)).toBe(new URL(URL_OK).href);
    expect(
      assertStagingDemoTarget(URL_OK, { ...base, STAGING_DB_ENDPOINT: ENDPOINT.toUpperCase() })
    ).toBe(new URL(URL_OK).href);
  });

  it.each([undefined, '', 'production', 'Staging', 'staging ', 'preview'])(
    'refuses DEPLOY_ENV=%j',
    (value) => {
      expect(() => assertStagingDemoTarget(URL_OK, { ...base, DEPLOY_ENV: value })).toThrow(
        /DEPLOY_ENV/
      );
    }
  );

  it('refuses without STAGING_DB_ENDPOINT', () => {
    expect(() => assertStagingDemoTarget(URL_OK, { DEPLOY_ENV: 'staging' })).toThrow(
      /STAGING_DB_ENDPOINT/
    );
  });

  it.each([
    'postgresql://app@devfathom-production.abc123.ap-southeast-1.rds.amazonaws.com:5432/devfathom',
    `postgresql://app@${ENDPOINT}.evil.example:5432/devfathom`,
    'postgresql://app@localhost:5432/devfathom',
  ])('refuses a host other than the staging endpoint: %s', (url) => {
    expect(() => assertStagingDemoTarget(url, base)).toThrow(/not the staging endpoint/);
  });

  it('refuses a non-PostgreSQL or malformed URL', () => {
    expect(() => assertStagingDemoTarget(`mysql://app@${ENDPOINT}/devfathom`, base)).toThrow(
      /PostgreSQL/
    );
    expect(() => assertStagingDemoTarget('not a url', base)).toThrow(/valid URL/);
  });

  it('refuses a production endpoint even when it is the configured one', () => {
    const prod = 'devfathom-production.abc123.ap-southeast-1.rds.amazonaws.com';
    expect(() =>
      assertStagingDemoTarget(`postgresql://a:b@${prod}:5432/devfathom`, {
        DEPLOY_ENV: 'staging',
        STAGING_DB_ENDPOINT: prod,
      })
    ).toThrow(/production or preview/);
    expect(() =>
      assertStagingDemoTarget(`postgresql://a:b@${ENDPOINT}:5432/production`, base)
    ).toThrow(/production or preview/);
  });
});

describe('fixed staging RDS endpoint form', () => {
  it.each([
    'db.internal.example.com',
    'devfathom-staging.abc123.us-east-1.rds.amazonaws.com',
    'devfathom-other.abc123.ap-southeast-1.rds.amazonaws.com',
    'devfathom-staging.abc123.ap-southeast-1.rds.amazonaws.com.evil.example',
  ])('refuses %s even when STAGING_DB_ENDPOINT names it', (host) => {
    expect(() =>
      assertStagingDemoTarget(`postgresql://a:b@${host}:5432/devfathom`, {
        DEPLOY_ENV: 'staging',
        STAGING_DB_ENDPOINT: host,
      })
    ).toThrow(/devfathom-staging RDS endpoint/);
  });
});

describe('resolvePharmacyE2eDatabaseUrl staging path', () => {
  it('runs the staging guard instead of returning the URL verbatim', () => {
    expect(resolvePharmacyE2eDatabaseUrl(seedEnv)).toBe(new URL(URL_OK).href);
    expect(() => resolvePharmacyE2eDatabaseUrl({ ...seedEnv, DEPLOY_ENV: 'production' })).toThrow(
      /DEPLOY_ENV/
    );
    expect(() =>
      resolvePharmacyE2eDatabaseUrl({
        ...seedEnv,
        STAGING_DEMO_DATABASE_URL: 'postgresql://a:b@prod-db.example.com:5432/devfathom',
      })
    ).toThrow(/not the staging endpoint/);
  });

  it('keeps the disposable-database guards for the e2e path', () => {
    expect(() =>
      resolvePharmacyE2eDatabaseUrl({
        PHARMACY_E2E: '1',
        PHARMACY_E2E_DATABASE_URL: `postgresql://a:b@${ENDPOINT}:5432/devfathom`,
      })
    ).toThrow();
  });
});
