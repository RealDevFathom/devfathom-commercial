import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type Environment = Record<string, string | undefined>;
export type FreshDatabaseInput = {
  databaseUrl: string;
  target: string;
  runtimeDatabaseUrl: string;
  platformAdminName: string;
  platformAdminEmail: string;
  platformAdminPassword: string;
};
export type MigrationPin = { name: string; sha256: string };

export type FreshPlatformTransaction = {
  $executeRawUnsafe(query: string): Promise<unknown>;
  $queryRawUnsafe<T>(query: string): Promise<T>;
  platformUser: {
    findMany(args: {
      select: { id: true; email: true; role: true; active: true };
    }): Promise<Array<{ id: string; email: string; role: string; active: boolean }>>;
    create(args: {
      data: {
        name: string;
        email: string;
        passwordHash: string;
        role: 'SUPER_ADMIN';
        active: true;
      };
    }): Promise<unknown>;
  };
};

/** Errors must escape the owning transaction, including catalogue and hashing failures. */
export async function initializeFreshPlatform(
  tx: FreshPlatformTransaction,
  input: FreshDatabaseInput,
  syncCatalog: () => Promise<{
    modulesCreated: number;
    packagesCreated: number;
    linksCreated: number;
  }>,
  hashPassword: (password: string) => Promise<string>,
  guard: FreshDatabaseGuard
) {
  assertGuard(guard);
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(1531, 120)');
  await tx.$executeRawUnsafe("SELECT set_config('app.is_platform_admin', 'true', true)");
  const observation = await observeGuardedState(tx, input, guard);
  const existing = await tx.platformUser.findMany({
    select: { id: true, email: true, role: true, active: true },
  });
  if (
    existing.length > 1 ||
    (existing.length === 1 &&
      (existing[0].email.toLowerCase() !== input.platformAdminEmail ||
        existing[0].role !== 'SUPER_ADMIN' ||
        !existing[0].active))
  )
    throw new Error('Platform state does not match the fresh initializer.');
  const expectedCatalog =
    existing.length === 0
      ? guard.baseline.migratedCatalogSha256
      : guard.baseline.initializedCatalogSha256;
  if (observation.catalogSha256 !== expectedCatalog)
    throw new Error('Fresh database catalog baseline rejected.');
  const catalog = await syncCatalog();
  if (existing.length === 0) {
    await tx.platformUser.create({
      data: {
        name: input.platformAdminName,
        email: input.platformAdminEmail,
        passwordHash: await hashPassword(input.platformAdminPassword),
        role: 'SUPER_ADMIN',
        active: true,
      },
    });
  }
  return { administratorCreated: existing.length === 0, ...catalog };
}

function required(env: Environment, key: string): string {
  const value = env[key];
  if (!value || !value.trim()) throw new Error(`Missing ${key}.`);
  return value;
}

function databaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
    decodeURIComponent(url.password);
    decodeURIComponent(url.username);
  } catch {
    throw new Error('Invalid database URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    !/^\/[A-Za-z][A-Za-z0-9_]*$/.test(url.pathname) ||
    url.hash ||
    url.searchParams.get('sslmode') !== 'verify-full' ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
    url.searchParams.getAll('sslmode').length !== 1
  )
    throw new Error('Require an explicit database URL with credentials and verify-full TLS.');
  return url;
}

/** Validation only: no environment loading, credential generation, connection, or logging. */
export function readFreshDatabaseInput(env: Environment): FreshDatabaseInput {
  const admin = databaseUrl(required(env, 'DATABASE_URL'));
  const runtime = databaseUrl(required(env, 'APP_DATABASE_URL'));
  if (
    admin.hostname !== runtime.hostname ||
    (admin.port || '5432') !== (runtime.port || '5432') ||
    admin.pathname !== runtime.pathname ||
    decodeURIComponent(runtime.username) !== 'devfathom_app' ||
    decodeURIComponent(admin.username) === decodeURIComponent(runtime.username)
  )
    throw new Error('Require separate migration/runtime identities on the same database.');
  if (
    required(env, 'FRESH_DATABASE_TARGET') !==
    `${admin.hostname}:${admin.port || '5432'}${admin.pathname}`
  )
    throw new Error('Fresh database target confirmation does not match.');
  const platformAdminPassword = required(env, 'PLATFORM_ADMIN_PASSWORD');
  // bcrypt truncates after 72 bytes; reject instead of silently weakening the supplied secret.
  if (platformAdminPassword.trim().length < 12 || Buffer.byteLength(platformAdminPassword) > 72)
    throw new Error(
      'Platform administrator password must be 12 or more characters and at most 72 bytes.'
    );
  const platformAdminEmail = required(env, 'PLATFORM_ADMIN_EMAIL').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(platformAdminEmail))
    throw new Error('Invalid platform administrator email.');
  return {
    databaseUrl: admin.toString(),
    target: required(env, 'FRESH_DATABASE_TARGET'),
    runtimeDatabaseUrl: runtime.toString(),
    platformAdminName: required(env, 'PLATFORM_ADMIN_NAME').trim(),
    platformAdminEmail,
    platformAdminPassword,
  };
}

