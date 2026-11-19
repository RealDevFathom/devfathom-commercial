import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({ setMembership: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn().mockResolvedValue({}) }));
vi.mock('./loyalty-router', () => ({
  pharmacyLoyaltyRouter: { createCaller: () => ({ setMembership: mocks.setMembership }) },
}));

import { changeMembership } from './membership-actions';

const form = (change: string) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    branchId: 'branch-a',
    customerId: 'customer-a',
    reason: 'Asked to leave the programme',
    change,
  }))
    data.set(key, value);
  return data;
};
const idle = { status: 'idle' as const, message: '' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setMembership.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
});

describe('DEV-909 membership form refusals', () => {
  it('tells a manager that only the owner may deactivate a member', async () => {
    await expect(changeMembership(idle, form('deactivate'))).resolves.toEqual({
      status: 'error',
      message: 'Only the owner may deactivate a member for the whole organisation.',
    });
    expect(mocks.setMembership).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  });

  it('tells a cashier that an owner or branch manager enrols a member', async () => {
    await expect(changeMembership(idle, form('enrol'))).resolves.toEqual({
      status: 'error',
      message: 'Only an owner or a manager of this branch can enrol a member.',
    });
  });
});
