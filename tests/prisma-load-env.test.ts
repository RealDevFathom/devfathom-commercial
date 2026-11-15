import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadLocalEnv, requireDatabaseUrl } from '../prisma/load-env';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'load-env-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadLocalEnv', () => {
  it('reads .env.local when it is the only file', () => {
    writeFileSync(path.join(dir, '.env.local'), 'DATABASE_URL=postgresql://local:55439/db\n');
    const env: Record<string, string | undefined> = {};
    loadLocalEnv(dir, env);
    expect(env.DATABASE_URL).toBe('postgresql://local:55439/db');
  });

  it('gives .env.local precedence over .env and keeps .env-only keys', () => {
    writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgresql://env/db\nSEED_PASSWORD=from-env\n');
    writeFileSync(path.join(dir, '.env.local'), 'DATABASE_URL=postgresql://local/db\n');
    const env: Record<string, string | undefined> = {};
    loadLocalEnv(dir, env);
    expect(env.DATABASE_URL).toBe('postgresql://local/db');
    expect(env.SEED_PASSWORD).toBe('from-env');
  });

  it('never shadows variables already in the process environment', () => {
    writeFileSync(path.join(dir, '.env.local'), 'DATABASE_URL=postgresql://local/db\n');
    const env: Record<string, string | undefined> = { DATABASE_URL: 'postgresql://ci/db' };
    loadLocalEnv(dir, env);
    expect(env.DATABASE_URL).toBe('postgresql://ci/db');
  });

  it('is a no-op when neither file exists', () => {
    const env: Record<string, string | undefined> = {};
    loadLocalEnv(dir, env);
    expect(env).toEqual({});
  });
});

describe('requireDatabaseUrl', () => {
  it('prefers the first set name', () => {
    expect(
      requireDatabaseUrl(['MIGRATION_DATABASE_URL', 'DATABASE_URL'], {
        MIGRATION_DATABASE_URL: ' postgresql://mig/db ',
        DATABASE_URL: 'postgresql://app/db',
      })
    ).toBe('postgresql://mig/db');
    expect(
      requireDatabaseUrl(['MIGRATION_DATABASE_URL', 'DATABASE_URL'], {
        MIGRATION_DATABASE_URL: '  ',
        DATABASE_URL: 'postgresql://app/db',
      })
    ).toBe('postgresql://app/db');
  });

  it('throws naming the variables and files searched when unset', () => {
    expect(() => requireDatabaseUrl(['MIGRATION_DATABASE_URL', 'DATABASE_URL'], {}, dir)).toThrow(
      new RegExp(`MIGRATION_DATABASE_URL or DATABASE_URL is not set.*\\.env\\.local.*\\.env`)
    );
  });
});

describe('Prisma entry points use the shared loader', () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

  it.each([
    'prisma.config.ts',
    'prisma/seed.ts',
    'prisma/create-admin.ts',
    'prisma/bootstrap.ts',
    'prisma/reset-admin-password.ts',
  ])('%s calls loadLocalEnv and does not use dotenv directly', (file) => {
    const source = read(file);
    expect(source).toMatch(/\bloadLocalEnv\(\)/);
    expect(source).not.toMatch(/from 'dotenv'|'dotenv\/config'/);
  });

  it.each(['prisma/seed.ts', 'prisma/create-admin.ts', 'prisma/reset-admin-password.ts'])(
    '%s fails clearly instead of connecting to a default host',
    (file) => {
      expect(read(file)).toMatch(/connectionString: requireDatabaseUrl\(/);
    }
  );
});
