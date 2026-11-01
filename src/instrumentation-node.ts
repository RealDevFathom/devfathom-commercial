/** Node-only startup checks; imported only for the nodejs runtime. */
export async function assertProductionStartup() {
  try {
    const { assertProductionClientIpConfig, assertProductionRateLimitHmacSecret } =
      await import('@/lib/rate-limit');
    assertProductionRateLimitHmacSecret();
    assertProductionClientIpConfig();
    const { assertProductionDatabaseRole } = await import('@/lib/db/rls-role');
    await assertProductionDatabaseRole();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
