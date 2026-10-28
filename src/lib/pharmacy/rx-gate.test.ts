import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { assertSaleLinesCleared } from './rx-gate';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' };

// One unfilled, unauthorized CONTROLLED sale line — the gate refuses it unless a
// #111 emergency supply clears it while its follow-up remains open.
function controlledLineDb(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn(async () => [
      { id: 'line-1', rx: false, restricted: false, controlled: true },
    ]),
    pharmacyRxLineAuthorization: { findMany: vi.fn(async () => []) },
    prescriptionFill: { findMany: vi.fn(async () => []) },
    ...overrides,
  };
}

describe('assertSaleLinesCleared — #111 emergency supply (d)', () => {
  it('refuses a controlled line when no emergency path is present (this branch)', async () => {
    await expect(
      assertSaleLinesCleared(controlledLineDb() as never, scope, 'sale-1')
    ).rejects.toThrow('SAFETY_BLOCK');
  });

  it('clears an emergency supply by reading the follow-up status field', async () => {
    const followUp = vi.fn(async (args: { select: Record<string, boolean> }) => {
      // Match Prisma's real model shape so a regression to the non-existent
      // `schedule` selection fails this path instead of being hidden by the mock.
      expect(args.select).toEqual({ saleLineId: true, status: true });
      return [{ saleLineId: 'line-1', status: 'OPEN' }];
    });
    const db = controlledLineDb({
      pharmacyEmergencyRxFollowUp: { findMany: followUp },
    });
    await expect(assertSaleLinesCleared(db as never, scope, 'sale-1')).resolves.toBeUndefined();
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ saleLineId: { in: ['line-1'] } }),
      })
    );
  });

  it('refuses an emergency supply whose follow-up is no longer open', async () => {
    const db = controlledLineDb({
      pharmacyEmergencyRxFollowUp: {
        findMany: vi.fn(async () => [{ saleLineId: 'line-1', status: 'CLOSED' }]),
      },
    });
    await expect(assertSaleLinesCleared(db as never, scope, 'sale-1')).rejects.toThrow(
      'SAFETY_BLOCK'
    );
  });
});
