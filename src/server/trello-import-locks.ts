import { TRPCError } from '@trpc/server';

import type { Prisma } from '@/generated/prisma/client';

// Transaction-scoped locks coordinate every worker connected to this database.
// Taking the person lock first also covers a person importing in two businesses.
export async function acquireTrelloImportLocks(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: string,
  organizationId: string
) {
  for (const key of [
    `trello-import:person:${userId}`,
    `trello-import:business:${organizationId}`,
  ]) {
    const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired
    `;
    if (!lock?.acquired) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'A Trello import is already running for you or this workspace. Try again shortly.',
      });
    }
  }
}
