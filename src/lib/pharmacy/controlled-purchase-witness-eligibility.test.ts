import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('@/lib/abac', () => ({ can: vi.fn() }));

import { can } from '@/lib/abac';
import { isControlledPurchaseWitnessEligible } from './controlled-purchase-witness';

const db = {} as ScopedDb;
const candidate = {
  status: 'ACTIVE',
  user: {
    id: 'qualified-person',
    organizationId: 'org',
    role: 'EMPLOYEE',
    department: 'pharmacy',
    status: 'ACTIVE',
  },
  credential: { revokedAt: null, deviceId: null, lockedUntil: null },
};

describe('controlled purchase witness eligibility', () => {
  beforeEach(() => vi.mocked(can).mockResolvedValue(true));

  it('accepts only the designated, active, unlocked dispenser', async () => {
    await expect(
      isControlledPurchaseWitnessEligible(
        db,
        candidate,
        { organizationId: 'org', actorId: 'receiver' },
        'qualified-person'
      )
    ).resolves.toBe(true);
    expect(can).toHaveBeenCalledWith(candidate.user, 'pharmacy:dispense', undefined, {
      db,
      now: expect.any(Date),
    });
  });

  it.each([
    ['manager without dispensing', candidate, false],
    ['another user', { ...candidate, user: { ...candidate.user, id: 'admin' } }, true],
    [
      'locked PIN',
      {
        ...candidate,
        credential: { ...candidate.credential, lockedUntil: new Date('2999-01-01') },
      },
      true,
    ],
  ])('rejects %s', async (_label, person, dispenseAllowed) => {
    vi.mocked(can).mockResolvedValue(dispenseAllowed);
    await expect(
      isControlledPurchaseWitnessEligible(
        db,
        person,
        { organizationId: 'org', actorId: 'receiver' },
        'qualified-person'
      )
    ).resolves.toBe(false);
  });
});
