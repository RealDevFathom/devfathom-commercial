import { describe, expect, it, vi } from 'vitest';
import { can, subjectFromSession } from '@/lib/abac';

const authorizationDb = (permissionOverrides: { capability: string; effect: string }[]) =>
  ({
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: {
          permissions: [{ capability: 'projects:write', effect: 'ALLOW' }],
        },
        permissionOverrides,
      }),
    },
  }) as never;

describe('project write authorization', () => {
  it('allows an active agency member by default', async () => {
    const subject = subjectFromSession({ id: 'user_1', role: 'EMPLOYEE', status: 'ACTIVE' });

    await expect(
      can(subject, 'projects:write', undefined, { db: authorizationDb([]) })
    ).resolves.toBe(true);
  });

  it('lets an exact DENY override an ALLOW before a project write', async () => {
    const subject = subjectFromSession({ id: 'user_1', role: 'ADMIN', status: 'ACTIVE' });
    const db = authorizationDb([{ capability: 'projects:write', effect: 'DENY' }]);

    await expect(can(subject, 'projects:write', undefined, { db })).resolves.toBe(false);
  });
});
