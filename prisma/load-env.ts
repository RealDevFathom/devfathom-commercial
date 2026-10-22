import { config } from 'dotenv';

export const LOCAL_ENV_FILES = ['.env.local', '.env'] as const;

/** Load local files in Next.js order without replacing platform-provided values. */
export function loadLocalEnvironment(
  paths: readonly string[] = LOCAL_ENV_FILES,
  processEnv: NodeJS.ProcessEnv = process.env
): void {
  config({ path: [...paths], processEnv, quiet: true });
}

export function requiredEnvironmentVariable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}; checked the existing environment, .env.local, and .env.`
    );
  }
  return value;
}

loadLocalEnvironment();
