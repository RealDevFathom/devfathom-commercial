// @vitest-environment node
/**
 * prisma/load-env.ts: the env loader shared by prisma.config.ts, the seeds and
 * the developer scripts (#311).
 *
 * Precedence must match Next.js: real process environment > .env.local > .env,
 * and a missing file is a silent no-op. `override: true` used to let
 * .env.local shadow variables exported by CI, a container or the shell.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Loader = typeof import('../prisma/load-env');

const directories: string[] = [];
function project(files: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'load-env-'));
  directories.push(directory);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body);
  return directory;
}

let loader: Loader;

beforeAll(async () => {
  // Importing the module loads env files from the working directory. Point that
  // at an empty directory so a developer's own .env.local never reaches this run.
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project());
  try {
    loader = await import('../prisma/load-env');
  } finally {
    cwd.mockRestore();
  }
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe('loadEnvFiles precedence', () => {
  it('never replaces a variable the process environment already holds', () => {
    const cwd = project({
      '.env.local': 'DATABASE_URL=postgresql://local/db\n',
      '.env': 'DATABASE_URL=postgresql://base/db\n',
    });
    const env: Record<string, string | undefined> = { DATABASE_URL: 'postgresql://exported/db' };

    loader.loadEnvFiles({ cwd, env });

    expect(env.DATABASE_URL).toBe('postgresql://exported/db');
  });

  it('treats an exported empty value as set, as Next.js does', () => {
    const cwd = project({ '.env.local': 'MIGRATION_DATABASE_URL=postgresql://local/db\n' });
    const env: Record<string, string | undefined> = { MIGRATION_DATABASE_URL: '' };

    loader.loadEnvFiles({ cwd, env });

    expect(env.MIGRATION_DATABASE_URL).toBe('');
  });

  it('lets .env.local beat .env and fills the rest from .env', () => {
    const cwd = project({
      '.env.local': 'SEED_PASSWORD=from-local\n',
      '.env': 'SEED_PASSWORD=from-base\nSHADOW_DATABASE_URL=postgresql://shadow/db\n',
    });
    const env: Record<string, string | undefined> = {};

    expect(loader.loadEnvFiles({ cwd, env })).toEqual(['.env.local', '.env']);
    expect(env).toEqual({
      SEED_PASSWORD: 'from-local',
      SHADOW_DATABASE_URL: 'postgresql://shadow/db',
    });
  });

  it('is a silent no-op when neither file exists', () => {
    const env: Record<string, string | undefined> = { KEEP: 'me' };
    const error = vi.spyOn(console, 'error');
    const log = vi.spyOn(console, 'log');

    expect(loader.loadEnvFiles({ cwd: project(), env })).toEqual([]);
    expect(env).toEqual({ KEEP: 'me' });
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    error.mockRestore();
    log.mockRestore();
  });

  it('reads .env alone when .env.local is absent', () => {
    const cwd = project({ '.env': 'DATABASE_URL=postgresql://base/db\n' });
    const env: Record<string, string | undefined> = {};

    expect(loader.loadEnvFiles({ cwd, env })).toEqual(['.env']);
    expect(env.DATABASE_URL).toBe('postgresql://base/db');
  });
});

describe('database URL resolution', () => {
  const both = ['MIGRATION_DATABASE_URL', 'DATABASE_URL'] as const;

  it('accepts MIGRATION_DATABASE_URL alone where the script prefers it', () => {
    expect(
      loader.databaseUrlFrom(both, {
        cwd: project(),
        env: { MIGRATION_DATABASE_URL: ' postgresql://migrate/db ' },
      })
    ).toBe('postgresql://migrate/db');
  });

  it('falls back to DATABASE_URL, skipping a blank MIGRATION_DATABASE_URL', () => {
    expect(
      loader.databaseUrlFrom(both, {
        cwd: project(),
        env: { MIGRATION_DATABASE_URL: '  ', DATABASE_URL: 'postgresql://app/db' },
      })
    ).toBe('postgresql://app/db');
  });

  it('prefers the first variable when both are set', () => {
    expect(
      loader.databaseUrlFrom(both, {
        cwd: project(),
        env: {
          MIGRATION_DATABASE_URL: 'postgresql://migrate/db',
          DATABASE_URL: 'postgresql://app/db',
        },
      })
    ).toBe('postgresql://migrate/db');
  });

  it('names every variable and file it searched when none is set', () => {
    const cwd = project({ '.env': 'AUTH_SECRET=x\n' });
    let caught: unknown;
    try {
      loader.databaseUrlFrom(both, { cwd, env: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(loader.MissingDatabaseUrlError);
    const message = (caught as Error).message;
    expect(message).toContain('MIGRATION_DATABASE_URL or DATABASE_URL');
    expect(message).toContain(`${resolve(cwd, '.env.local')} (not found)`);
    expect(message).toContain(resolve(cwd, '.env'));
    expect(message).not.toContain(`${resolve(cwd, '.env')} (not found)`);
  });

  it('accepts only the variables the calling script itself reads', () => {
    expect(() =>
      loader.databaseUrlFrom(['DATABASE_URL'], {
        cwd: project(),
        env: { MIGRATION_DATABASE_URL: 'postgresql://migrate/db' },
      })
    ).toThrow(/Set DATABASE_URL in the environment/);
  });
});

describe('as an entry point import, in a real process', () => {
  const tsx = resolve('node_modules/.bin/tsx');
  const loaderPath = resolve('prisma/load-env.ts');

  function run(cwd: string, source: string, env: Record<string, string>) {
    writeFileSync(join(cwd, 'probe.ts'), source);
    const inherited = { ...process.env };
    for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'PROBE_ONLY_IN_FILES']) {
      delete inherited[key];
    }
    return spawnSync(tsx, ['probe.ts'], {
      cwd,
      env: { ...inherited, ...env },
      encoding: 'utf8',
    });
  }

  it('loads the files before the next import reads them, without shadowing the shell', () => {
    const cwd = project({
      '.env.local': 'MIGRATION_DATABASE_URL=postgresql://local/db\nPROBE_ONLY_IN_FILES=local\n',
      '.env': 'DATABASE_URL=postgresql://base/db\nPROBE_ONLY_IN_FILES=base\n',
    });
    const result = run(
      cwd,
      `import ${JSON.stringify(loaderPath)};
console.log(JSON.stringify({
  migration: process.env.MIGRATION_DATABASE_URL,
  database: process.env.DATABASE_URL,
  only: process.env.PROBE_ONLY_IN_FILES,
}));
`,
      { MIGRATION_DATABASE_URL: 'postgresql://exported/db' }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      migration: 'postgresql://exported/db',
      database: 'postgresql://base/db',
      only: 'local',
    });
  }, 30_000);

  it('exits 1 with the variables and files instead of a connection error', () => {
    const cwd = project();
    const result = run(
      cwd,
      `import { requireDatabaseUrl } from ${JSON.stringify(loaderPath)};
requireDatabaseUrl(['MIGRATION_DATABASE_URL', 'DATABASE_URL']);
console.log('unreachable');
`,
      {}
    );

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('unreachable');
    expect(result.stderr).toContain('No database URL is configured');
    expect(result.stderr).toContain('MIGRATION_DATABASE_URL or DATABASE_URL');
    expect(result.stderr).toContain(join(cwd, '.env.local'));
    expect(result.stderr).not.toContain('ECONNREFUSED');
  }, 30_000);
});
