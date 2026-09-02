import 'server-only';

import type { PrismaClient } from '@/generated/prisma/client';
import { db } from '@/lib/db';

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
  options: { maxWait?: number; timeout?: number } = {}
): Promise<T> {
  assertOrganizationId(organizationId);

  return db.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.current_organization_id', $1, true),
                set_config('app.is_platform_admin', 'false', true)`,
        organizationId
      );
      return run(exposeNestedTransaction(tx));
    },
    {
      maxWait: options.maxWait ?? 10_000,
      timeout: options.timeout ?? 30_000,
    }
  );
}

export async function withPlatformDb<T>(
  run: (tx: ScopedDb) => Promise<T>,
  options: { maxWait?: number; timeout?: number } = {}
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
    }
  );
}

/**
 * WHA-1181 — run `run` with `app.current_organization_id` installed as
 * `organizationId` for the duration, then restore whatever it was.
 *
 * WHY THIS EXISTS. Most tenant tables declare
 * `organizationId String @default(dbgenerated("current_setting('app.current_organization_id', true)"))`,
 * so an insert that omits the column takes its tenant from the GUC. Inside
 * {@link withPlatformDb} that GUC is deliberately BLANK, and the platform control
 * plane is exactly where a tenant's provisioning rows are written — an omitted
 * column there lands the empty string and the row belongs to no organization.
 *
 * The alternative, threading an explicit `organizationId` through every domain
 * writer a provisioning path reuses, changes the shape of well-tested tenant
 * modules (`job-roles.ts`, `stations.ts`) for the benefit of one caller. Setting
 * the GUC the schema already reads keeps those modules untouched.
 *
 * THIS DOES NOT WIDEN ACCESS. Every restaurant policy reads
 * `current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')`.
 * The platform admin flag is untouched here and already short-circuits the OR, so
 * naming an organization can only ever narrow what an unprivileged caller sees —
 * never grant a tenant caller reach into another tenant.
 *
 * Restoration is in a `finally` so a throw mid-provisioning cannot leave the rest
 * of a platform command writing under a tenant's id. That is belt-and-braces: a
 * throw normally aborts the surrounding transaction anyway.
 */
export async function withOrganizationDefaults<T>(
  tx: ScopedDb,
  organizationId: string,
  run: (tx: ScopedDb) => Promise<T>
): Promise<T> {
  assertOrganizationId(organizationId);

  const [previous] = await tx.$queryRawUnsafe<{ value: string | null }[]>(
    `SELECT current_setting('app.current_organization_id', true) AS value`
  );
  await tx.$queryRawUnsafe(
    `SELECT set_config('app.current_organization_id', $1, true)`,
    organizationId
  );
  try {
    return await run(tx);
  } finally {
    await tx.$queryRawUnsafe(
      `SELECT set_config('app.current_organization_id', $1, true)`,
      previous?.value ?? ''
    );
  }
}

/**
 * A request-safe Prisma facade for code paths that cannot hold one interactive
 * transaction open (notably RSC prefetch helpers). Every model operation is
 * executed in its own tenant-scoped transaction. Request handlers should prefer
 * one outer `withTenantDb` transaction and pass its `tx` directly.
 */
export function createTenantDb(organizationId: string): ScopedDb {
  assertOrganizationId(organizationId);

  return new Proxy({} as ScopedDb, {
    get(_target, modelKey) {
      if (typeof modelKey !== 'string') return undefined;

      if (modelKey === '$transaction') {
        return async (
          run: (tx: ScopedDb) => Promise<unknown>,
          options?: { maxWait?: number; timeout?: number }
        ) => withTenantDb(organizationId, run, options);
      }

      if (modelKey.startsWith('$')) {
        return (...args: unknown[]) =>
          withTenantDb(organizationId, (tx) => {
            const operation = (tx as unknown as Record<string, (...values: unknown[]) => unknown>)[
              modelKey
            ];
            if (typeof operation !== 'function') {
              throw new Error(`Unsupported Prisma operation: ${modelKey}`);
            }
            return Promise.resolve(operation.apply(tx, args));
          });
      }

      return new Proxy(
        {},
        {
          get(_delegate, operationKey) {
            if (typeof operationKey !== 'string') return undefined;
            return (...args: unknown[]) =>
              withTenantDb(organizationId, (tx) => {
                const delegate = (tx as unknown as Record<string, unknown>)[modelKey] as
                  Record<string, (...values: unknown[]) => unknown> | undefined;
                const operation = delegate?.[operationKey];
                if (typeof operation !== 'function') {
                  throw new Error(`Unsupported Prisma operation: ${modelKey}.${operationKey}`);
                }
                return Promise.resolve(operation.apply(delegate, args));
              });
          },
        }
      );
    },
  });
}
