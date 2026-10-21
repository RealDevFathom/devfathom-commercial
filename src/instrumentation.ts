/**
 * Next.js server startup hook.
 *
 * Production refuses to serve when the database role can bypass row level
 * security, when no trusted-proxy setting is configured, or when neither
 * rate-limit HMAC secret nor `AUTH_SECRET` is set, or when APP_ENV is not one of
 * production / staging / pilot. `next build` skips the checks.
 *
 * `next start` catches a thrown `register()` and keeps listening, so a failed
 * check exits the process.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.NODE_ENV !== 'production') return;

  try {
    const { assertProductionClientIpConfig, assertProductionRateLimitHmacSecret } =
      await import('@/lib/rate-limit');
    assertProductionRateLimitHmacSecret();
    assertProductionClientIpConfig();
    const { assertProductionDatabaseRole } = await import('@/lib/db/rls-role');
    await assertProductionDatabaseRole();
    const { assertProductionAppEnv } = await import('@/lib/app-env');
    assertProductionAppEnv();
    console.info(`[startup] APP_ENV=${process.env.APP_ENV}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
