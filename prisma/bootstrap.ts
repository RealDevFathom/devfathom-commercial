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

if (!ADMIN_PASSWORD) {
  console.error('❌ ADMIN_PASSWORD env var is required');
  console.error('   Run with: ADMIN_PASSWORD="..." DATABASE_URL="..." bunx tsx prisma/bootstrap.ts');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🚀 Bootstrapping production database...\n');

  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) {
    console.log(`✓ Admin account ${ADMIN_EMAIL} already exists. Skipping.`);
    return;
  }

  const hashedPassword = await hash(ADMIN_PASSWORD!, 12);

  const admin = await prisma.user.create({
    data: {
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: hashedPassword,
      role: 'ADMIN',
      department: 'LEADERSHIP',
      title: ADMIN_TITLE,
      status: 'ACTIVE',
    },
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
