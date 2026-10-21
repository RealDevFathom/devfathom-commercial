import { hash } from 'bcryptjs';

import type { Prisma } from '../src/generated/prisma/client.js';

type PasswordHasher = (password: string) => Promise<string>;

/**
 * Idempotently creates the staging workspace administrator from `ADMIN_EMAIL`
 * and `ADMIN_PASSWORD`. No address or secret is hardcoded.
 *
 * Email unset leaves the database alone, so a local seed that only sets
 * `ADMIN_PASSWORD` as the demo-user fallback still runs. Email without a
 * password is a configuration error. A later run with the same email updates
 * the hash, so a rotated vault password replaces the previous one.
 */
export async function upsertStagingAdmin(
  tx: Prisma.TransactionClient,
  scope: { organizationId: string; organizationRoleId: string },
  hashPassword: PasswordHasher = (password) => hash(password, 12)
): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return;
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      'Set ADMIN_PASSWORD when ADMIN_EMAIL is set to seed the staging administrator.'
    );
  }

  const passwordHash = await hashPassword(password);
  const name = process.env.ADMIN_NAME?.trim() || 'Workspace Administrator';
  const title = process.env.ADMIN_TITLE?.trim() || 'Administrator';
  const department = process.env.ADMIN_DEPARTMENT?.trim() || 'LEADERSHIP';
  await tx.user.upsert({
    where: { organizationId_email: { organizationId: scope.organizationId, email } },
    update: {
      password: passwordHash,
      role: 'ADMIN',
      status: 'ACTIVE',
      organizationRoleId: scope.organizationRoleId,
    },
    create: {
      organizationId: scope.organizationId,
      organizationRoleId: scope.organizationRoleId,
      name,
      email,
      password: passwordHash,
      role: 'ADMIN',
      department,
      title,
      status: 'ACTIVE',
    },
  });
}
