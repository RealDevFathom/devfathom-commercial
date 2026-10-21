import { expect, it, vi } from 'vitest';
import { readCounterBranchAssignments } from './counter-branch-access';

it('reads active assignments and active branches only within the session organization', async () => {
  const findMany = vi.fn(async () => [{ branchId: 'branch-1' }]);
  expect(
    await readCounterBranchAssignments(
      { pharmacyBranchAssignment: { findMany } } as never,
      'org-1',
      'member-1'
    )
  ).toEqual([{ branchId: 'branch-1' }]);
  expect(findMany).toHaveBeenCalledWith({
    where: {
      organizationId: 'org-1',
      userId: 'member-1',
      active: true,
      branch: { active: true, organizationId: 'org-1' },
    },
    select: { branchId: true },
  });
});
