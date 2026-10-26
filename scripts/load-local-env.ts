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

loadLocalEnvironment();
