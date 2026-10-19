import { hash } from 'bcryptjs';
import type { Prisma } from '../src/generated/prisma/client.js';
import { syncPlatformCatalog } from './catalog-sync.js';
import {
  runBoundFreshBootstrap,
  type FreshDatabaseClient,
  type FreshDatabaseGuard,
} from './fresh-database.js';

/** Source-only library. No mutation CLI or default factory/baseline/observations.
 * The deployment owner supplies a reviewed PrismaPg factory and transaction-bound observer.
 * Missing identity, freshness, source, ledger, visibility or TLS evidence refuses all writes.
 */
export async function bootstrapFreshDatabase(
  factory: (runtimeDatabaseUrl: string) => Promise<FreshDatabaseClient<Prisma.TransactionClient>>,
  env: Record<string, string | undefined>,
  guard: FreshDatabaseGuard,
  hashPassword: (password: string) => Promise<string> = (password) => hash(password, 12)
) {
  return runBoundFreshBootstrap(factory, env, guard, syncPlatformCatalog, hashPassword);
}
