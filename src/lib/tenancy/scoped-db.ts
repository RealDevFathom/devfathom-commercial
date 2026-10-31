import 'server-only';

import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { bindSideEffects, type SideEffectScope } from '@/lib/side-effects/scope';

/**
 * The application only consumes Prisma model/query methods through this type.
 * Interactive transaction clients intentionally omit lifecycle methods from
 * PrismaClient's generated type, even though their model delegates are
 * identical. Exposing the common application-facing shape avoids forcing every
 * router helper to understand Prisma's transaction-only utility type.
 *
 * `withTenantDb` and `withPlatformDb` remain the only constructors: the cast
 * below never exposes an unscoped client at runtime.
 */
export type ScopedDb = PrismaClient;

const ORGANIZATION_ID_PATTERN = /^[a-zA-Z0-9_-]{3,128}$/;

function assertOrganizationId(organizationId: string) {
  if (!ORGANIZATION_ID_PATTERN.test(organizationId)) {
    throw new Error('Invalid organization identifier.');
  }
}

function exposeNestedTransaction(tx: object): ScopedDb {
  // Prisma's pg adapter binds an interactive transaction to one pg Client.
  // A Client can only execute one query at a time; allowing application-level
  // Promise.all calls to reach it concurrently currently produces a pg
  // deprecation warning and will be rejected by pg 9. Keep the request-level
  // transaction while serializing its individual statements.
  let queryQueue: Promise<void> = Promise.resolve();
  const delegateCache = new Map<PropertyKey, unknown>();

  function schedule<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const result = queryQueue.then(operation, operation);
    queryQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  const scoped = new Proxy(tx as ScopedDb, {
    get(target, key, receiver) {
      if (key === '$transaction') {
        return async (
          operation: ((inner: ScopedDb) => Promise<unknown>) | ArrayLike<PromiseLike<unknown>>
        ) => {
          // A request is already inside an interactive transaction. Reuse it
          // for legacy helpers that group operations with `$transaction`.
          if (typeof operation === 'function') return operation(scoped);
          return Promise.all(Array.from(operation));
        };
      }

      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value === 'function' && typeof key === 'string' && key.startsWith('$')) {
        return (...args: unknown[]) =>
          schedule(() => (value as (...values: unknown[]) => unknown).apply(target, args));
      }

      if (!value || typeof value !== 'object') return value;
      const cached = delegateCache.get(key);
      if (cached) return cached;

      const delegate = new Proxy(value as Record<PropertyKey, unknown>, {
        get(delegateTarget, operationKey, delegateReceiver) {
          const operation = Reflect.get(delegateTarget, operationKey, delegateReceiver) as unknown;
          if (typeof operation !== 'function') return operation;
          return (...args: unknown[]) =>
            schedule(() =>
              (operation as (...values: unknown[]) => unknown).apply(delegateTarget, args)
            );
        },
      });
      delegateCache.set(key, delegate);
      return delegate;
    },
  });
  return scoped;
}

export async function withTenantDb<T>(
  organizationId: string,
  run: (tx: ScopedDb) => Promise<T>,
  options: {
    maxWait?: number;
    timeout?: number;
    userId?: string;
    isolationLevel?: Prisma.TransactionIsolationLevel;
    /** The outbox drainer calls this so delivery does not enqueue itself. */
    skipDrain?: boolean;
  } = {}
): Promise<T> {
  assertOrganizationId(organizationId);

  const execute = (scope?: SideEffectScope) =>
    db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT set_config('app.current_organization_id', $1, true),
                  set_config('app.current_user_id', $2, true),
                  set_config('app.is_platform_admin', 'false', true)`,
          organizationId,
          options.userId ?? ''
        );
        const scoped = exposeNestedTransaction(tx);
        try {
          const value = await run(scoped);
          if (scope) await scope.flush();
          return value;
        } catch (error) {
          if (scope) await scope.settle();
          throw error;
        }
      },
      {
        maxWait: options.maxWait ?? 10_000,
        timeout: options.timeout ?? 30_000,
        ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
      }
    );

  if (options.skipDrain) return execute();

  return bindSideEffects(async (scope) => {
    let result: T;
    try {
      result = await execute(scope);
    } finally {
      // Failure audits also run after rollback; never compete with the owning
      // transaction for a pool connection or locks held on its actor row.
      for (const work of scope.afterTransaction) work();
    }
    if (scope.enqueued) {
      const { drainOrganization } = await import('@/lib/side-effects/drain');
      await drainOrganization(organizationId).catch((error) => {
        console.error('[side-effects] drain failed', error instanceof Error ? error.name : 'error');
      });
    }
    return result;
  });
}

export async function withPlatformDb<T>(
  run: (tx: ScopedDb) => Promise<T>,
  options: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel } = {}
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.current_organization_id', '', true),
                set_config('app.is_platform_admin', 'true', true)`
      );
      return run(exposeNestedTransaction(tx));
    },
    {
      maxWait: options.maxWait ?? 10_000,
      timeout: options.timeout ?? 30_000,
      ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
    }
  );
}

