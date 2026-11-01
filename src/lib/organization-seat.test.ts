import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(async () => ({ seatLimit: 1 })),
}));

import { lockOrganizationSeat } from './organization-seat';

describe('lockOrganizationSeat', () => {
  it('only exempts an already occupied user from the organization being locked', async () => {
    const findFirst = vi.fn(async () => null);
    const count = vi.fn(async () => 1);
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'org_acme' }]),
      user: { findFirst, count },
    };

    await expect(
      lockOrganizationSeat(
        tx as never,
        'org_acme',
        1,
        'user_from_another_organization'
      )
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'user_from_another_organization', organizationId: 'org_acme' },
      select: { status: true },
    });
    expect(count).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: 'org_acme',
        status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] },
      },
    });
  });
});
