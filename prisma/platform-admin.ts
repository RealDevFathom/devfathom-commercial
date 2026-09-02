import { hash } from 'bcryptjs';

import type { Prisma } from '../src/generated/prisma/client.js';

/**
 * Applies `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` to the platform
 * administrator, on every deployment rather than only on the first one.
 *
 * The upsert's `update` branch used to carry `{ active, role }` alone, so a
 * rotated password reached a NEW platform administrator and never an existing
 * one: every staging redeploy left the previous hash in place while reporting
 * success. Extracted from `seed.ts` so it stays callable from both the fresh
 * seed and the "seed data already present" refresh, and so it is testable
 * without executing the seed.
 *
 * Both variables unset leaves any existing hash untouched; exactly one set is
 * a configuration error and throws.
 */
export async function upsertPlatformAdmin(tx: Prisma.TransactionClient): Promise<void> {
  const email = process.env.PLATFORM_ADMIN_EMAIL;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!email || !password) {
    throw new Error(
      'Set both PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD to seed a platform administrator.'
    );
  }

  const passwordHash = await hash(password, 12);
  await tx.platformUser.upsert({
    where: { email: email.toLowerCase() },
    update: { active: true, role: 'SUPER_ADMIN', passwordHash },
    create: {
      name: 'Platform Administrator',
      email: email.toLowerCase(),
      passwordHash,
      role: 'SUPER_ADMIN',
    },
  });
}
