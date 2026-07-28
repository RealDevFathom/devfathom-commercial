// Production bootstrap — creates ONE admin account, no demo data.
// Run with: DATABASE_URL="..." bunx tsx prisma/bootstrap.ts
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { hash } from 'bcryptjs';
import 'dotenv/config';

const ADMIN_EMAIL = 'admin@company.com';
const ADMIN_NAME = 'Alex Carter';
const ADMIN_TITLE = 'CEO & Founder';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ORGANIZATION_ID = process.env.ORGANIZATION_ID ?? 'org_devfathom';

if (!ADMIN_PASSWORD) {
  console.error('❌ ADMIN_PASSWORD env var is required');
  console.error(
    '   Run with: ADMIN_PASSWORD="..." DATABASE_URL="..." bunx tsx prisma/bootstrap.ts'
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🚀 Bootstrapping production database...\n');

  const hashedPassword = await hash(ADMIN_PASSWORD!, 12);
  const admin = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'true', true)`,
      ORGANIZATION_ID
    );
    const existing = await tx.user.findUnique({
      where: {
        organizationId_email: { organizationId: ORGANIZATION_ID, email: ADMIN_EMAIL },
      },
    });
    if (existing) return existing;
    return tx.user.create({
      data: {
        organizationId: ORGANIZATION_ID,
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        password: hashedPassword,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: ADMIN_TITLE,
        status: 'ACTIVE',
      },
    });
  });

  console.log(`✅ Created admin account:`);
  console.log(`   Name:  ${admin.name}`);
  console.log(`   Email: ${admin.email}`);
  console.log(`   Role:  ${admin.role}`);
  console.log(`\n🎉 Bootstrap complete. Log in at https://hub.company.com with this account.`);
  console.log(`   Use the password you provided via ADMIN_PASSWORD.`);
}

main()
  .catch((e) => {
    console.error('❌ Bootstrap failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
