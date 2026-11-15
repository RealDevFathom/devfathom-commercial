// Reset password for the admin account.
// Run with: ADMIN_PASSWORD="..." DATABASE_URL="..." bunx tsx prisma/reset-admin-password.ts
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { hash } from 'bcryptjs';
import { loadLocalEnv, requireDatabaseUrl } from './load-env.js';

loadLocalEnv();

const ADMIN_EMAIL = 'admin@company.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ORGANIZATION_ID = process.env.ORGANIZATION_ID ?? 'org_devfathom';

if (!ADMIN_PASSWORD) {
  console.error('❌ ADMIN_PASSWORD env var is required');
  process.exit(1);
}

if (ADMIN_PASSWORD.length < 8) {
  console.error('❌ Password must be at least 8 characters');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: requireDatabaseUrl(['DATABASE_URL']) });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const hashedPassword = await hash(ADMIN_PASSWORD!, 12);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'true', true)`,
      ORGANIZATION_ID
    );
    return tx.user.update({
      where: {
        organizationId_email: { organizationId: ORGANIZATION_ID, email: ADMIN_EMAIL },
      },
      data: { password: hashedPassword },
    });
  });

  console.log(`✅ Password updated for ${updated.email}`);
}

main()
  .catch((e) => {
    console.error('❌ Failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
