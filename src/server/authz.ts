/**
 * tRPC-facing authorization wrappers.
 *
 * Thin layer over the framework-agnostic predicates in `src/lib/authz.ts`.
 * Each `assert*` throws a TRPCError (FORBIDDEN / NOT_FOUND) so router code
 * reads as a one-liner guard:
 *
 *   await assertProjectAccess(ctx, input.projectId);            // member or admin
 *   await assertProjectAccess(ctx, input.projectId, { manage: true }); // lead or admin
 *   await assertTaskAccess(ctx, input.taskId);
 *
 * Always place the guard BEFORE the mutation/read it protects.
 */
import { TRPCError } from '@trpc/server';
import * as authz from '@/lib/authz';

/** The shape every protectedProcedure ctx satisfies once auth has run. */
type AuthedCtx = {
  db: authz.AuthzDb;
  session: { user: { id: string; role?: string | null } };
};

type AccessOpts = { manage?: boolean };

const FORBIDDEN = (message = 'You do not have access to this resource') =>
  new TRPCError({ code: 'FORBIDDEN', message });

const NOT_FOUND = (message = 'Not found') => new TRPCError({ code: 'NOT_FOUND', message });

// --- Projects --------------------------------------------------------------

export async function assertProjectAccess(
  ctx: AuthedCtx,
  projectId: string,
  opts: AccessOpts = {}
): Promise<void> {
  const { id, role } = ctx.session.user;
  const ok = opts.manage
    ? await authz.canManageProject(ctx.db, id, role, projectId)
    : await authz.canAccessProject(ctx.db, id, role, projectId);
  if (!ok) throw FORBIDDEN();
}

export async function assertBoardAccess(
  ctx: AuthedCtx,
  boardId: string,
  opts: AccessOpts = {}
): Promise<void> {
  const projectId = await authz.projectIdOfBoard(ctx.db, boardId);
  if (!projectId) throw NOT_FOUND('Board not found');
  await assertProjectAccess(ctx, projectId, opts);
}

export async function assertColumnAccess(
  ctx: AuthedCtx,
  columnId: string,
  opts: AccessOpts = {}
): Promise<void> {
  const projectId = await authz.projectIdOfColumn(ctx.db, columnId);
  if (!projectId) throw NOT_FOUND('Column not found');
  await assertProjectAccess(ctx, projectId, opts);
}

export async function assertTaskAccess(
  ctx: AuthedCtx,
  taskId: string,
  opts: AccessOpts = {}
): Promise<void> {
  const projectId = await authz.projectIdOfTask(ctx.db, taskId);
  if (!projectId) throw NOT_FOUND('Task not found');
  await assertProjectAccess(ctx, projectId, opts);
}

// --- Channels --------------------------------------------------------------

export async function assertChannelMember(ctx: AuthedCtx, channelId: string): Promise<void> {
  if (!(await authz.isChannelMember(ctx.db, ctx.session.user.id, channelId))) {
    throw FORBIDDEN('You are not a member of this channel');
  }
}

// --- Meetings --------------------------------------------------------------

export async function assertMeetingManage(ctx: AuthedCtx, meetingId: string): Promise<void> {
  const { id, role } = ctx.session.user;
  if (!(await authz.canManageMeeting(ctx.db, id, role, meetingId))) {
    throw FORBIDDEN('Only the meeting creator or an admin can do that');
  }
}

export async function assertMeetingAccess(ctx: AuthedCtx, meetingId: string): Promise<void> {
  const { id, role } = ctx.session.user;
  if (!(await authz.canAccessMeeting(ctx.db, id, role, meetingId))) {
    throw FORBIDDEN('You do not have access to this meeting');
  }
}

// --- Notifications ---------------------------------------------------------

export async function assertNotificationOwner(
  ctx: AuthedCtx,
  notificationId: string
): Promise<void> {
  if (!(await authz.ownsNotification(ctx.db, ctx.session.user.id, notificationId))) {
    throw FORBIDDEN('That notification does not belong to you');
  }
}
