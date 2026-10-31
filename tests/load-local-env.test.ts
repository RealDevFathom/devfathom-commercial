import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadLocalEnvironment,
  requireEnvironment,
  resolvePrismaDatasourceUrl,
} from '../scripts/load-local-env';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('loadLocalEnvironment', () => {
  it('gives .env.local precedence over .env', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devfathom-env-'));
    directories.push(directory);
    writeFileSync(join(directory, '.env'), 'DATABASE_URL=from-dot-env\nFALLBACK=from-dot-env\n');
    writeFileSync(join(directory, '.env.local'), 'DATABASE_URL=from-dot-env-local\n');

    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    loadLocalEnvironment(environment, directory);

    expect(environment.DATABASE_URL).toBe('from-dot-env-local');
    expect(environment.FALLBACK).toBe('from-dot-env');
  });

  it('falls back to .env when .env.local is absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devfathom-env-'));
    directories.push(directory);
    writeFileSync(join(directory, '.env'), 'DATABASE_URL=from-dot-env\n');

    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    loadLocalEnvironment(environment, directory);

    expect(environment.DATABASE_URL).toBe('from-dot-env');
  });

  it('loads .env.local when .env is absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devfathom-env-'));
    directories.push(directory);
    writeFileSync(join(directory, '.env.local'), 'DATABASE_URL=from-dot-env-local\n');

    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    loadLocalEnvironment(environment, directory);

    expect(environment.DATABASE_URL).toBe('from-dot-env-local');
  });

  it('never shadows variables supplied by the process environment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devfathom-env-'));
    directories.push(directory);
    writeFileSync(join(directory, '.env'), 'DATABASE_URL=from-dot-env\n');
    writeFileSync(join(directory, '.env.local'), 'DATABASE_URL=from-dot-env-local\n');

    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: 'from-platform' };
    loadLocalEnvironment(environment, directory);

    expect(environment.DATABASE_URL).toBe('from-platform');
  });

  it('does not replace an invalid process value with a value from a local file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devfathom-env-'));
    directories.push(directory);
    writeFileSync(join(directory, '.env.local'), 'DATABASE_URL=from-dot-env-local\n');

    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: '   ' };
    loadLocalEnvironment(environment, directory);

    expect(() => requireEnvironment('DATABASE_URL', environment)).toThrow(
      'Missing required environment variable: DATABASE_URL'
    );
  });

  it('does not replace a blank .env.local value with the .env fallback', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devfathom-env-'));
    directories.push(directory);
    writeFileSync(join(directory, '.env'), 'DATABASE_URL=from-dot-env\n');
    writeFileSync(join(directory, '.env.local'), 'DATABASE_URL=   \n');

    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    loadLocalEnvironment(environment, directory);

    expect(() => requireEnvironment('DATABASE_URL', environment)).toThrow(
      'Missing required environment variable: DATABASE_URL'
    );
  });

  it('names the missing variable and both searched files', () => {
    expect(() => requireEnvironment('DATABASE_URL', { NODE_ENV: 'test' })).toThrow(
      'Missing required environment variable: DATABASE_URL. Searched .env.local and .env'
    );
  });

  it('rejects a whitespace-only required variable', () => {
    expect(() => requireEnvironment('DATABASE_URL', { NODE_ENV: 'test', DATABASE_URL: '   ' })).toThrow(
      'Missing required environment variable: DATABASE_URL'
    );
  });

  it('trims a required variable before returning it', () => {
    expect(
      requireEnvironment('DATABASE_URL', {
        NODE_ENV: 'test',
        DATABASE_URL: '  postgres://localhost/db  ',
      })
    ).toBe('postgres://localhost/db');
  });
});

describe('resolvePrismaDatasourceUrl', () => {
  const cli = (...args: string[]) => ['node', 'prisma', ...args];

  it.each([['generate'], ['validate'], ['format'], ['version'], ['--version']])(
    'allows offline `prisma %s` without database credentials',
    (command) => {
      expect(resolvePrismaDatasourceUrl({ NODE_ENV: 'test' }, cli(command))).toBeUndefined();
    }
  );

  it.each([
    ['--schema=prisma/schema.prisma', 'generate'],
    ['--schema', 'prisma/schema.prisma', 'generate'],
    ['--config', 'prisma.config.ts', 'generate'],
    ['--config=prisma.config.ts', 'generate'],
    ['--config', 'migrate', 'generate'],
    ['--config', 'prisma.config.ts', '--schema', 'prisma/schema.prisma', 'generate'],
    ['--telemetry-information', 'metadata', 'generate'],
    ['--config', 'prisma.config.ts', '--version'],
    ['--config', 'prisma.config.ts', '--help'],
    ['generate', '--config', 'prisma.config.ts'],
  ])('allows offline commands with options: %j', (...args) => {
    expect(resolvePrismaDatasourceUrl({ NODE_ENV: 'test' }, cli(...args))).toBeUndefined();
  });

  it.each([
    ['migrate', 'deploy'],
    ['db', 'seed'],
    ['studio'],
    ['--config', 'prisma.config.ts', 'migrate', 'deploy'],
    ['--config=prisma.config.ts', 'migrate', 'deploy'],
    ['--config', 'generate', 'migrate', 'deploy'],
    ['--schema', 'generate', 'db', 'seed'],
    ['--telemetry-information', 'generate', 'studio'],
  ])(
    'requires DATABASE_URL for database command `prisma %s`',
    (...command) => {
      expect(() => resolvePrismaDatasourceUrl({ NODE_ENV: 'test' }, cli(...command))).toThrow(
        'Missing required environment variable: DATABASE_URL'
      );
    }
  );

  it('requires DATABASE_URL when the command cannot be identified', () => {
    expect(() => resolvePrismaDatasourceUrl({ NODE_ENV: 'test' }, ['node', 'loader'])).toThrow(
      'Missing required environment variable: DATABASE_URL'
    );
  });

  it('prefers a trimmed MIGRATION_DATABASE_URL over DATABASE_URL', () => {
    expect(
      resolvePrismaDatasourceUrl(
        {
          NODE_ENV: 'test',
          MIGRATION_DATABASE_URL: ' postgres://owner ',
          DATABASE_URL: 'postgres://app',
        },
        cli('migrate', 'deploy')
      )
    ).toBe('postgres://owner');
  });

  it('falls back to a trimmed DATABASE_URL for database and offline commands', () => {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: ' postgres://app ' };
    expect(resolvePrismaDatasourceUrl(environment, cli('migrate', 'deploy'))).toBe('postgres://app');
    expect(resolvePrismaDatasourceUrl(environment, cli('generate'))).toBe('postgres://app');
  });
});
