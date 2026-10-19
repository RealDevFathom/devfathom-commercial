import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma } from '../src/generated/prisma/client.js';
import {
  bootstrapProduction,
  productionBootstrapInputFromEnvironment,
  type RestaurantBootstrapInput,
} from './production-bootstrap.js';

type Environment = Record<string, string | undefined>;
export type FreshDatabaseInput = {
  target: string;
  runtimeDatabaseUrl: string;
  restaurant: RestaurantBootstrapInput;
};
export type MigrationPin = { name: string; sha256: string };
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
  if (env.BOOTSTRAP_MODE !== 'RESTAURANT')
    throw new Error('Explicit BOOTSTRAP_MODE=RESTAURANT required.');
  const restaurant = productionBootstrapInputFromEnvironment(env);
  if (restaurant.mode !== 'RESTAURANT') throw new Error('Restaurant input required.');
  for (const key of ['ADMIN_PASSWORD', 'PLATFORM_ADMIN_PASSWORD']) {
    const password = required(env, key);
    if (password.trim().length < 12 || Buffer.byteLength(password) > 72)
      throw new Error('Administrator passwords require 12 characters and at most 72 bytes.');
  }
  return {
    target: required(env, 'FRESH_DATABASE_TARGET'),
    runtimeDatabaseUrl: runtime.toString(),
    restaurant,
  };
}

/** Pure file verification. Never inspect excluded tests or connect to a database. */
export function verifyFreshDatabaseSource(root: string): MigrationPin[] {
  const manifestBytes = readFileSync(join(root, 'prisma/fresh-database-manifest.json'));
  // Independent pin: changing SQL and the manifest together must still fail closed.
  if (
    createHash('sha256').update(manifestBytes).digest('hex') !==
    '921aa916eb6769837698162f3a35ba549d8b928387ab01dc29a83732f7e1aa9b'
  )
    throw new Error('Fresh database manifest identity mismatch.');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    schemaSha256: string;
    migrations: MigrationPin[];
  };
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (
    manifest.schemaSha256 !== 'ff78e69786f061c2a40915df4b81bcc31eeb88e34c24288299ded3016763bbc8' ||
    digest(join(root, 'prisma/schema.prisma')) !== manifest.schemaSha256
  )
    throw new Error('Fresh database schema pin mismatch.');
  const directory = join(root, 'prisma/migrations');
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (
    manifest.migrations.length !== 126 ||
    new Set(manifest.migrations.map((pin) => pin.name)).size !== 126 ||
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
  rolreplication: boolean;
  membership_count: number;
};

export function assertFreshRuntimeRole(role: RuntimeRole): void {
  if (
    role.current_user !== 'devfathom_app' ||
    role.rolsuper !== false ||
    role.rolbypassrls !== false ||
    role.rolcreatedb !== false ||
    role.rolcreaterole !== false ||
    role.rolinherit !== false ||
    role.rolcanlogin !== true ||
    role.rolreplication !== false ||
    role.membership_count !== 0
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
    schemaSha256: 'ff78e69786f061c2a40915df4b81bcc31eeb88e34c24288299ded3016763bbc8',
    phases: [
      'owner verifies empty target and provisioned restricted runtime role',
      'owner reviews extension preparation and managed-owner hardening exceptions',
      'owner runs pinned Prisma migrate deploy (never seed/reset/db push)',
      'verify exact migration ledger and authenticated runtime role posture',
      'one guarded canonical Restaurant organization/package/administrator transaction',
    ],
    holds: [
      'migration 20260728090000_admin_platform_tenancy inserts org_devfathom',
      'AWS execution adapter and live database verification are not admitted in this phase',
    ],
  };
}

export type FreshDatabaseState = { operationalSha256: string; catalogSha256: string };
/** Exact reviewed snapshots, never learned from the target. COMPLETED may be separately
 * reviewed after legitimate demotion/status/password/permission/entitlement changes.
 * Fingerprint plan covers every row, including the historical org_devfathom shell and
 * departments. Only generated IDs/timestamps/hash bytes use reviewed structural normalization;
 * no table-wide tenant exemption. See FRESH_DB_HANDOFF.md for the required plan semantics.
 */
export type FreshDatabaseBaseline = {
  reviewId: string;
  intentSha256: string;
  fingerprintPlanSha256: string;
  postureSha256: string;
  initial: FreshDatabaseState;
  completed: FreshDatabaseState;
};
export type FreshDatabaseEndpoint = {
  hostname: string;
  port: number;
  database: string;
  tlsServerName: string;
  caSha256: string;
};
export type FreshDatabaseObservation = FreshDatabaseState & {
  phase: 'INITIAL' | 'COMPLETED';
  target: string;
  endpoint: FreshDatabaseEndpoint;
  tlsServerIdentityVerified: boolean;
  completeVisibility: boolean;
  fingerprintPlanSha256: string;
  postureSha256: string;
};
export type FreshDatabaseGuard = {
  sourceRoot: string;
  endpoint: FreshDatabaseEndpoint;
  baseline: FreshDatabaseBaseline;
  /** Trusted adapter must measure THIS transaction with complete visibility despite RLS.
   * Includes actual grants, role memberships, FORCE RLS and extensions in postureSha256.
   * Filtered zero rows, cached observations and target-derived approvals are not evidence.
   */
  observe(tx: Prisma.TransactionClient): Promise<FreshDatabaseObservation>;
};

