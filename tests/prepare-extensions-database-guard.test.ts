// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { assertDisposableExtensionDatabase } from './prepare-extensions-database-guard';

const attestation = {
  PREPARE_EXTENSIONS_FRESH_DB_TEST: '1',
  PREPARE_EXTENSIONS_DISPOSABLE_CLUSTER: '1',
};
const refusal = 'Extension preparation requires an attested disposable local PostgreSQL target';

describe('extension preparation target preflight (pure, no database clients)', () => {
  it.each([
    'postgresql://qa@localhost/extension_test',
    'postgres://qa@127.0.0.1:55481/disposable_extensions',
    'postgresql://qa@[::1]:55481/extension_e2e',
    'postgresql://qa@%2Ftmp%2Fsynthetic-pg/extension_test',
    'postgresql:///extension_test?host=%2Ftmp%2Fsynthetic-pg&port=55481',
    'postgresql://qa@localhost:55481/extension_test?host=%2Ftmp%2Fsynthetic-pg',
  ])('permits only an explicitly attested local/socket disposable target %s', (url) => {
    expect(assertDisposableExtensionDatabase(url, attestation)).toBeInstanceOf(URL);
  });

  it.each([
    {},
    { PREPARE_EXTENSIONS_FRESH_DB_TEST: '1' },
    { PREPARE_EXTENSIONS_DISPOSABLE_CLUSTER: '1' },
    { ...attestation, PREPARE_EXTENSIONS_FRESH_DB_TEST: 'true' },
    { ...attestation, PREPARE_EXTENSIONS_DISPOSABLE_CLUSTER: 'true' },
  ])('refuses missing or inexact disposable/suite attestation %#', (env) => {
    expect(() =>
      assertDisposableExtensionDatabase('postgresql://qa@localhost/extension_test', env)
    ).toThrow(refusal);
  });

  it.each([
    '',
    'not-a-connection-url',
    'https://localhost/extension_test',
    ' postgresql://qa@localhost/extension_test',
    'postgresql://qa@localhost/extension_test ',
    'postgresql://qa@localhost/postgres',
    'postgresql://qa@localhost/devfathom',
    'postgresql://qa@localhost/production_test',
    'postgresql://qa@localhost/staging_test',
    'postgresql://qa@localhost/live_test',
    'postgresql://qa@localhost/extension_test%2Fother',
    'postgresql://qa@localhost/',
    'postgresql:///extension_test',
    'postgresql://qa@db.example/extension_test',
    'postgresql://qa@192.0.2.1/extension_test',
    'postgresql://qa@localhost.example/extension_test',
    'postgresql://qa@db.example/extension_test?host=%2Ftmp%2Fsynthetic-pg',
    'postgresql://qa@localhost/extension_test?host=db.example',
    'postgresql://qa@localhost/extension_test?host=127.0.0.1',
    'postgresql:///extension_test?host=%2F%2Fremote%2Fpg',
    'postgresql:///extension_test?host=%2Ftmp%2Fsynthetic-pg&host=db.example',
    'postgresql:///extension_test?host=%2Ftmp%2Fsynthetic-pg&port=55481&port=5432',
    'postgresql://qa@localhost/extension_test?database=production',
    'postgresql://qa@localhost/extension_test?dbname=production',
    'postgresql://qa@localhost/extension_test?options=-h%20db.example',
    'postgresql://qa@localhost/extension_test?service=production',
    'postgresql:///extension_test?host=%2Ftmp%2Fsynthetic-pg&port=',
    'postgresql:///extension_test?host=%2Ftmp%2Fsynthetic-pg&port=0',
    'postgresql:///extension_test?host=%2Ftmp%2Fsynthetic-pg&port=65536',
    'postgresql://qa@localhost:55481/extension_test?port=5432',
  ])('refuses unsafe or ambiguous targets before any connection %s', (url) => {
    expect(() =>
      assertDisposableExtensionDatabase(url, {
        ...attestation,
        // This unrelated RLS opt-in must never authorize remote admin lifecycle.
        ALLOW_REMOTE_RLS_TEST: 'true',
      })
    ).toThrow(refusal);
  });

  it('returns only a generic failure, not credentials or the supplied URL', () => {
    const url = 'postgresql://synthetic-user:synthetic-password@remote.example/extension_test';
    try {
      assertDisposableExtensionDatabase(url, attestation);
      expect.unreachable('unsafe target accepted');
    } catch (error) {
      expect((error as Error).message).toBe(refusal);
      expect((error as Error).message).not.toContain(url);
      expect((error as Error).message).not.toContain('synthetic-password');
    }
  });

  it('wires explicit opt-in and preflight before client construction/connection in the source', () => {
    const source = readFileSync(
      new URL('./prepare-extensions-fresh-db.test.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain("process.env.PREPARE_EXTENSIONS_FRESH_DB_TEST === '1'");
    expect(source).toContain('(optedIn ? describe : describe.skip)');
    const hook = source.match(/beforeAll\(async \(\) => \{([\s\S]*?)\n  \}\);/)?.[1];
    expect(hook).toBeDefined();
    const guard = hook!.indexOf('assertDisposableExtensionDatabase(adminUrl)');
    const client = hook!.indexOf('new pg.Client');
    const connection = hook!.indexOf('await admin.connect()');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(client).toBeGreaterThan(guard);
    expect(connection).toBeGreaterThan(client);
    expect(source.slice(0, source.indexOf('beforeAll(async'))).not.toContain('new pg.Client');
  });

  it('retains synthetic state: the lifecycle source has no database teardown or FORCE termination', () => {
    const source = readFileSync(
      new URL('./prepare-extensions-fresh-db.test.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/\bDROP\s+DATABASE\b|\bWITH\s*\(\s*FORCE\s*\)/i);
    const close = source.match(/afterAll\(async \(\) => \{([\s\S]*?)\n  \}\);/)?.[1];
    expect(close).toContain('await admin?.end()');
    expect(close).not.toContain('.query(');
    expect(source).toContain('prepare_extensions_test_');
  });
});
