// Create (or promote) an admin user. Credentials come from env vars, so no
// secret is written to disk. Idempotent: upserts on email.
//
// Run with:
//   ADMIN_EMAIL="you@devfathom.com" ADMIN_PASSWORD="..." \
//   [ADMIN_NAME="..." ADMIN_TITLE="..." ADMIN_DEPARTMENT="LEADERSHIP"] \
//   DATABASE_URL="..." bunx tsx prisma/create-admin.ts
//
// ADMIN_DEPARTMENT, when given, must be a key from the TARGET organization's own
// department catalog; it defaults to that organization's vertical default.
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { hash } from 'bcryptjs';
import { requireEnvironment } from '../scripts/load-local-env.js';

import { adminDepartmentKeyForVertical } from '../src/lib/vertical-catalog.js';

// D10: emails are stored lower-cased, so an operator typing `Admin@Company.com`
// must resolve to the same row rather than creating (or failing to find) another.
const EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const PASSWORD = process.env.ADMIN_PASSWORD;
const NAME = process.env.ADMIN_NAME ?? 'Admin';
const TITLE = process.env.ADMIN_TITLE ?? 'Administrator';
// WHA-290: departments are tenant-configured rows keyed by (organizationId,
// key), so there is no key that is valid in every organization and no default
// this script can assume. Left undefined here and resolved below against the
// target organization's own catalog.
const DEPARTMENT = process.env.ADMIN_DEPARTMENT?.trim() || undefined;

if (!EMAIL || !PASSWORD) {
  console.error('❌ ADMIN_EMAIL and ADMIN_PASSWORD env vars are required');
  process.exit(1);
}
if (PASSWORD.length < 8) {
  console.error('❌ Password must be at least 8 characters');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: requireEnvironment('DATABASE_URL') });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * The department key this admin is filed under. ADMIN_DEPARTMENT wins when it
 * names an ACTIVE department of the target organization; otherwise the
 * organization's own vertical default. Anything else is refused by name, with
 * the valid keys listed, because the alternative is an opaque foreign key
 * violation on `users_organizationId_department_fkey`.
 */
async function resolveDepartment(
  tx: Prisma.TransactionClient,
  organizationId: string
): Promise<string> {
  const organization = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { vertical: true },
  });
  if (!organization) {
    throw new Error(`Organization ${organizationId} does not exist; create it before its admin.`);
  }
  const departments = await tx.organizationDepartment.findMany({
    where: { organizationId, active: true },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    select: { key: true },
  });
  const keys = departments.map((department) => department.key);
  if (keys.length === 0) {
    throw new Error(
      `Organization ${organizationId} has no active department. Seed its catalog before creating an admin.`
    );
  }
  if (DEPARTMENT) {
    if (!keys.includes(DEPARTMENT)) {
      throw new Error(
        `ADMIN_DEPARTMENT="${DEPARTMENT}" is not an active department of ${organizationId}. Valid keys: ${keys.join(', ')}.`
      );
    }
    return DEPARTMENT;
  }
  const preferred = adminDepartmentKeyForVertical(organization.vertical);
  return keys.includes(preferred) ? preferred : keys[0]!;
}

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
    // WHA-290: `User.department` is a composite foreign key onto
    // `organization_departments`. Resolve the key against this organization's
    // own active catalog and say what is wrong, rather than casting a literal
    // and letting `users_organizationId_department_fkey` surface as a raw
    // Prisma error. Resolved on the update path too, so a mistyped
    // ADMIN_DEPARTMENT is reported instead of silently ignored.
    const department = await resolveDepartment(tx, organizationId);
    const saved = await tx.user.upsert({
      where: { organizationId_email: { organizationId, email: EMAIL! } },
      update: { password: hashedPassword, role: 'ADMIN', status: 'ACTIVE' },
      create: {
        organizationId,
        name: NAME,
        email: EMAIL!,
        password: hashedPassword,
        role: 'ADMIN',
        department,
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
