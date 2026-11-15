// Local env loading for Prisma CLI and the prisma/*.ts scripts, matching Next.js:
// variables already in the process environment win, then .env.local, then .env.
// Hosted builds and CI set real variables, and a stray file never shadows them.
import path from 'node:path';
import { config } from 'dotenv';

export const LOCAL_ENV_FILES = ['.env.local', '.env'] as const;

type Env = Record<string, string | undefined>;

export function loadLocalEnv(
  cwd: string = process.cwd(),
  env: Env = process.env as Env
): readonly string[] {
  const files = LOCAL_ENV_FILES.map((file) => path.join(cwd, file));
  // dotenv never overrides keys already present, and for a path list the first file wins.
  config({ path: files, processEnv: env as NodeJS.ProcessEnv, quiet: true });
  return files;
}

/** Returns the first set variable among `names`, or throws naming them and the files searched. */
export function requireDatabaseUrl(
  names: readonly string[],
  env: Env = process.env as Env,
  cwd: string = process.cwd()
): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  const searched = LOCAL_ENV_FILES.map((file) => path.join(cwd, file)).join(', ');
  throw new Error(
    `${names.join(' or ')} is not set. Export it or add it to one of: ${searched}. ` +
      'Refusing to connect to an unconfigured default database host.'
  );
}
