import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { actorCanProcure } from './procurement-access';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

function dbWith(overrides: Rule[], role: Rule[]) {
  const member = { id: 'user-1', role: 'EMPLOYEE', department: null, status: 'ACTIVE' };
  return {
    user: {
      findUnique: vi.fn()
        .mockResolvedValueOnce(member)
        .mockResolvedValueOnce({ organizationRole: { permissions: role }, permissionOverrides: overrides }),
    },
  } as unknown as ScopedDb;
}

describe('actorCanProcure', () => {
  it.each([
    { overrides: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }], role: [{ capability: 'pharmacy:procurement', effect: 'DENY' }] },
    { overrides: [{ capability: 'pharmacy:procurement', effect: 'DENY' }], role: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }] },
    { overrides: [{ capability: 'pharmacy:*', effect: 'DENY' }], role: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }] },
  ] as const)('denies conflicting rules with a DENY', async ({ overrides, role }) => {
    await expect(actorCanProcure(dbWith(overrides, role), 'user-1')).resolves.toBe(false);
  });

  it('allows a pharmacy wildcard because procurement is not exact-grant-only', async () => {
    await expect(actorCanProcure(dbWith([], [{ capability: 'pharmacy:*', effect: 'ALLOW' }]), 'user-1')).resolves.toBe(true);
  });
});
