/**
 * Next.js server startup hook.
 *
 * Production refuses to serve when the database role can bypass row level
 * security, or when no trusted-proxy setting is configured. `next build`
 * skips both checks.
 *
 * `next start` catches a thrown `register()` and keeps listening, so a failed
 * check exits the process.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.NODE_ENV !== 'production') return;

  try {
    const { assertProductionClientIpConfig } = await import('@/lib/rate-limit');
    assertProductionClientIpConfig();
    const { assertProductionDatabaseRole } = await import('@/lib/db/rls-role');
    await assertProductionDatabaseRole();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
