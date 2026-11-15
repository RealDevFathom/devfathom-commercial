import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({ adjustPoints: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn().mockResolvedValue({}) }));
vi.mock('./loyalty-router', () => ({
  pharmacyLoyaltyRouter: { createCaller: () => ({ adjustPoints: mocks.adjustPoints }) },
}));

import { adjustPoints } from './adjust-points-actions';

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    branchId: 'branch-a',
    customerId: 'customer-a',
    idempotencyKey: 'key-123456',
    reason: 'Points missed on receipt 1042',
    direction: 'add',
    points: '15',
    ...fields,
  }))
    data.set(key, value);
  return data;
};
const idle = { status: 'idle' as const, message: '' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adjustPoints.mockResolvedValue({
    entryId: 'e',
    points: 15,
    balanceAfter: 40,
    replayed: false,
  });
});

describe('DEV-764 adjust points form action', () => {
  it('sends an addition as positive points and a removal as negative points', async () => {
    await expect(adjustPoints(idle, form({}))).resolves.toEqual({
      status: 'saved',
      message: 'Adjustment recorded. New balance: 40 points.',
    });
    expect(mocks.adjustPoints).toHaveBeenCalledWith({
      branchId: 'branch-a',
      customerId: 'customer-a',
      points: 15,
      reason: 'Points missed on receipt 1042',
      idempotencyKey: 'key-123456',
    });
    await adjustPoints(idle, form({ direction: 'remove', points: '7' }));
    expect(mocks.adjustPoints).toHaveBeenLastCalledWith(expect.objectContaining({ points: -7 }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/pharmacy/loyalty');
  });

  it.each(['0', '-3', '1.5', 'abc', ''])(
    'refuses %j points before calling the server',
    async (points) => {
      await expect(adjustPoints(idle, form({ points }))).resolves.toMatchObject({
        status: 'error',
      });
      expect(mocks.adjustPoints).not.toHaveBeenCalled();
    }
  );

  it('explains a refusal for someone who is not an owner or manager', async () => {
    mocks.adjustPoints.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(adjustPoints(idle, form({}))).resolves.toEqual({
      status: 'error',
      message: 'Only an owner or a manager of this branch can adjust points.',
    });
  });

  it('passes on the server reason for a removal below zero', async () => {
    mocks.adjustPoints.mockRejectedValue(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A removal cannot take the balance below zero.',
      })
    );
    await expect(adjustPoints(idle, form({ direction: 'remove' }))).resolves.toEqual({
      status: 'error',
      message: 'A removal cannot take the balance below zero.',
    });
  });
});
