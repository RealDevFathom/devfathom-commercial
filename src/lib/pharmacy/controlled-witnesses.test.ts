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
        restaurantStaffProfile: { findMany },
        user: { findFirst: vi.fn().mockResolvedValue(null) },
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

it('includes the sole owner in PIN witnesses so the existing picker supports solo mode', async () => {
  const owner = {
    id: 'owner-profile',
    displayName: 'Owner',
    user: { id: 'actor', organizationId: 'org', status: 'ACTIVE' },
  };
  const findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([owner]);
  const db = {
    restaurantStaffProfile: { findMany },
    user: {
      findFirst: vi.fn().mockResolvedValue({ id: 'actor' }),
      count: vi.fn().mockResolvedValue(1),
    },
  };
  await expect(listControlledPinWitnesses(db as never, 'org', 'actor')).resolves.toEqual([
    { id: 'owner-profile', name: 'Owner' },
  ]);
  expect(findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ organizationId: 'org', userId: 'actor' }),
    })
  );
});
