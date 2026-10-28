import { describe, expect, it, vi } from 'vitest';
import { listControlledPinWitnesses } from './controlled-register';
vi.mock('@/lib/abac', () => ({ can: vi.fn().mockResolvedValue(true) }));
describe('controlled witness tenant scope', () => {
  it('requires the explicit tenant on both the profile and user and rejects a foreign user', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'good',
        displayName: 'Qualified',
        user: { id: 'u', organizationId: 'org', status: 'ACTIVE' },
      },
      {
        id: 'foreign',
        displayName: 'Foreign',
        user: { id: 'x', organizationId: 'other', status: 'ACTIVE' },
      },
    ]);
    const result = await listControlledPinWitnesses(
      {
        $queryRaw: vi.fn().mockResolvedValue([{ allowed: false }]),
        restaurantStaffProfile: { findMany },
        user: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ status: 'ACTIVE', role: 'EMPLOYEE', organizationId: 'org' }),
        },
      } as never,
      'org',
      'actor'
    );
    expect(result).toEqual([{ id: 'good', name: 'Qualified' }]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org',
          user: { organizationId: 'org', status: 'ACTIVE' },
          userId: { not: 'actor' },
        }),
      })
    );
  });
});
