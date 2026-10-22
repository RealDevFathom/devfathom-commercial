import { describe, expect, it } from 'vitest';
import { organizationRolePermissionsSchema } from './organization-role-permissions';

describe('organization role permissions', () => {
  it('rejects conflicting effects for the same normalized capability', () => {
    const result = organizationRolePermissionsSchema.safeParse([
      { capability: ' finance:read ', effect: 'ALLOW' },
      { capability: 'finance:read', effect: 'DENY' },
    ]);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: [1, 'capability'],
        message: 'Each capability may appear only once.',
      })
    );
  });

  it('accepts one entry per capability and preserves DENY effects', () => {
    expect(
      organizationRolePermissionsSchema.parse([
        { capability: 'finance:read', effect: 'DENY' },
        { capability: 'finance:write', effect: 'ALLOW' },
      ])
    ).toEqual([
      { capability: 'finance:read', effect: 'DENY' },
      { capability: 'finance:write', effect: 'ALLOW' },
    ]);
  });
});
