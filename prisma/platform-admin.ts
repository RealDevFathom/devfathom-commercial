import { hash } from 'bcryptjs';

import type { Prisma } from '../src/generated/prisma/client.js';

export type PlatformAdminOutcome =
  | { status: 'unset' }
  | { status: 'created' | 'updated'; email: string };

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
export async function upsertPlatformAdmin(
  tx: Prisma.TransactionClient
): Promise<PlatformAdminOutcome> {
  const email = process.env.PLATFORM_ADMIN_EMAIL;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email && !password) return { status: 'unset' };
  if (!email || !password) {
    throw new Error(
      'Set both PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD to seed a platform administrator.'
    );
  }

  const normalizedEmail = email.toLowerCase();
  const existing = await tx.platformUser.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  const passwordHash = await hash(password, 12);
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

type PlatformAdminClient = {
  $transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<T>;
};

type SeedLogger = Pick<Console, 'log' | 'warn'>;

/**
 * DEV-347: commits the platform operator in its OWN transaction, ahead of the
 * tenant demo data. It used to share the seed's single transaction, so any
 * later failure (a demo-data unique constraint, a missing SEED_PASSWORD) rolled
 * the operator back as well and left no way to sign in to the control desk,
 * with nothing in the output saying so. Every outcome is logged, and an unset
 * pair is a visible warning rather than a silent no-op.
 */
export async function provisionPlatformAdmin(
  client: PlatformAdminClient,
  logger: SeedLogger = console
): Promise<PlatformAdminOutcome> {
  logger.log('🛡️  Provisioning platform operator...');
  const outcome = await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    return upsertPlatformAdmin(tx);
  });

  if (outcome.status === 'unset') {
    logger.warn(
      '  ⚠ PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are unset: no platform operator was created or updated. ' +
        'Set both and run `bun run db:seed` again to sign in to the control desk.\n'
    );
  } else {
    logger.log(
      `  ✓ ${outcome.status === 'created' ? 'Created' : 'Updated'} platform operator ${outcome.email} (committed independently of tenant demo data)\n`
    );
  }
  return outcome;
}
