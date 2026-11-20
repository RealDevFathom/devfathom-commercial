/**
 * DEV-503 measurement guard, stricter than the shared pharmacy E2E guard.
 *
 * `pharmacyE2eEnvironment()` also admits the staging demo seed (STAGING_DEMO_SEED=1),
 * and it validates its own URL rather than the DATABASE_URL that `withTenantDb` and
 * `next start` actually read. The DEV-503 tooling must only ever touch a disposable
 * database on this machine, so this refuses staging mode outright, requires the E2E
 * opt-in and a loopback host, and requires DATABASE_URL to be exactly the guarded URL.
 */
import { pharmacyE2eEnvironment } from './pharmacy-e2e-environment';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function dev503MeasurementEnvironment(
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  for (const name of ['STAGING_DEMO_SEED', 'DEPLOY_ENV'] as const) {
    if (env[name] !== undefined) {
      throw new Error(
        `Refusing the DEV-503 tooling: ${name} is set; it runs on local databases only.`
      );
    }
  }
  if (env.PHARMACY_E2E !== '1') throw new Error('PHARMACY_E2E=1 explicit opt-in is required.');
  const guarded = pharmacyE2eEnvironment(env);
  const target = new URL(guarded.DATABASE_URL!);
  if (!LOOPBACK_HOSTS.has(target.hostname)) {
    throw new Error('Refusing the DEV-503 tooling: the database host must be loopback.');
  }
  if (!env.DATABASE_URL || new URL(env.DATABASE_URL).href !== target.href) {
    throw new Error('DATABASE_URL must equal PHARMACY_E2E_DATABASE_URL exactly.');
  }
  return guarded;
}
