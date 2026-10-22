import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadLocalEnvironment,
  migrationDatabaseUrl,
  requiredEnvironmentVariable,
} from './load-env';

describe('local environment loading', () => {
  it('prefers .env.local to .env without replacing an existing environment value', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devfathom-env-'));
    const local = join(directory, '.env.local');
    const fallback = join(directory, '.env');
    writeFileSync(local, 'LOCAL_FIRST=local\nPLATFORM_VALUE=local\n');
    writeFileSync(fallback, 'LOCAL_FIRST=fallback\nFALLBACK_ONLY=fallback\nPLATFORM_VALUE=fallback\n');
    const environment = { PLATFORM_VALUE: 'platform' };

    loadLocalEnvironment([local, fallback], environment);

    expect(environment).toEqual({
      LOCAL_FIRST: 'local',
      FALLBACK_ONLY: 'fallback',
      PLATFORM_VALUE: 'platform',
    });
  });

  it('reports the missing variable and every searched source', () => {
    expect(() => requiredEnvironmentVariable('DATABASE_URL', {})).toThrow(
      'Missing required environment variable DATABASE_URL; checked the existing environment, .env.local, and .env.'
    );
  });

  it('accepts a migration URL without requiring its runtime fallback', () => {
    expect(
      migrationDatabaseUrl({
        MIGRATION_DATABASE_URL: '  postgresql://migration-only/example  ',
      })
    ).toBe('postgresql://migration-only/example');
  });

  it('requires DATABASE_URL only when no migration URL is configured', () => {
    expect(migrationDatabaseUrl({ DATABASE_URL: '  postgresql://runtime/example  ' })).toBe(
      'postgresql://runtime/example'
    );
    expect(() => migrationDatabaseUrl({})).toThrow(
      'Missing required environment variable DATABASE_URL'
    );
  });
});
