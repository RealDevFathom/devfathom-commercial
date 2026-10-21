import { compare, hash } from 'bcryptjs';

import type { Prisma } from '../src/generated/prisma/client.js';

type PasswordHasher = (password: string) => Promise<string>;
type PasswordComparer = (password: string, passwordHash: string) => Promise<boolean>;

/**
 * Idempotently creates the staging workspace administrator from `ADMIN_EMAIL`
 * and `ADMIN_PASSWORD`. No address or secret is hardcoded.
 *
 * Email unset leaves the database alone, so a local seed that only sets
 * `ADMIN_PASSWORD` as the demo-user fallback still runs. Email without a
 * password is a configuration error. A later run with the same password keeps
 * the stored hash and the outstanding sessions. A rotated vault password
 * replaces the hash and bumps `tokenVersion`, which rejects every JWT issued
 * before the reset. There is no session table; the token version is the revoke.
 */
export async function upsertStagingAdmin(
  tx: Prisma.TransactionClient,
  scope: { organizationId: string; organizationRoleId: string },
  hashPassword: PasswordHasher = (password) => hash(password, 12),
  passwordsMatch: PasswordComparer = compare
): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return;
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      'Set ADMIN_PASSWORD when ADMIN_EMAIL is set to seed the staging administrator.'
    );
  }

  const name = process.env.ADMIN_NAME?.trim() || 'Workspace Administrator';
  const title = process.env.ADMIN_TITLE?.trim() || 'Administrator';
  const department = process.env.ADMIN_DEPARTMENT?.trim() || 'LEADERSHIP';
  const identity = {
    role: 'ADMIN' as const,
    status: 'ACTIVE' as const,
    organizationRoleId: scope.organizationRoleId,
  };
  const existing = await tx.user.findUnique({
    where: { organizationId_email: { organizationId: scope.organizationId, email } },
    select: { id: true, password: true },
  });
  if (!existing) {
    await tx.user.create({
      data: {
        organizationId: scope.organizationId,
        organizationRoleId: scope.organizationRoleId,
        name,
        email,
        password: await hashPassword(password),
        role: 'ADMIN',
        department,
        title,
        status: 'ACTIVE',
      },
    });
    return;
  }

  let same = false;
  if (existing.password) {
    try {
      same = await passwordsMatch(password, existing.password);
    } catch {
      same = false;
    }
  }
  if (same) {
    await tx.user.update({ where: { id: existing.id }, data: identity });
    return;
  }

  await tx.user.update({
    where: { id: existing.id },
    data: {
      ...identity,
      password: await hashPassword(password),
      passwordChangedAt: new Date(),
      tokenVersion: { increment: 1 },
    },
  });
}
