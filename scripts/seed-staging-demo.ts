/**
 * Staging demo seed: one SuperAdmin plus the agency, pharmacy and restaurant
 * demo tenants. Idempotent; every step converges on a re-run.
 *
 *   bun scripts/seed-staging-demo.ts               seed everything
 *   bun scripts/seed-staging-demo.ts --skip-base   skip prisma/seed.ts (the
 *                                                  migrate task already ran it)
 *   bun scripts/seed-staging-demo.ts --logins-only write the logins file, no DB
 *
 * Passwords are never hard-coded. Each one is, in order: an explicit env var;
 * else derived from SEED_PASSWORD (HMAC-SHA256 per login, so the migrate task
 * and an operator holding the `seed-password` secret compute the same values
 * without any new secret plumbing); else random (local runs).
 * STAGING_LOGINS_FILE, when set, receives the logins with mode 0600.
 *
 * Database URLs: the admin URL (MIGRATION_DATABASE_URL, else DATABASE_URL) runs
 * prisma/seed.ts; the runtime URL (APP_DATABASE_URL, else DATABASE_URL) runs the
 * tenant seeds, which insist on a NOSUPERUSER NOBYPASSRLS role.
 */
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { assertStagingDemoTarget } from './pharmacy-e2e-environment';

const args = new Set(process.argv.slice(2));
const env = process.env;

function secret(label: string, override?: string): string {
  if (override?.trim()) return override.trim();
  const base = env.SEED_PASSWORD?.trim();
  const raw = base
    ? createHmac('sha256', base).update(`devfathom-staging-demo:${label}`).digest()
    : randomBytes(18);
  // URL-safe, 24 chars, with a guaranteed mix for password policies.
  return `${raw.toString('base64url').slice(0, 20)}a9#Q`;
}

const baseDomain = env.PLATFORM_BASE_DOMAIN?.trim() || 'staging.devfathom.com';
const logins = {
  superAdmin: {
    email: env.PLATFORM_ADMIN_EMAIL?.trim() || `platform-admin@${baseDomain}`,
    password: secret('platform-admin', env.PLATFORM_ADMIN_PASSWORD),
    url: `https://admin.${baseDomain}/platform`,
  },
  agency: {
    email:
      'alex@company.com (also jordan@, sam@, taylor@, casey@, riley@, morgan@, jamie@company.com)',
    password: secret('agency', env.SEED_PASSWORD),
    url: `https://devfathom.${baseDomain}/login`,
  },
  pharmacy: {
    email: env.STAGING_DEMO_PHARMACY_EMAIL?.trim() || `pharmacy.admin@${baseDomain}`,
    password: secret('pharmacy', env.STAGING_DEMO_PHARMACY_PASSWORD),
    url: `https://pharmacy-counter-e2e.${baseDomain}/login`,
    note: 'Same password for cashier.counter@ and pharmacist.counter@pharmacy-counter-e2e.devfathom.invalid',
  },
  restaurant: {
    accessCode: secret('restaurant-demo-access', env.DEMO_ACCESS_CODE),
    url: `https://${baseDomain}/demo/restaurants`,
    note: 'Passwordless demo seat 1; enter the access code, pick a persona. Web task needs DEMO_ACCESS_CODE set to this value.',
  },
};

function writeLogins(): void {
  const path = env.STAGING_LOGINS_FILE;
  if (!path) return;
  const body = [
    '# DevFathom staging demo logins',
    `Generated ${new Date().toISOString()}. Do not paste into chat.`,
    '',
    ...Object.entries(logins).map(
      ([name, v]) =>
        `## ${name}\n${Object.entries(v)
          .map(([k, x]) => `- ${k}: ${x}`)
          .join('\n')}\n`
    ),
  ].join('\n');
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`Logins written to ${path} (mode 600).`);
}

function run(label: string, cmd: string[], extra: Record<string, string>): void {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    stdio: 'inherit',
    env: { ...env, ...extra },
  });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status}).`);
}

async function main(): Promise<void> {
  // --grants-only must not rewrite the logins file (passwords may be random without SEED_PASSWORD).
  if (!args.has('--grants-only')) writeLogins();
  if (args.has('--logins-only')) return;

  const adminUrl = env.MIGRATION_DATABASE_URL?.trim() || env.DATABASE_URL;
  const appUrl = env.APP_DATABASE_URL?.trim() || env.DATABASE_URL;
  if (!adminUrl || !appUrl) throw new Error('Set DATABASE_URL (and APP_DATABASE_URL on AWS).');
  // Fail closed before touching anything unless both URLs are the staging database.
  assertStagingDemoTarget(adminUrl, env);
  assertStagingDemoTarget(appUrl, env);

  if (args.has('--grants-only')) {
    // Never fall back to a random password: a new demo pharmacist must get a known one,
    // and existing logins keep theirs (the seed does not rewrite passwords in this mode).
    if (!env.SEED_PASSWORD?.trim() && !env.STAGING_DEMO_PHARMACY_PASSWORD?.trim()) {
      throw new Error('--grants-only requires SEED_PASSWORD (or STAGING_DEMO_PHARMACY_PASSWORD).');
    }
    // Idempotent top-up of the demo pharmacy admin's explicit ALLOW grants for capabilities
    // wildcards no longer confer. Touches nothing else; still behind assertStagingDemoTarget.
    run('Pharmacy demo admin grants (top-up)', ['bun', 'scripts/seed-pharmacy-e2e.ts'], {
      STAGING_DEMO_SEED: '1',
      STAGING_DEMO_DATABASE_URL: appUrl,
      DATABASE_URL: appUrl,
      PHARMACY_E2E_GRANTS_ONLY: '1',
      PHARMACY_E2E_ADMIN_EMAIL: logins.pharmacy.email,
      PHARMACY_E2E_ADMIN_PASSWORD: logins.pharmacy.password,
    });
    console.log('\n✓ Staging demo grants top-up complete.');
    return;
  }

  if (!args.has('--skip-base')) {
    // SuperAdmin + agency (org_devfathom) + the full platform catalog, which
    // provisioning of every vertical from the platform console depends on.
    run('Base seed: SuperAdmin, agency workspace, catalog', ['bun', 'prisma/seed.ts'], {
      DATABASE_URL: adminUrl,
      MIGRATION_DATABASE_URL: adminUrl,
      SEED_PASSWORD: logins.agency.password,
      PLATFORM_ADMIN_EMAIL: logins.superAdmin.email,
      PLATFORM_ADMIN_PASSWORD: logins.superAdmin.password,
    });
  }

  run('Pharmacy tenant', ['bun', 'scripts/seed-pharmacy-e2e.ts'], {
    STAGING_DEMO_SEED: '1',
    STAGING_DEMO_DATABASE_URL: appUrl,
    DATABASE_URL: appUrl,
    PHARMACY_E2E_ADMIN_EMAIL: logins.pharmacy.email,
    PHARMACY_E2E_ADMIN_PASSWORD: logins.pharmacy.password,
  });

  run(
    'Restaurant demo seat (tax-inclusive)',
    ['bun', '--conditions=react-server', 'prisma/seed-demo/restaurant.ts'],
    { DATABASE_URL: appUrl, DEMO_SEATS: env.DEMO_SEATS || '1' }
  );

  console.log('\n✓ Staging demo seed complete.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
