import { Prisma } from '@/generated/prisma/client';

/** Serialize every membership mutation for a project behind the same transaction lock. */
export async function lockProjectMembership(
  tx: Prisma.TransactionClient,
  projectId: string
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`project-members:${projectId}`}, 0))`
  );
}
