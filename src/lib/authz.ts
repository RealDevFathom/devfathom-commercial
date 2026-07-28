/**
 * Object-level authorization primitives.
 *
 * The app historically authenticated ("are you logged in?") but did NOT
 * authorize at the object level ("are you allowed to touch THIS record?").
 * That gap was the root cause of a family of IDOR / privilege-escalation
 * vulnerabilities across tRPC, the REST agent API, the AI assistant, and the
 * realtime server.
 *
 * These helpers are intentionally framework-agnostic: they take a Prisma
 * client + the acting identity and return booleans / resolved ids. They never
 * throw framework-specific errors, so they can be reused from:
 *   - tRPC routers      (via the throwing wrappers in `src/server/authz.ts`)
 *   - REST /api/v1       (return NextResponse 403)
 *   - the AI assistant   (return an { error } tool result)
 *   - the socket server  (drop the event)
 *
 * Access model:
 *   - Projects (and their boards/columns/tasks): ADMIN, or a ProjectMember.
 *     "manage" (structural / destructive ops) additionally requires LEAD/ADMIN.
 *   - Channels: membership only — NOT admin-overridable, so private DMs stay
 *     private even from admins.
 *   - Meetings: the creator or an attendee can view; creator/ADMIN can manage.
 *   - Notifications: the owner only.
 */
import type { PrismaClient } from '@/generated/prisma/client';

// Accept the base client or any extended/transactional variant.
export type AuthzDb = Pick<
  PrismaClient,
  | 'user'
  | 'projectMember'
  | 'board'
  | 'column'
  | 'task'
  | 'channelMember'
  | 'meeting'
  | 'notification'
>;

export function isAdmin(role?: string | null): boolean {
  return role === 'ADMIN';
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type ProjectMembership = { isMember: boolean; isLead: boolean };

export async function getProjectMembership(
  db: AuthzDb,
  userId: string,
  projectId: string
): Promise<ProjectMembership> {
  const m = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  return { isMember: !!m, isLead: m?.role === 'LEAD' };
}

/** ADMIN or any member of the project — for reads and member-level writes. */
export async function canAccessProject(
  db: AuthzDb,
  userId: string,
  role: string | null | undefined,
  projectId: string
): Promise<boolean> {
  if (isAdmin(role)) return true;
  const { isMember } = await getProjectMembership(db, userId, projectId);
  return isMember;
}

/** ADMIN or a project LEAD — for structural / destructive ops (delete, board/column changes). */
export async function canManageProject(
  db: AuthzDb,
  userId: string,
  role: string | null | undefined,
  projectId: string
): Promise<boolean> {
  if (isAdmin(role)) return true;
  const { isLead } = await getProjectMembership(db, userId, projectId);
  return isLead;
}

// --- Resolve a child entity up to its owning projectId (null if not found) ---

export async function projectIdOfBoard(db: AuthzDb, boardId: string): Promise<string | null> {
  const b = await db.board.findUnique({ where: { id: boardId }, select: { projectId: true } });
  return b?.projectId ?? null;
}

export async function projectIdOfColumn(db: AuthzDb, columnId: string): Promise<string | null> {
  const c = await db.column.findUnique({
    where: { id: columnId },
    select: { board: { select: { projectId: true } } },
  });
  return c?.board?.projectId ?? null;
}

export async function projectIdOfTask(db: AuthzDb, taskId: string): Promise<string | null> {
  const t = await db.task.findUnique({
    where: { id: taskId },
    select: { column: { select: { board: { select: { projectId: true } } } } },
  });
  return t?.column?.board?.projectId ?? null;
}

// ---------------------------------------------------------------------------
// Channels (membership only — no admin bypass; DMs are private)
// ---------------------------------------------------------------------------

export async function isChannelMember(
  db: AuthzDb,
  userId: string,
  channelId: string
): Promise<boolean> {
  const m = await db.channelMember.findUnique({
    where: { channelId_userId: { channelId, userId } },
    select: { id: true },
  });
  return !!m;
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/** Creator or ADMIN may edit/delete a meeting. */
export async function canManageMeeting(
  db: AuthzDb,
  userId: string,
  role: string | null | undefined,
  meetingId: string
): Promise<boolean> {
  if (isAdmin(role)) return true;
  const m = await db.meeting.findUnique({
    where: { id: meetingId },
    select: { createdById: true },
  });
  return m?.createdById === userId;
}

/** Creator, an attendee, or ADMIN may view a meeting. */
export async function canAccessMeeting(
  db: AuthzDb,
  userId: string,
  role: string | null | undefined,
  meetingId: string
): Promise<boolean> {
  if (isAdmin(role)) return true;
  const m = await db.meeting.findUnique({
    where: { id: meetingId },
    select: {
      createdById: true,
      attendees: { where: { userId }, select: { id: true } },
    },
  });
  if (!m) return false;
  return m.createdById === userId || m.attendees.length > 0;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function ownsNotification(
  db: AuthzDb,
  userId: string,
  notificationId: string
): Promise<boolean> {
  const n = await db.notification.findUnique({
    where: { id: notificationId },
    select: { userId: true },
  });
  return n?.userId === userId;
}
