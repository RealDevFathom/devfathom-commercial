// Create (or promote) an admin user. Credentials come from env vars, so no
// secret is written to disk. Idempotent: upserts on email.
//
// Run with:
//   ADMIN_EMAIL="you@devfathom.com" ADMIN_PASSWORD="..." \
//   [ADMIN_NAME="..." ADMIN_TITLE="..." ADMIN_DEPARTMENT="LEADERSHIP"] \
//   DATABASE_URL="..." bunx tsx prisma/create-admin.ts
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { hash } from 'bcryptjs';
import 'dotenv/config';

// D10: emails are stored lower-cased, so an operator typing `Admin@Company.com`
// must resolve to the same row rather than creating (or failing to find) another.
const EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const PASSWORD = process.env.ADMIN_PASSWORD;
const NAME = process.env.ADMIN_NAME ?? 'Admin';
const TITLE = process.env.ADMIN_TITLE ?? 'Administrator';
const DEPARTMENT = process.env.ADMIN_DEPARTMENT ?? 'LEADERSHIP';

if (!EMAIL || !PASSWORD) {
  console.error('❌ ADMIN_EMAIL and ADMIN_PASSWORD env vars are required');
  process.exit(1);
}
if (PASSWORD.length < 8) {
  console.error('❌ Password must be at least 8 characters');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const hashedPassword = await hash(PASSWORD!, 12);
  const organizationId = process.env.ORGANIZATION_ID ?? 'org_devfathom';

  const { existing, user } = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'true', true)`,
      organizationId
    );
    const found = await tx.user.findUnique({
      where: { organizationId_email: { organizationId, email: EMAIL! } },
    });
    const saved = await tx.user.upsert({
      where: { organizationId_email: { organizationId, email: EMAIL! } },
      update: { password: hashedPassword, role: 'ADMIN', status: 'ACTIVE' },
      create: {
        organizationId,
        name: NAME,
        email: EMAIL!,
        password: hashedPassword,
        role: 'ADMIN',
        department: DEPARTMENT as 'LEADERSHIP',
        title: TITLE,
        status: 'ACTIVE',
      },
    });
    return { existing: found, user: saved };
  });

  console.log(
    `✅ ${existing ? 'Updated' : 'Created'} admin: ${user.name} <${user.email}> — role=${user.role}, status=${user.status}`
  );
}

main()
  .catch((e) => {
    console.error('❌ Failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