/** Public identity only; never includes URLs, passwords or password hashes. */
export function freshDatabaseIntentSha256(input: FreshDatabaseInput): string {
  const r = input.restaurant;
  return createHash('sha256')
    .update(
      JSON.stringify([
        r.mode,
        r.organizationId,
        r.organizationSlug,
        r.organizationLegalName,
        r.organizationDisplayName,
        r.packageKey,
        r.adminId,
        r.adminName,
        r.adminEmail,
        r.adminTitle,
        r.platformAdminId,
        r.platformAdminName,
        r.platformAdminEmail,
      ])
    )
    .digest('hex');
}

function assertGuard(guard: FreshDatabaseGuard, input: FreshDatabaseInput): void {
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const url = new URL(input.runtimeDatabaseUrl);
  if (
    !guard ||
    typeof guard.observe !== 'function' ||
    !guard.sourceRoot ||
    !guard.baseline?.reviewId?.trim() ||
    !guard.endpoint ||
    guard.endpoint.hostname !== url.hostname ||
    guard.endpoint.port !== Number(url.port || '5432') ||
    guard.endpoint.database !== url.pathname.slice(1) ||
    !guard.endpoint.tlsServerName?.trim() ||
    !digest(guard.endpoint.caSha256) ||
    guard.baseline.intentSha256 !== freshDatabaseIntentSha256(input) ||
    ![
      guard.baseline.fingerprintPlanSha256,
      guard.baseline.postureSha256,
      guard.baseline.initial?.operationalSha256,
      guard.baseline.initial?.catalogSha256,
      guard.baseline.completed?.operationalSha256,
      guard.baseline.completed?.catalogSha256,
    ].every(digest)
  )
    throw new Error('Reviewed endpoint, CA, intent, binding and phase baselines required.');
}

async function observeGuardedState(
  tx: Prisma.TransactionClient,
  input: FreshDatabaseInput,
  guard: FreshDatabaseGuard,
  pins: MigrationPin[]
): Promise<FreshDatabaseObservation> {
  const identities = await tx.$queryRawUnsafe<Array<RuntimeRole & { database_name: string }>>(
    `SELECT current_database() AS database_name, current_user,
     rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin, rolreplication,
     (SELECT count(*)::int FROM pg_catalog.pg_auth_members WHERE member = r.oid) AS membership_count
     FROM pg_catalog.pg_roles r WHERE rolname = current_user`
  );
  if (identities.length !== 1 || identities[0].database_name !== guard.endpoint.database)
    throw new Error('Authenticated database identity rejected.');
  assertFreshRuntimeRole(identities[0]);
  const ledger = await tx.$queryRawUnsafe<
    Array<{
      migration_name: string;
      checksum: string;
      finished_at: unknown;
      rolled_back_at: unknown;
    }>
  >('SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations');
  assertFreshMigrationLedger(pins, ledger);
  const observed = await guard.observe(tx);
  const expected =
    observed?.phase === 'INITIAL'
      ? guard.baseline.initial
      : observed?.phase === 'COMPLETED'
        ? guard.baseline.completed
        : undefined;
  if (
    !expected ||
    observed.target !== input.target ||
    observed.tlsServerIdentityVerified !== true ||
    observed.completeVisibility !== true ||
    !observed.endpoint ||
    (Object.keys(guard.endpoint) as Array<keyof FreshDatabaseEndpoint>).some(
      (key) => observed.endpoint[key] !== guard.endpoint[key]
    ) ||
    observed.fingerprintPlanSha256 !== guard.baseline.fingerprintPlanSha256 ||
    observed.postureSha256 !== guard.baseline.postureSha256 ||
    observed.operationalSha256 !== expected.operationalSha256 ||
    observed.catalogSha256 !== expected.catalogSha256
  )
    throw new Error('Authenticated target, TLS, visibility or reviewed state rejected.');
  return observed;
}

