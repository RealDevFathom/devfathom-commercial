import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { assertSaleLinesCleared } from './rx-gate';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' };

// One unfilled, unauthorized CONTROLLED sale line — the gate refuses it unless a
// #111 emergency supply clears it on a permitted schedule.
function controlledLineDb(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn(async () => [{ id: 'line-1', rx: false, restricted: false, controlled: true }]),
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

  it('clears an emergency supply recorded on a permitted schedule', async () => {
    const followUp = vi.fn(async () => [{ saleLineId: 'line-1', schedule: 'G' }]);
    const db = controlledLineDb({
      pharmacyEmergencyRxFollowUp: { findMany: followUp },
      branchRegulatoryProfile: { findFirst: vi.fn(async () => ({ permittedSchedules: ['G', 'H'] })) },
    });
    await expect(assertSaleLinesCleared(db as never, scope, 'sale-1')).resolves.toBeUndefined();
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ saleLineId: { in: ['line-1'] } }) })
    );
  });

  it('still refuses an emergency supply on a schedule the branch may not dispense', async () => {
    const db = controlledLineDb({
      pharmacyEmergencyRxFollowUp: {
        findMany: vi.fn(async () => [{ saleLineId: 'line-1', schedule: 'K' }]),
      },
      branchRegulatoryProfile: { findFirst: vi.fn(async () => ({ permittedSchedules: ['G'] })) },
    });
    await expect(assertSaleLinesCleared(db as never, scope, 'sale-1')).rejects.toThrow('SAFETY_BLOCK');
  });

  it('fails closed when the emergency supply carries no resolvable schedule', async () => {
    const db = controlledLineDb({
      pharmacyEmergencyRxFollowUp: {
        findMany: vi.fn(async () => [{ saleLineId: 'line-1', schedule: null }]),
      },
      branchRegulatoryProfile: { findFirst: vi.fn(async () => ({ permittedSchedules: ['G'] })) },
    });
    await expect(assertSaleLinesCleared(db as never, scope, 'sale-1')).rejects.toThrow('SAFETY_BLOCK');
  });
});
