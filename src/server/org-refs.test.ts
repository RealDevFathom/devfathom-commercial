import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { assertInOrganization, workspaceId } from './org-refs';

function delegate(found: string[]) {
  const findMany = vi.fn(async () => found.map((id) => ({ id })));
  return { findMany };
}

describe('assertInOrganization', () => {
  it('accepts ids that all belong to the session organization', async () => {
    const users = delegate(['user_a', 'user_b']);
    await assertInOrganization(users, 'org_1', ['user_a', 'user_b', 'user_a', '', null]);
    expect(users.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['user_a', 'user_b'] }, organizationId: 'org_1' },
      select: { id: true },
    });
  });

  it('rejects a referenced row from another organization', async () => {
    const users = delegate(['user_a']);
    await expect(
      assertInOrganization(users, 'org_1', ['user_a', 'user_other'])
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      assertInOrganization(users, 'org_1', ['user_a', 'user_other'])
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
  });

  it('does nothing when the caller supplied no ids', async () => {
    const users = delegate([]);
    await assertInOrganization(users, 'org_1', [undefined, null, '']);
    expect(users.findMany).not.toHaveBeenCalled();
  });

  it('uses the session organization when the host organization is absent', () => {
    expect(
      workspaceId({
        organization: null,
        session: { user: { organizationId: 'org_session' } },
      })
    ).toBe('org_session');
    expect(workspaceId({ organization: { id: 'org_host' }, session: null })).toBe('org_host');
  });
});
