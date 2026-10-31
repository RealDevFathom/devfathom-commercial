import { resolve } from 'node:path';

import { config } from 'dotenv';

export const LOCAL_ENV_FILES = ['.env.local', '.env'] as const;

/** Load local files in Next.js order without replacing platform/CI variables. */
export function loadLocalEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): NodeJS.ProcessEnv {
  config({
    path: LOCAL_ENV_FILES.map((file) => resolve(cwd, file)),
    processEnv: environment,
    quiet: true,
  });
  return environment;
}

export function requireEnvironment(
  name: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Searched ${LOCAL_ENV_FILES.join(' and ')} (existing process environment variables take precedence).`
    );
  }
  return value;
}

/** Prisma CLI commands that never open a database connection. */
export const OFFLINE_PRISMA_COMMANDS = new Set(['generate', 'validate', 'format', 'version', 'help']);

function prismaCommand(argv: readonly string[]): string | undefined {
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    // Separate option values are paths/metadata, even if they match a command.
    // The --option=value form is already skipped by the flag check below.
    if (['--config', '--schema', '--telemetry-information'].includes(arg)) {
      index++;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

/**
 * Resolve the Prisma datasource URL. Database commands (migrate, db, studio, …)
 * fail fast without credentials; offline commands such as `prisma generate`
 * (postinstall, Docker builder) must keep working with no database configured.
 */
export function resolvePrismaDatasourceUrl(
  environment: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): string | undefined {
  const migrationUrl = environment['MIGRATION_DATABASE_URL']?.trim();
  if (migrationUrl) return migrationUrl;
  const command = prismaCommand(argv);
  const offline =
    command === undefined
      ? argv.some((arg) => ['-v', '--version', '-h', '--help'].includes(arg))
      : OFFLINE_PRISMA_COMMANDS.has(command);
  if (offline) return environment['DATABASE_URL']?.trim() || undefined;
  return requireEnvironment('DATABASE_URL', environment);
}

loadLocalEnvironment();
