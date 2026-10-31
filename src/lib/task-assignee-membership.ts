/**
 * The `task_assignee_project_membership` trigger (migration
 * 20261026120000_enforce_task_assignee_membership) raises SQLSTATE 23514 when
 * an assignment loses its project membership between the application check
 * and the write: a concurrent member removal or task move won the race. The
 * transaction rolls back, so callers report a retryable conflict instead of a
 * generic server error.
 */
export const TASK_ASSIGNEE_MEMBERSHIP_CONFLICT_MESSAGE =
  'The project membership or task changed while saving assignees. Reload and try again.';

const CONSTRAINT = 'task_assignee_project_membership';
const RAISED_MESSAGE = 'Task assignee must be a member of the task project';
const NESTED_KEYS = ['cause', 'originalError', 'driverError', 'driverAdapterError', 'meta'];

function walk(value: unknown, visit: (record: Record<string, unknown>) => boolean): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (visit(record)) return true;
    for (const key of NESTED_KEYS) stack.push(record[key]);
  }
  return false;
}

function mentionsConstraint(text: unknown): boolean {
  return typeof text === 'string' && (text.includes(CONSTRAINT) || text.includes(RAISED_MESSAGE));
}

export function isTaskAssigneeMembershipViolation(error: unknown): boolean {
  // Prisma surfaces the pg adapter error structurally (code/originalCode), or
  // only as text on an unknown-request error, so accept either form.
  const checkViolation = walk(
    error,
    (r) =>
      r.code === '23514' ||
      r.originalCode === '23514' ||
      r.sqlState === '23514' ||
      (typeof r.message === 'string' && r.message.includes('23514'))
  );
  if (!checkViolation) return false;
  return walk(error, (r) => {
    if (mentionsConstraint(r.message) || mentionsConstraint(r.originalMessage)) return true;
    const constraint = r.constraint;
    if (mentionsConstraint(constraint)) return true;
    return (
      !!constraint &&
      typeof constraint === 'object' &&
      mentionsConstraint((constraint as Record<string, unknown>).name)
    );
  });
}
