import { hash } from 'bcryptjs';
import {
  runBoundFreshBootstrap,
  type FreshDatabaseFactory,
  type FreshDatabaseGuard,
} from './fresh-database.js';

/** Import-safe canonical writer wrapper; private execution lives in fresh-database-runner.ts. */
export async function bootstrapFreshDatabase(
  factory: FreshDatabaseFactory,
  env: Record<string, string | undefined>,
  guard: FreshDatabaseGuard,
  deadlineMs: number
) {
  return runBoundFreshBootstrap(factory, env, guard, deadlineMs, (password) => hash(password, 12));
}
