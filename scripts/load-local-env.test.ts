import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadLocalEnvironment, requireEnvironment } from './load-local-env';

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

    const environment: NodeJS.ProcessEnv = {};
    loadLocalEnvironment(environment, directory);

    expect(environment.DATABASE_URL).toBe('from-dot-env-local');
    expect(environment.FALLBACK).toBe('from-dot-env');
  });

  it('falls back to .env when .env.local is absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devfathom-env-'));
    directories.push(directory);
    writeFileSync(join(directory, '.env'), 'DATABASE_URL=from-dot-env\n');

    const environment: NodeJS.ProcessEnv = {};
    loadLocalEnvironment(environment, directory);

    expect(environment.DATABASE_URL).toBe('from-dot-env');
  });

  it('loads .env.local when .env is absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devfathom-env-'));
    directories.push(directory);
    writeFileSync(join(directory, '.env.local'), 'DATABASE_URL=from-dot-env-local\n');

    const environment: NodeJS.ProcessEnv = {};
    loadLocalEnvironment(environment, directory);

    expect(environment.DATABASE_URL).toBe('from-dot-env-local');
  });

  it('never shadows variables supplied by the process environment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devfathom-env-'));
    directories.push(directory);
    writeFileSync(join(directory, '.env.local'), 'DATABASE_URL=from-file\n');

    const environment = { DATABASE_URL: 'from-platform' };
    loadLocalEnvironment(environment, directory);

    expect(environment.DATABASE_URL).toBe('from-platform');
  });

  it('names the missing variable and both searched files', () => {
    expect(() => requireEnvironment('DATABASE_URL', {})).toThrow(
      'Missing required environment variable: DATABASE_URL. Searched .env.local and .env'
    );
  });

  it('rejects a whitespace-only required variable', () => {
    expect(() => requireEnvironment('DATABASE_URL', { DATABASE_URL: '   ' })).toThrow(
      'Missing required environment variable: DATABASE_URL'
    );
  });
});
