import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ uncompLine: vi.fn(), resolveApprover: vi.fn() }));
let registration!: Record<string, unknown>;

vi.mock('@/lib/restaurant/bills', () => ({ uncompLine: mocks.uncompLine }));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  uncompBody: {},
  requireBillInDeviceBranch: vi.fn(),
  resolveApprover: mocks.resolveApprover,
  moneyMutationRoute: (options: Record<string, unknown>) => {
    registration = options;
    return options.run;
  },
}));

import { POST } from './route';

it('gates uncomp and records manager and terminal evidence', async () => {
  mocks.resolveApprover.mockResolvedValue({ ok: true, staffProfileId: 'manager-1' });
  expect(registration!.capability).toBe('orders:complimentary');
  await (POST as unknown as (args: unknown) => Promise<unknown>)({
    ctx: { db: {}, device: { branchId: 'branch-1' }, session: { id: 'session-1' } },
    data: { billId: 'bill-1', billLineId: 'line-1', reason: 'Mistaken comp', approving: {} },
    actor: { staffProfileId: 'operator-1', deviceId: 'device-1', idempotencyKey: 'key-1' },
    now: new Date(),
  });
  expect(mocks.uncompLine).toHaveBeenCalledWith(
    {},
    expect.objectContaining({
      approvingStaffProfileId: 'manager-1',
      terminalSessionId: 'session-1',
    })
  );
});
