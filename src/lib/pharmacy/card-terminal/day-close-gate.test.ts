import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { cutPharmacyDailyClose } from '../settlement';
import { OPEN_ATTEMPT_STATUSES } from './open-attempts';

/** DEV-743: the day close refuses while a card-terminal payment on that day is still open. */
function fixture(openAttempts: number) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyDrawerSession: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn() },
    pharmacyCardTerminalAttempt: { count: vi.fn().mockResolvedValue(openAttempts) },
    pharmacyDailyClose: { findFirst: vi.fn(), create: vi.fn() },
  };
}

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'owner-1' };
const businessDate = new Date('2026-11-18T00:00:00.000Z');

describe('DEV-743 day close and open card-terminal payments', () => {
  it('refuses to cut the close, under the day lock, while a terminal payment is open', async () => {
    const db = fixture(1);
    await expect(cutPharmacyDailyClose(db as never, scope, { businessDate })).rejects.toMatchObject(
      { reason: 'CARD_TERMINAL_PAYMENT_OPEN' }
    );
    // The day lock is taken before the count, so an attempt commits either before or after.
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyCardTerminalAttempt.count.mock.invocationCallOrder[0]!
    );
    expect(db.pharmacyCardTerminalAttempt.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        businessDate,
        status: { in: [...OPEN_ATTEMPT_STATUSES] },
      },
    });
    expect(db.pharmacyDailyClose.create).not.toHaveBeenCalled();
  });

  it('counts every state that may hold money, including approved and manual review', () => {
    expect([...OPEN_ATTEMPT_STATUSES].sort()).toEqual(
      ['APPROVED', 'CREATED', 'MANUAL_REVIEW', 'SENT', 'UNKNOWN'].sort()
    );
  });
});
