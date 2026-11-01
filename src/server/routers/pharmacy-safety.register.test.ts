import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));

import { pharmacySafetyRouter } from './pharmacy-safety';

describe('pharmacy safety register procedures', () => {
  it('does not expose a direct recordControlledEntry mutation', () => {
    expect(Object.keys(pharmacySafetyRouter._def.procedures)).not.toContain(
      'recordControlledEntry'
    );
    expect(Object.keys(pharmacySafetyRouter._def.procedures)).toEqual(
      expect.arrayContaining(['controlledRegister', 'recordCorrection', 'branches', 'access'])
    );
  });
});
