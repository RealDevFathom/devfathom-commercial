/** Configure the runtime client before importing warehouse services that use it. */
export function configureWarehouseTestDatabase() {
  const url =
    process.env.M8_TEST_RUNTIME_DATABASE_URL?.trim() || process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'Warehouse database tests require TEST_DATABASE_URL or M8_TEST_RUNTIME_DATABASE_URL pointing to a migrated, disposable PostgreSQL database with a restricted runtime role.'
    );
  }
  process.env.DATABASE_URL = url;
}