/** Pure file verification. Never inspect excluded tests or connect to a database. */
export function verifyFreshDatabaseSource(root: string): MigrationPin[] {
  const manifestBytes = readFileSync(join(root, 'prisma/fresh-database-manifest.json'));
  // Independent pin: changing SQL and the manifest together must still fail closed.
  if (
    createHash('sha256').update(manifestBytes).digest('hex') !==
    '3d2e26877511b24de13d0ce9f830ef5fe77728a344587b0b446718c9431205ac'
  )
    throw new Error('Fresh database manifest identity mismatch.');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    schemaSha256: string;
    migrations: MigrationPin[];
  };
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (
    manifest.schemaSha256 !== '3e7ae969bf6548aa6633c56799cc7ed721bb03009e19ca4fafd707cb1dc14729' ||
    digest(join(root, 'prisma/schema.prisma')) !== manifest.schemaSha256
  )
    throw new Error('Fresh database schema pin mismatch.');
  const directory = join(root, 'prisma/migrations');
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (
    manifest.migrations.length !== 120 ||
    new Set(manifest.migrations.map((pin) => pin.name)).size !== 120 ||
    JSON.stringify(names) !== JSON.stringify(manifest.migrations.map((pin) => pin.name).sort())
  )
    throw new Error('Fresh database migration inventory mismatch.');
  for (const pin of manifest.migrations) {
    if (
      !/^\d{14}_[a-z0-9_]+$/.test(pin.name) ||
      digest(join(directory, pin.name, 'migration.sql')) !== pin.sha256
    )
      throw new Error('Fresh database migration checksum mismatch.');
  }
  return manifest.migrations;
}

export type RuntimeRole = {
  current_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolcanlogin: boolean;
};

export function assertFreshRuntimeRole(role: RuntimeRole): void {
  if (
    role.current_user !== 'devfathom_app' ||
    role.rolsuper !== false ||
    role.rolbypassrls !== false ||
    role.rolcreatedb !== false ||
    role.rolcreaterole !== false ||
    role.rolinherit !== false ||
    role.rolcanlogin !== true
  )
    throw new Error('Runtime role posture rejected.');
}

export function assertFreshMigrationLedger(
  expected: MigrationPin[],
  rows: Array<{
    migration_name: string;
    checksum: string;
    finished_at: unknown;
    rolled_back_at: unknown;
  }>
): void {
  if (
    rows.length !== expected.length ||
    expected.some((pin) => {
      const matches = rows.filter((row) => row.migration_name === pin.name);
      return (
        matches.length !== 1 ||
        matches[0].checksum !== pin.sha256 ||
        !matches[0].finished_at ||
        matches[0].rolled_back_at !== null
      );
    })
  )
    throw new Error('Fresh database migration ledger rejected.');
}

/** Offline plan only. Schema mutation needs the deployment owner's separate execution gate. */
export function freshDatabasePlan(root: string) {
  const migrations = verifyFreshDatabaseSource(root);
  return {
    mode: 'source-only',
    migrationCount: migrations.length,
    schemaSha256: '3e7ae969bf6548aa6633c56799cc7ed721bb03009e19ca4fafd707cb1dc14729',
    phases: [
      'owner verifies empty target and provisioned restricted runtime role',
      'owner reviews extension preparation and managed-owner hardening exceptions',
      'owner runs pinned Prisma migrate deploy (never seed/reset/db push)',
      'verify exact migration ledger and authenticated runtime role posture',
      'transactional catalog and platform administrator bootstrap',
    ],
    holds: [
      'migration 20260728090000_admin_platform_tenancy inserts org_devfathom',
      'AWS execution adapter and live database verification are not admitted in this phase',
    ],
    referenceMedicines: 'Medlist18933 remains staged/unverified; no import or stock publication',
  };
}

/** Deployment-owner reviewed snapshots, never inferred from the database being initialized.
 * Operational digest covers ALL non-catalog/non-platform-user application state, including
 * organization rows. Same digest is required on initial bootstrap and replay. No default shell
 * exception is supplied here. Catalog digests describe exact migrated and initialized phases.
 */
