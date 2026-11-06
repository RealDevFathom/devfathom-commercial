/**
 * The one environment loader for the Prisma CLI config, the seeds and the
 * developer scripts.
 *
 * Precedence matches Next.js: a variable that is already in the process
 * environment (a shell export, CI, a container) always wins, then
 * `.env.local`, then `.env`. Files are read from the current working directory
 * and a missing file is a silent no-op, so a container that injects its whole
 * environment and ships no env file behaves exactly as before.
 *
 * Importing this module loads the files once, as a side effect. An entry point
 * must import it BEFORE any module that reads the environment while it is being
 * evaluated: imports run in source order, so make it the first import.
 *
 *   import './load-env.js';            // prisma/*.ts
 *   import '../prisma/load-env';       // scripts/*.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'dotenv';

/** Highest precedence first: a key found in an earlier file is never replaced. */
export const ENV_FILES = ['.env.local', '.env'] as const;

/** URL variables the seed and the Prisma CLI accept, in the order they prefer them. */
export const MIGRATION_DATABASE_URL_VARIABLES = ['MIGRATION_DATABASE_URL', 'DATABASE_URL'] as const;

type Environment = Record<string, string | undefined>;

export type LoadEnvOptions = {
  /** Directory holding the env files. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment to fill. Defaults to `process.env`. */
  env?: Environment;
};

/**
 * Fills `env` from `.env.local`, then `.env`, without replacing any key that is
 * already defined (an empty string counts as defined, as in Next.js). Returns
 * the files that were found.
 */
export function loadEnvFiles({ cwd = process.cwd(), env = process.env }: LoadEnvOptions = {}) {
  const loaded: string[] = [];
  for (const file of ENV_FILES) {
    let source: string;
    try {
      source = readFileSync(resolve(cwd, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    loaded.push(file);
    for (const [key, value] of Object.entries(parse(source))) {
      if (env[key] === undefined) env[key] = value;
    }
  }
  return loaded;
}

export class MissingDatabaseUrlError extends Error {
  constructor(variables: readonly string[], cwd: string) {
    const searched = ENV_FILES.map((file) => {
      const path = resolve(cwd, file);
      return existsSync(path) ? path : `${path} (not found)`;
    });
    super(
      `No database URL is configured. Set ${variables.join(' or ')} in the environment, ` +
        `or in .env.local or .env. Searched the process environment, then ${searched.join(', then ')}.`
    );
    this.name = 'MissingDatabaseUrlError';
  }
}

/**
 * The first of `variables` that holds a non-blank value. Throws
 * {@link MissingDatabaseUrlError}, naming every variable and file it looked in,
 * when none does — instead of letting `pg` fall back to localhost and fail with
 * a bare ECONNREFUSED.
 */
export function databaseUrlFrom(
  variables: readonly string[],
  { cwd = process.cwd(), env = process.env }: LoadEnvOptions = {}
): string {
  for (const name of variables) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new MissingDatabaseUrlError(variables, cwd);
}

/** {@link databaseUrlFrom} for script entry points: prints the error and exits 1. */
export function requireDatabaseUrl(variables: readonly string[]): string {
  try {
    return databaseUrlFrom(variables);
  } catch (error) {
    if (!(error instanceof MissingDatabaseUrlError)) throw error;
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}

loadEnvFiles();
