import { TRPCError } from '@trpc/server';

type IdRow = { id: string };

type OrgRefDelegate = {
  findMany: (args: {
    where: { id: { in: string[] }; organizationId: string };
    select: { id: true };
  }) => Promise<IdRow[]>;
};

/**
 * Client-supplied ids are checked with an explicit organization predicate.
 * A foreign-key check does not apply row level security, so existence in the
 * referenced table is not proof the row belongs to this workspace.
 */
export async function assertInOrganization(
  delegate: OrgRefDelegate,
  organizationId: string,
  ids: ReadonlyArray<string | null | undefined>
): Promise<void> {
  const unique = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ];
  if (unique.length === 0) return;
  const rows = await delegate.findMany({
    where: { id: { in: unique }, organizationId },
    select: { id: true },
  });
  if (rows.length !== unique.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
  }
}

export function workspaceId(ctx: {
  organization: { id: string } | null;
  session: { user: { organizationId?: string | null } } | null;
}): string {
  const id = ctx.organization?.id ?? ctx.session?.user.organizationId;
  if (!id) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  return id;
}
