import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

/** Validate at the pool boundary; never substitute ambient/admin configuration. */
function runtimeDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value?.trim()) throw new Error('runtime_database_url_missing');

  try {
    const url = new URL(value);
    if (
      !/^postgres(?:ql)?:\/\//i.test(value) ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      /\s/.test(value) ||
      url.hash ||
      !(url.hostname || url.searchParams.get('host'))
    ) {
      throw new Error();
    }
    // WHATWG URL accepts malformed percent escapes that the driver cannot decode.
    decodeURI(value);
  } catch {
    // Do not retain the parser error/cause: it can contain the full URL.
    throw new Error('runtime_database_url_invalid');
  }

  return value;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  credentialPrisma: PrismaClient | undefined;
  prismaVersion: string | undefined;
};

// Version key to bust cache when schema changes
const PRISMA_VERSION = '7';

type PgAdapterConnection = Awaited<ReturnType<PrismaPg['connect']>>;
type PgAdapterTransaction = Awaited<ReturnType<PgAdapterConnection['startTransaction']>>;

const TRANSACTION_METHODS = new Set<PropertyKey>([
  'queryRaw',
  'executeRaw',
  'createSavepoint',
  'rollbackToSavepoint',
  'releaseSavepoint',
  'commit',
  'rollback',
]);

type PgRawQuery = Parameters<PgAdapterTransaction['queryRaw']>[0];
type PgRawResult = Awaited<ReturnType<PgAdapterTransaction['queryRaw']>>;

function isVoidAdvisoryLock(query: PgRawQuery): boolean {
  return /^\s*SELECT\s+(?:pg_catalog\.)?pg_advisory_(?:xact_)?lock\s*\(/i.test(query.sql);
}

async function queryRawWithoutVoidDecoding(
  transaction: PgAdapterTransaction,
  query: PgRawQuery
): Promise<PgRawResult> {
  if (!isVoidAdvisoryLock(query)) return transaction.queryRaw(query);

  await transaction.executeRaw(query);
  return { columnNames: [], columnTypes: [], rows: [] };
}

/**
 * Prisma can fan a single relation query out into multiple driver-adapter
 * statements. Inside an interactive transaction every statement shares one
 * `pg.PoolClient`, and node-postgres 9 will reject concurrent `client.query`
 * calls on that client. Serialize at the adapter transaction boundary so this
 * also covers work emitted inside one Prisma operation, not only separate
 * application-level calls.
 */
function serializeTransaction(transaction: PgAdapterTransaction): PgAdapterTransaction {
  let queue: Promise<void> = Promise.resolve();

  function schedule<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  return new Proxy(transaction, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;

      if (TRANSACTION_METHODS.has(key)) {
        return (...args: unknown[]) => {
          if (key === 'queryRaw') {
            return schedule(() => queryRawWithoutVoidDecoding(target, args[0] as PgRawQuery));
          }

          return schedule(() =>
            Reflect.apply(value as (...values: unknown[]) => unknown, target, args)
          );
        };
      }

      return (...args: unknown[]) =>
        Reflect.apply(value as (...values: unknown[]) => unknown, target, args);
    },
  });
}

function serializeInteractiveTransactions(factory: PrismaPg): PrismaPg {
  function wrapConnection(connection: PgAdapterConnection): PgAdapterConnection {
    return new Proxy(connection, {
      get(target, key, receiver) {
        if (key === 'startTransaction') {
          return async (...args: Parameters<PgAdapterConnection['startTransaction']>) =>
            serializeTransaction(await target.startTransaction(...args));
        }

        const value = Reflect.get(target, key, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          Reflect.apply(value as (...values: unknown[]) => unknown, target, args);
      },
    });
  }

  return new Proxy(factory, {
    get(target, key, receiver) {
      if (key === 'connect') {
        return async () => wrapConnection(await target.connect());
      }
      if (key === 'connectToShadowDb') {
        return async () => wrapConnection(await target.connectToShadowDb());
      }

      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        Reflect.apply(value as (...values: unknown[]) => unknown, target, args);
    },
  });
}

function createPrismaClient(max = 10) {
  const pool = new pg.Pool({ connectionString: runtimeDatabaseUrl(), max });
  const adapter = serializeInteractiveTransactions(new PrismaPg(pool));

  return new PrismaClient({
    adapter,
    // Prisma stdout errors can include SQL and connection details before a probe catches them.
    // Production probes report only their own stable reason codes.
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : [],
  });
}

// Invalidate cached client if version changed (schema was updated)
if (globalForPrisma.prismaVersion !== PRISMA_VERSION) {
  globalForPrisma.prisma = undefined;
  globalForPrisma.credentialPrisma = undefined;
  globalForPrisma.prismaVersion = PRISMA_VERSION;
}

let client: PrismaClient | undefined;
let credentialClient: PrismaClient | undefined;

function getPrismaClient(): PrismaClient {
  if (!client) {
    client = globalForPrisma.prisma ?? createPrismaClient();
    if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = client;
  }
  return client;
}

function getCredentialPrismaClient(): PrismaClient {
  if (!credentialClient) {
    credentialClient = globalForPrisma.credentialPrisma ?? createPrismaClient(2);
    if (process.env.NODE_ENV !== 'production') {
      globalForPrisma.credentialPrisma = credentialClient;
    }
  }
  return credentialClient;
}

// Route imports/build inspection must not require runtime credentials or create a pool.
// Resolve the client on first use; Prisma methods must receive the real client as `this`.
function lazyClient(resolve: () => PrismaClient): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(_target, key) {
      // Promise/await inspection must not turn this ordinary export into a DB operation.
      if (key === 'then') return undefined;
      const target = resolve();
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const db = lazyClient(getPrismaClient);

// Credential attempts commit while a request transaction is still open. Reserve
// a separate, bounded pool so ten occupied request connections cannot deadlock
// waiting for their authentication transactions. Uses the same runtime role.
export const credentialAttemptDb = lazyClient(getCredentialPrismaClient);
