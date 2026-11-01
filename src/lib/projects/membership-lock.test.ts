import { describe, expect, it, vi } from 'vitest';

import { lockProjectMembership } from './membership-lock';

describe('lockProjectMembership', () => {
  it('uses a stable, project-scoped advisory lock key', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const tx = { $queryRaw: queryRaw };

    await lockProjectMembership(tx as never, 'project-1');
    await lockProjectMembership(tx as never, 'project-2');

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw.mock.calls[0][0].values).toEqual(['project-members:project-1']);
    expect(queryRaw.mock.calls[1][0].values).toEqual(['project-members:project-2']);
    expect(queryRaw.mock.calls[0][0].strings.join('?')).toContain('pg_advisory_xact_lock');
  });
});
