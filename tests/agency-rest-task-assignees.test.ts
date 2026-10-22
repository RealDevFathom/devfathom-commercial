import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { areProjectMembers } from '@/lib/authz';

describe('agency REST task assignee project membership', () => {
  it('accepts only when every distinct assignee is a project member', async () => {
    const count = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const db = { projectMember: { count } } as never;

    await expect(areProjectMembers(db, 'project-1', ['user-1', 'user-1', 'user-2'])).resolves.toBe(
      true
    );
    await expect(areProjectMembers(db, 'project-1', ['user-1', 'user-2'])).resolves.toBe(false);
    expect(count).toHaveBeenCalledWith({
      where: { projectId: 'project-1', userId: { in: ['user-1', 'user-2'] } },
    });
  });

  it('accepts an empty assignment without querying membership', async () => {
    const count = vi.fn();
    const db = { projectMember: { count } } as never;

    await expect(areProjectMembers(db, 'project-1', [])).resolves.toBe(true);
    expect(count).not.toHaveBeenCalled();
  });

  it.each(['src/app/api/v1/tasks/route.ts', 'src/app/api/v1/tasks/[id]/route.ts'])(
    'guards task writes in %s',
    (path) => {
      const route = readFileSync(path, 'utf8');
      expect(route).toContain('areProjectMembers(');
      expect(route).toContain('All assignees must be members of the project.');
    }
  );
});
