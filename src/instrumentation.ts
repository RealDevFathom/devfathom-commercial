/**
 * Next.js server startup hook. Production refuses to serve when the database
 * role can bypass row level security. The check is skipped while `next build`
 * evaluates this module, because a build is not a running server.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.NODE_ENV !== 'production') return;

  const { assertProductionDatabaseRole } = await import('@/lib/db/rls-role');
  await assertProductionDatabaseRole();
}
