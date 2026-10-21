import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ compLine: vi.fn(), requireBill: vi.fn(), resolveApprover: vi.fn() }));

vi.mock('@/lib/restaurant/bills', () => ({ compLine: mocks.compLine }));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  compBody: {},
  requireBillInDeviceBranch: mocks.requireBill,
  resolveApprover: mocks.resolveApprover,
  moneyMutationRoute: (options: { run: (args: unknown) => Promise<unknown> }) => options.run,
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApprover.mockResolvedValue({ ok: true, staffProfileId: 'manager-1' });
});

it('pins the authenticated terminal session on comp audit evidence', async () => {
  const actor = { staffProfileId: 'operator-1', deviceId: 'device-1', idempotencyKey: 'key-1' };
  await (POST as unknown as (args: unknown) => Promise<unknown>)({
    ctx: {
      db: {},
      device: { id: 'device-1', branchId: 'branch-1' },
      session: { id: 'session-1' },
    },
    data: {
      billId: 'bill-1',
      billLineId: 'line-1',
      reason: 'Guest recovery',
      approving: {},
    },
    actor,
    now: new Date('2026-10-21T18:00:00.000Z'),
  });

  expect(mocks.compLine).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ terminalSessionId: 'session-1', actor })
  );
});