export type FreshDatabaseBaseline = {
  operationalSha256: string;
  migratedCatalogSha256: string;
  initializedCatalogSha256: string;
};
export type FreshDatabaseObservation = {
  target: string;
  tlsServerIdentityVerified: boolean;
  completeVisibility: boolean;
  operationalSha256: string;
  catalogSha256: string;
};
export type FreshDatabaseGuard = {
  sourceRoot: string;
  baseline: FreshDatabaseBaseline;
  /** Trusted deployment adapter, observing THIS transaction, not caller-supplied cached values.
   * Must prove endpoint/TLS binding and complete table visibility despite RLS, and fingerprint
   * all operational state. A runtime filtered count of zero is insufficient. No adapter or
   * approved baseline exists in this source phase; absent evidence refuses bootstrap.
   */
  observe(tx: FreshPlatformTransaction): Promise<FreshDatabaseObservation>;
};
function assertGuard(guard: FreshDatabaseGuard): void {
  if (
    !guard ||
    typeof guard.observe !== 'function' ||
    !guard.sourceRoot ||
    !guard.baseline ||
    ![
      guard.baseline.operationalSha256,
      guard.baseline.migratedCatalogSha256,
      guard.baseline.initializedCatalogSha256,
    ].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
  )
    throw new Error('Trusted fresh database binding and approved baseline required.');
}
async function observeGuardedState(
  tx: FreshPlatformTransaction,
  input: FreshDatabaseInput,
  guard: FreshDatabaseGuard
): Promise<FreshDatabaseObservation> {
  // Query the authenticated identity through the owning Prisma transaction. No URL-only proof.
  try {
    const identities = await tx.$queryRawUnsafe<Array<RuntimeRole & { database_name: string }>>(
      `SELECT current_database() AS database_name, current_user,
       rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin
       FROM pg_catalog.pg_roles WHERE rolname = current_user`
    );
    if (
      identities.length !== 1 ||
      identities[0].database_name !== new URL(input.runtimeDatabaseUrl).pathname.slice(1)
    )
      throw new Error('identity');
    assertFreshRuntimeRole(identities[0]);
    const pins = verifyFreshDatabaseSource(guard.sourceRoot);
    const ledger = await tx.$queryRawUnsafe<
      Array<{
        migration_name: string;
        checksum: string;
        finished_at: unknown;
        rolled_back_at: unknown;
      }>
    >(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations'
    );
    assertFreshMigrationLedger(pins, ledger);
    const observed = await guard.observe(tx);
    if (
      observed.target !== input.target ||
      observed.tlsServerIdentityVerified !== true ||
      observed.completeVisibility !== true ||
      observed.operationalSha256 !== guard.baseline.operationalSha256
    )
      throw new Error('observation');
    return observed;
  } catch {
    // Abort the owning transaction; adapters/driver errors may contain credentials or payloads.
    throw new Error('Fresh database authenticated target or state verification failed.');
  }
}

export type FreshDatabaseClient<Tx extends FreshPlatformTransaction> = {
  $transaction<T>(
    body: (tx: Tx) => Promise<T>,
    options: {
      maxWait: number;
      timeout: number;
      isolationLevel: 'Serializable';
    }
  ): Promise<T>;
};

/** Pure orchestration seam; factory MUST construct a private client using the supplied URL
 * through the existing Prisma adapter contract. It owns cleanup. Never pass a global client.
 * Real endpoint/TLS/visibility proof remains the trusted adapter's responsibility.
 */
export async function runBoundFreshBootstrap<Tx extends FreshPlatformTransaction>(
  factory: (runtimeDatabaseUrl: string) => Promise<FreshDatabaseClient<Tx>>,
  env: Environment,
  guard: FreshDatabaseGuard,
  syncCatalog: (
    tx: Tx
  ) => Promise<{ modulesCreated: number; packagesCreated: number; linksCreated: number }>,
  hashPassword: (password: string) => Promise<string>
) {
  const input = readFreshDatabaseInput(env);
  assertGuard(guard);
  verifyFreshDatabaseSource(guard.sourceRoot);
  if (typeof factory !== 'function') throw new Error('Validated runtime client factory required.');
  try {
    const prisma = await factory(input.runtimeDatabaseUrl);
    return await prisma.$transaction(
      (tx) => initializeFreshPlatform(tx, input, () => syncCatalog(tx), hashPassword, guard),
      { maxWait: 30_000, timeout: 300_000, isolationLevel: 'Serializable' }
    );
  } catch {
    // A rejected transaction is never converted to success; no driver error text escapes.
    throw new Error('Fresh database bootstrap failed; owning transaction must roll back.');
  }
}
