import { describe, expect, it } from 'vitest';
import { isTaskAssigneeMembershipViolation } from './task-assignee-membership';

const raised = 'Task assignee must be a member of the task project';

describe('isTaskAssigneeMembershipViolation', () => {
  it('detects the pg adapter error wrapped by Prisma', () => {
    const error = Object.assign(new Error('Invalid prisma.taskAssignee.createMany() invocation'), {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: { originalCode: '23514', originalMessage: raised, kind: 'postgres', code: '23514' },
        },
      },
    });
    expect(isTaskAssigneeMembershipViolation(error)).toBe(true);
  });

  it('detects a raw pg error carrying the constraint name', () => {
    const error = Object.assign(new Error(raised), {
      code: '23514',
      constraint: 'task_assignee_project_membership',
    });
    expect(isTaskAssigneeMembershipViolation(error)).toBe(true);
  });

  it('detects a text-only unknown request error', () => {
    const error = new Error(`Raw query failed. Code: \`23514\`. Message: \`${raised}\``);
    expect(isTaskAssigneeMembershipViolation(error)).toBe(true);
  });

  it('ignores other check violations and unrelated errors', () => {
    expect(
      isTaskAssigneeMembershipViolation(
        Object.assign(new Error('new row violates check constraint "other_check"'), {
          code: '23514',
          constraint: 'other_check',
        })
      )
    ).toBe(false);
    expect(isTaskAssigneeMembershipViolation(new Error(raised))).toBe(false);
    expect(isTaskAssigneeMembershipViolation(null)).toBe(false);
    expect(isTaskAssigneeMembershipViolation('boom')).toBe(false);
  });
});
