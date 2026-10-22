import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  reverseComp: vi.fn(),
  resolveApprover: vi.fn(),
  run: undefined as ((args: Record<string, unknown>) => Promise<unknown>) | undefined,
}));

vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('@/lib/restaurant/bills', () => ({ reverseComp: mocks.reverseComp }));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  reverseCompBody: {},
  requireBillInDeviceBranch: vi.fn(),
  resolveApprover: mocks.resolveApprover,
  moneyMutationRoute: (options: { run: typeof mocks.run }) => {
    mocks.run = options.run;
    return vi.fn();
  },
}));

describe('reverse comp authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails before approval or mutation when central can() denies orders:complimentary', async () => {
    await import('./route');
    mocks.can.mockResolvedValue(false);
    const findFirst = vi.fn().mockResolvedValue({
      user: { id: 'user-1', role: 'EMPLOYEE', department: null, status: 'ACTIVE' },
    });

    const response = await mocks.run!({
      ctx: {
        db: { restaurantStaffProfile: { findFirst } },
        device: { id: 'device-1', branchId: 'branch-1' },
        session: { id: 'session-1' },
      },
      data: {
        billId: 'bill-1',
        billLineId: 'line-1',
        reason: 'wrong line',
        approving: { staffProfileId: 'manager-1', type: 'PIN', secret: 'not-logged' },
      },
      actor: { staffProfileId: 'staff-1', deviceId: 'device-1', idempotencyKey: 'key-1' },
      now: new Date('2026-10-22T00:00:00.000Z'),
    });

    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'orders:complimentary',
      undefined,
      expect.objectContaining({ db: expect.anything() })
    );
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
    expect(mocks.resolveApprover).not.toHaveBeenCalled();
    expect(mocks.reverseComp).not.toHaveBeenCalled();
  });
});
