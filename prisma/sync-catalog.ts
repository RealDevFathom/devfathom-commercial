import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import 'dotenv/config';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { syncPlatformCatalog } from './catalog-sync.js';

/**
 * Standalone catalog reconciliation, run by the migration job after
 * `prisma migrate deploy` so production receives new modules and packages even
 * with `seedDatabase = false`. Exits non-zero on failure: an unreconciled
 * catalog silently hides a shipped module from every organization.
 */
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  await prisma.$transaction(async (tx) => {
    // `platform_modules` and `platform_packages` are FORCE RLS behind the
    // control-plane-only policy, exactly as the seed's transaction assumes.
    await tx.$executeRawUnsafe(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await syncPlatformCatalog(tx);
  });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
