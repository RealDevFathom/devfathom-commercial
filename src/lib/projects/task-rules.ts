/**
 * The task rules that every writer shares: the projects tRPC router and the
 * assistant's task tools both call these, so a rule cannot hold on one surface
 * and be missing on the other (DEV-1055).
 */

export const ASSIGNEES_MUST_BE_PROJECT_MEMBERS = 'All assignees must be members of the project.';
export const REPLY_TARGET_NOT_IN_TASK = 'Reply target does not belong to this task.';

export class TaskRuleError extends Error {
  constructor(
    message: string,
    readonly rule: 'ASSIGNEE_NOT_PROJECT_MEMBER' | 'REPLY_TARGET_NOT_IN_TASK'
  ) {
    super(message);
    this.name = 'TaskRuleError';
  }
}

type MemberCountDb = {
  projectMember: {
    count(args: { where: { projectId: string; userId: { in: string[] } } }): Promise<number>;
  };
};

type CommentParentDb = {
  taskComment: {
    findUnique(args: {
      where: { id: string };
      select: { taskId: true };
    }): Promise<{ taskId: string } | null>;
  };
};

/**
 * PROJ-05: everyone assigned to a task must be a member of the task's project.
 * Without it an arbitrary or non-member id could be assigned (and emailed).
 */
export async function assertAssigneesAreProjectMembers(
  db: MemberCountDb,
  projectId: string,
  userIds: readonly string[]
): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  const memberCount = await db.projectMember.count({
    where: { projectId, userId: { in: unique } },
  });
  if (memberCount !== unique.length) {
    throw new TaskRuleError(ASSIGNEES_MUST_BE_PROJECT_MEMBERS, 'ASSIGNEE_NOT_PROJECT_MEMBER');
  }
}

/**
 * PROJ-06: a reply's parent must belong to the SAME task, else a parent id from
 * another task threads an orphaned reply across tasks.
 */
export async function assertReplyTargetInTask(
  db: CommentParentDb,
  taskId: string,
  parentId: string | null | undefined
): Promise<void> {
  if (!parentId) return;
  const parent = await db.taskComment.findUnique({
    where: { id: parentId },
    select: { taskId: true },
  });
  if (!parent || parent.taskId !== taskId) {
    throw new TaskRuleError(REPLY_TARGET_NOT_IN_TASK, 'REPLY_TARGET_NOT_IN_TASK');
  }
}

type ColumnDefaultsDb = {
  columnDefaultAssignee: {
    findMany(args: {
      where: ReturnType<typeof eligibleColumnDefaultAssigneeWhere>;
      select: { userId: true };
    }): Promise<{ userId: string }[]>;
  };
};

/**
 * A column's default assignee is added to a task only while they may still work
 * on the column's project: an administrator, or a current member of the project.
 * A default set up earlier does not keep someone on new tasks after they have
 * been removed from the project.
 */
export function eligibleColumnDefaultAssigneeWhere(columnId: string, projectId: string) {
  return {
    columnId,
    user: {
      OR: [{ role: 'ADMIN' as const }, { projectMembers: { some: { projectId } } }],
    },
  };
}

/** The column's default assignees who pass `eligibleColumnDefaultAssigneeWhere`. */
export async function eligibleColumnDefaultAssigneeIds(
  db: ColumnDefaultsDb,
  columnId: string,
  projectId: string
): Promise<string[]> {
  const defaults = await db.columnDefaultAssignee.findMany({
    where: eligibleColumnDefaultAssigneeWhere(columnId, projectId),
    select: { userId: true },
  });
  return defaults.map((row) => row.userId);
}
