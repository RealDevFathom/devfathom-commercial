/**
 * Deployment environment for NODE_ENV=production servers. Staging and pilots also
 * run with NODE_ENV=production, so policy that differs between them (e.g. pharmacy
 * rule sets pending legal review) keys off APP_ENV. Production startup refuses to
 * serve unless it is set to a known value.
 */
export const APP_ENVS = ['production', 'staging', 'pilot'] as const;

export function assertProductionAppEnv(env: Record<string, string | undefined> = process.env) {
  const value = env.APP_ENV?.trim();
  if (!value || !(APP_ENVS as readonly string[]).includes(value)) {
    throw new Error(`APP_ENV must be one of ${APP_ENVS.join(', ')} on a production server.`);
  }
}