/**
 * WHA-1181 — run `run` AS one tenant inside an existing transaction, then put
 * the surrounding scope back exactly as it was.
 *
 * WHY THIS EXISTS. A provisioning path reuses ordinary tenant domain writers
 * (`job-roles.ts`, the station insert) from the PLATFORM control plane, and those
 * writers assume tenant scope in two separate ways:
 *
 *   1. WRITES. Most tenant tables declare `organizationId String
 *      @default(dbgenerated("current_setting('app.current_organization_id', true)"))`,
 *      so an insert that omits the column takes its tenant from the GUC. Inside
 *      {@link withPlatformDb} that GUC is deliberately BLANK, so the row would
 *      land under the empty string and belong to no organization.
 *   2. READS. Every idempotence check in those writers is an unfiltered read —
 *      `ensureDefaultJobRoles` asks "which role keys exist?" and lets RLS answer.
 *      Under `app.is_platform_admin = 'true'` the policy short-circuits and that
 *      question is answered for EVERY tenant at once, so a fresh organization
 *      looks fully seeded and gets nothing.
 *
 * Setting only the organization id fixes (1) and leaves (2) silently broken,
 * which is why both GUCs move together here: this installs the same scope
 * {@link withTenantDb} would, for the duration of `run`.
 *
 * DROPPING THE PLATFORM FLAG ONLY NARROWS. `is_platform_admin` is the permissive
 * side of `... = 'true' OR "organizationId" = NULLIF(current_setting(...), '')`.
 * Clearing it while naming the organization leaves the tenant's own rows
 * reachable and nothing else — this can never grant reach into another tenant.
 *
 * Restoration is in a `finally` so a throw mid-provisioning cannot leave the rest
 * of a platform command running under a tenant's scope. That is belt-and-braces:
 * a throw normally aborts the surrounding transaction anyway.
 */
export async function withOrganizationDefaults<T>(
  tx: ScopedDb,
  organizationId: string,
  run: (tx: ScopedDb) => Promise<T>
): Promise<T> {
  assertOrganizationId(organizationId);

  const [previous] = await tx.$queryRawUnsafe<
    { organization: string | null; platformAdmin: string | null }[]
  >(
    `SELECT current_setting('app.current_organization_id', true) AS organization,
            current_setting('app.is_platform_admin', true) AS "platformAdmin"`
  );
  await tx.$queryRawUnsafe(
    `SELECT set_config('app.current_organization_id', $1, true),
            set_config('app.is_platform_admin', 'false', true)`,
    organizationId
  );
  try {
    return await run(tx);
  } finally {
    await tx.$queryRawUnsafe(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', $2, true)`,
      previous?.organization ?? '',
      previous?.platformAdmin ?? 'false'
    );
  }
}

/**
 * A request-safe Prisma facade for code paths that cannot hold one interactive
 * transaction open (notably RSC prefetch helpers). Every model operation is
 * executed in its own tenant-scoped transaction. Request handlers should prefer
 * one outer `withTenantDb` transaction and pass its `tx` directly.
 */
export function createTenantDb(organizationId: string, userId?: string): ScopedDb {
  assertOrganizationId(organizationId);

  return new Proxy({} as ScopedDb, {
    get(_target, modelKey) {
      if (typeof modelKey !== 'string') return undefined;

      if (modelKey === '$transaction') {
        return async (
          run: (tx: ScopedDb) => Promise<unknown>,
          options?: {
            maxWait?: number;
            timeout?: number;
            isolationLevel?: Prisma.TransactionIsolationLevel;
          }
        ) => withTenantDb(organizationId, run, { ...options, userId });
      }

      if (modelKey.startsWith('$')) {
        return (...args: unknown[]) =>
          withTenantDb(
            organizationId,
            (tx) => {
              const operation = (
                tx as unknown as Record<string, (...values: unknown[]) => unknown>
              )[modelKey];
              if (typeof operation !== 'function') {
                throw new Error(`Unsupported Prisma operation: ${modelKey}`);
              }
              return Promise.resolve(operation.apply(tx, args));
            },
            { userId }
          );
      }

      return new Proxy(
        {},
        {
          get(_delegate, operationKey) {
            if (typeof operationKey !== 'string') return undefined;
            return (...args: unknown[]) =>
              withTenantDb(
                organizationId,
                (tx) => {
                  const delegate = (tx as unknown as Record<string, unknown>)[modelKey] as
                    Record<string, (...values: unknown[]) => unknown> | undefined;
                  const operation = delegate?.[operationKey];
                  if (typeof operation !== 'function') {
                    throw new Error(`Unsupported Prisma operation: ${modelKey}.${operationKey}`);
                  }
                  return Promise.resolve(operation.apply(delegate, args));
                },
                { userId }
              );
          },
        }
      );
    },
  });
}
