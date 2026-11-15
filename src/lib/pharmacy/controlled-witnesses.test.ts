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
      { restaurantStaffProfile: { findMany } } as never,
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

  it('offers a named qualified person only while their PIN is not locked out', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await listControlledPinWitnesses(
      { restaurantStaffProfile: { findMany } } as never,
      'org',
      'actor',
      'qualified-user'
    );
    const where = findMany.mock.calls[0]![0].where;
    expect(where.userId).toBe('qualified-user');
    expect(where.credentials.some).toMatchObject({ type: 'PIN', revokedAt: null, deviceId: null });
    expect(where.credentials.some.OR).toEqual([
      { lockedUntil: null },
      { lockedUntil: { lte: expect.any(Date) } },
    ]);
  });

  it('does not filter on lockout when listing any other pharmacist', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await listControlledPinWitnesses(
      { restaurantStaffProfile: { findMany } } as never,
      'org',
      'actor'
    );
    expect(findMany.mock.calls[0]![0].where.credentials).toEqual({
      some: { type: 'PIN', revokedAt: null, deviceId: null },
    });
  });
});