export type FreshDatabaseClient = {
  $transaction<T>(
    body: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { maxWait: number; timeout: number; isolationLevel: 'Serializable' }
  ): Promise<T>;
};
export type FreshDatabaseLease = {
  connect(): Promise<FreshDatabaseClient>;
  /** Must cancel pending connection/SQL, prevent a later commit, and settle all owned work.
   * Idempotent; valid even before connect() resolves. Never resolves while mutation can continue.
   */
  cancelAndDrain(): Promise<void>;
  /** Always release the private Prisma client AND driver pool, including partial connect failure. */
  close(): Promise<void>;
};
export type FreshDatabaseFactory = {
  contract: 'private-runtime-client-cancel-drain-v1';
  /** Synchronous lease allocation; no connection until connect(). On allocation throw, clean up.
   * Enforce deadline at the driver/commit boundary, not just JavaScript timer delivery.
   * Never use a global client or the migration URL. Concrete implementation: fresh-database-adapter.ts.
   */
  create(
    runtimeDatabaseUrl: string,
    control: {
      signal: AbortSignal;
      deadlineAt: number;
      endpoint: FreshDatabaseEndpoint;
    }
  ): FreshDatabaseLease;
};

/** One private client, one serializable transaction, one unchanged canonical writer.
 * No detached Promise.race: cancellation and work settlement precede cleanup and rejection.
 * An adapter violating settlement may hang; source cannot safely manufacture a timeout result.
 */
export async function runBoundFreshBootstrap(
  factory: FreshDatabaseFactory,
  env: Environment,
  suppliedGuard: FreshDatabaseGuard,
  deadlineMs: number,
  hashPassword: (password: string) => Promise<string>
) {
  const startedAt = Date.now();
  let lease: FreshDatabaseLease | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellation: Promise<void> | undefined;
  let cancellationFailed = false;
  let failed = false;
  let result: { phase: 'INITIAL' | 'COMPLETED' } | undefined;
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    if (lease && !cancellation) {
      cancellation = Promise.resolve()
        .then(() => lease!.cancelAndDrain())
        .catch(() => {
          cancellationFailed = true;
        });
    }
  };
  try {
    const input = readFreshDatabaseInput(env);
    assertGuard(suppliedGuard, input);
    const guard = {
      ...suppliedGuard,
      endpoint: { ...suppliedGuard.endpoint },
      baseline: structuredClone(suppliedGuard.baseline),
    };
    const pins = verifyFreshDatabaseSource(guard.sourceRoot);
    if (
      !factory ||
      factory.contract !== 'private-runtime-client-cancel-drain-v1' ||
      typeof factory.create !== 'function' ||
      typeof hashPassword !== 'function' ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 330_000
    )
      throw new Error('Private factory and bounded runner deadline required.');
    const deadlineAt = startedAt + deadlineMs;
    const checkDeadline = () => {
      if (Date.now() >= deadlineAt) cancel();
      if (controller.signal.aborted) throw new Error('Deadline reached.');
    };
    checkDeadline();
    lease = factory.create(input.runtimeDatabaseUrl, {
      signal: controller.signal,
      deadlineAt,
      endpoint: { ...guard.endpoint },
    });
    if (
      !lease ||
      typeof lease.connect !== 'function' ||
      typeof lease.close !== 'function' ||
      typeof lease.cancelAndDrain !== 'function'
    )
      throw new Error('Invalid private lease.');
    timer = setTimeout(cancel, Math.max(1, deadlineAt - Date.now()));
    checkDeadline();
    const client = await lease.connect();
    checkDeadline();
    result = await client.$transaction(
      async (tx) => {
        checkDeadline();
        // Same lock as the canonical writer; its later acquisition is transaction-reentrant.
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(734219061)');
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.is_platform_admin', 'true', true),
                set_config('app.current_organization_id', $1, true)`,
          input.restaurant.organizationId
        );
        const before = await observeGuardedState(tx, input, guard, pins);
        checkDeadline();
        await bootstrapProduction(tx, input.restaurant, hashPassword);
        checkDeadline();
        const after = await observeGuardedState(tx, input, guard, pins);
        if (after.phase !== 'COMPLETED') throw new Error('Completed baseline required.');
        checkDeadline();
        return { phase: before.phase };
      },
      {
        maxWait: Math.min(30_000, Math.max(1, deadlineAt - Date.now())),
        timeout: Math.min(300_000, Math.max(1, deadlineAt - Date.now())),
        isolationLevel: 'Serializable',
      }
    );
    checkDeadline();
  } catch {
    failed = true;
    cancel();
  } finally {
    // Keep deadline active through settlement and cleanup; no result escapes either barrier.
    if (cancellation) await cancellation;
    try {
      if (lease) await lease.close();
    } catch {
      failed = true;
    }
    if (timer) clearTimeout(timer);
    if (cancellation) await cancellation;
  }
  // A synchronous adapter may delay timer delivery even after the commit/cleanup barrier.
  if (Number.isSafeInteger(deadlineMs) && Date.now() - startedAt >= deadlineMs) failed = true;
  if (failed || cancellationFailed || controller.signal.aborted || !result)
    throw new Error('Fresh Restaurant bootstrap failed; transaction outcome requires review.');
  return result;
}
