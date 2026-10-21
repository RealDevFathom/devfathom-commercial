/**
 * Next.js server startup hook.
 *
 * Production refuses to serve when the database role can bypass row level
 * security, when no trusted-proxy setting is configured, or when neither
 * rate-limit HMAC secret nor `AUTH_SECRET` is set. `next build` skips the checks.
 *
 * `next start` catches a thrown `register()` and keeps listening, so a failed
 * check exits the process.
 */
export async function register() {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.NODE_ENV !== 'production') return;

  // Keep the import inside a positive runtime branch so Next can eliminate
  // the Node-only dependency graph from its Edge compilation.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertProductionStartup } = await import('./instrumentation-node');
    await assertProductionStartup();
  }
}
