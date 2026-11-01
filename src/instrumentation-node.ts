/** Node-only startup checks; imported only for the nodejs runtime. */
export async function assertProductionStartup() {
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
