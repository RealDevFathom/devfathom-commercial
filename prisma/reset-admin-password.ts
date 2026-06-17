// Reset password for the admin account.
// Run with: ADMIN_PASSWORD="..." DATABASE_URL="..." npx tsx prisma/reset-admin-password.ts
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { hash } from 'bcryptjs';
import 'dotenv/config';

const ADMIN_EMAIL = 'admin@company.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.error('❌ ADMIN_PASSWORD env var is required');
  process.exit(1);
}

if (ADMIN_PASSWORD.length < 8) {
  console.error('❌ Password must be at least 8 characters');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const hashedPassword = await hash(ADMIN_PASSWORD!, 12);

  const updated = await prisma.user.update({
    where: { email: ADMIN_EMAIL },
    data: { password: hashedPassword },
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
