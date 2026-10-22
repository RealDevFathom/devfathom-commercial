import { describe, expect, it, vi } from 'vitest';
import type { AuthzDb } from '@/lib/authz';
import { can, type Action } from '@/lib/abac';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const subject = { id: 'winback-operator', role: 'ADMIN', department: null, status: 'ACTIVE' };
const sensitive = [
  'pharmacy:dispense',
  'pharmacy:safety',
  'pharmacy:catalogue-review',
] as const satisfies readonly Action[];

function db(rolePermissions: Rule[], permissionOverrides: Rule[] = []): AuthzDb {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: rolePermissions },
        permissionOverrides,
      }),
    },
  } as unknown as AuthzDb;
}

describe('winback pharmacy permission boundary', () => {
  it.each(sensitive)('requires an exact %s grant', async (action) => {
    await expect(
      can(subject, action, undefined, {
        db: db([{ capability: 'pharmacy:*', effect: 'ALLOW' }]),
      })
    ).resolves.toBe(false);
    await expect(
      can(subject, action, undefined, {
        db: db([{ capability: action, effect: 'ALLOW' }]),
      })
    ).resolves.toBe(true);
  });

  it.each(sensitive)('gives an explicit DENY precedence over ALLOW for %s', async (action) => {
    await expect(
      can(subject, action, undefined, {
        db: db(
          [{ capability: action, effect: 'ALLOW' }],
          [{ capability: action, effect: 'DENY' }]
        ),
      })
    ).resolves.toBe(false);
  });
});
