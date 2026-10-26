import { TRPCError } from '@trpc/server';
import type { Prisma } from '@/generated/prisma/client';

/** Serialize membership checks and reject projects outside the active organization. */
export async function lockProjectMembershipChanges(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
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
