import { expect, it } from 'vitest';
import { readCounterBranchAssignments } from './counter-branch-access';

it('fails closed until the canonical #107 helper lands', async () => {
  expect(await readCounterBranchAssignments({} as never, 'org-1', 'member-1')).toEqual([]);
});
