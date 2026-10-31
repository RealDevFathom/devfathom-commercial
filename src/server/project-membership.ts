import { TRPCError } from '@trpc/server';
import type { Prisma, PrismaClient } from '@/generated/prisma/client';

type MembershipTransaction = Pick<Prisma.TransactionClient, '$queryRaw'>;
const membershipQueues = new WeakMap<MembershipTransaction, Map<string, Promise<void>>>();

/** Serialize complete checks and writes, including callers sharing one transaction. */
export async function withProjectMembershipChanges<T>(
  db: Pick<PrismaClient, '$transaction'>,
  projectId: string,
  organizationId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    let queues = membershipQueues.get(tx);
    if (!queues) {
      queues = new Map();
      membershipQueues.set(tx, queues);
    }

    // FOR UPDATE excludes other transactions, but is reentrant within the same
    // transaction. A tRPC batch shares that client, so queue the entire operation.
    const result = (queues.get(projectId) ?? Promise.resolve()).then(async () => {
      await lockProjectMembershipChanges(tx, projectId, organizationId);
      return operation(tx);
    });
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    queues.set(projectId, settled);
    try {
      return await result;
    } finally {
      if (queues.get(projectId) === settled) queues.delete(projectId);
    }
  });
}

/** Exclude other transactions and reject projects outside the active organization. */
export async function lockProjectMembershipChanges(
  tx: MembershipTransaction,
  projectId: string,
  organizationId: string
): Promise<void> {
  const projects = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "projects"
    WHERE "id" = ${projectId} AND "organizationId" = ${organizationId}
    FOR UPDATE
  `;
  if (projects.length !== 1) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found.' });
  }
}
