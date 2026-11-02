import { hash } from 'bcryptjs';

import type { Prisma } from '../src/generated/prisma/client.js';

export type PlatformAdminSeedResult =
  { status: 'created' | 'updated'; email: string } | { status: 'skipped' };

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
 * Both variables unset leaves any existing hash untouched and reports
 * `skipped`; exactly one set is a configuration error and throws.
 */
export async function upsertPlatformAdmin(
  tx: Prisma.TransactionClient
): Promise<PlatformAdminSeedResult> {
  const email = process.env.PLATFORM_ADMIN_EMAIL;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email && !password) return { status: 'skipped' };
  if (!email || !password) {
    throw new Error(
      'Set both PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD to seed a platform administrator.'
    );
  }

  const normalizedEmail = email.toLowerCase();
  const passwordHash = await hash(password, 12);
  const existing = await tx.platformUser.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  await tx.platformUser.upsert({
    where: { email: normalizedEmail },
    update: { active: true, role: 'SUPER_ADMIN', passwordHash },
    create: {
      name: 'Platform Administrator',
      email: normalizedEmail,
      passwordHash,
      role: 'SUPER_ADMIN',
    },
  });
  return { status: existing ? 'updated' : 'created', email: normalizedEmail };
}

/** One line per seed run, so a missing operator is never silent. */
export function reportPlatformAdmin(
  result: PlatformAdminSeedResult,
  log: Pick<Console, 'log' | 'warn'> = console
): void {
  switch (result.status) {
    case 'created':
      log.log(`✓ Platform operator created: ${result.email}`);
      return;
    case 'updated':
      log.log(`✓ Platform operator updated (password, role, active): ${result.email}`);
      return;
    case 'skipped':
      log.warn(
        '⚠️  PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are both unset: no platform operator ' +
          'was created or updated. Set both and re-run the seed to sign in at /platform.'
      );
  }
}
