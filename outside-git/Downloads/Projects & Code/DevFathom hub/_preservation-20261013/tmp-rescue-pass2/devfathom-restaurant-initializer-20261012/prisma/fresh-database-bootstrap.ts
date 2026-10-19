import { hash } from 'bcryptjs';
import {
  runBoundFreshBootstrap,
  type FreshDatabaseFactory,
  type FreshDatabaseGuard,
} from './fresh-database.js';

/** Source-only library: no mutation CLI, client factory, observer or approved baseline supplied. */
export async function bootstrapFreshDatabase(
  factory: FreshDatabaseFactory,
  env: Record<string, string | undefined>,
  guard: FreshDatabaseGuard,
  deadlineMs: number
) {
  return runBoundFreshBootstrap(factory, env, guard, deadlineMs, (password) => hash(password, 12));
}
