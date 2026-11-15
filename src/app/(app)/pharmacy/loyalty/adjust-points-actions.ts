'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from './loyalty-router';

export type AdjustPointsFormState = { status: 'idle' | 'saved' | 'error'; message: string };

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

/** DEV-764: an owner or manager adds or removes points with a reason; the server decides. */
export async function adjustPoints(
  _previous: AdjustPointsFormState,
  form: FormData
): Promise<AdjustPointsFormState> {
  const direction = text(form, 'direction');
  const amount = text(form, 'points');
  if (!/^\d{1,7}$/.test(amount) || Number(amount) === 0 || !['add', 'remove'].includes(direction))
    return { status: 'error', message: 'Enter a whole number of points above 0.' };
  try {
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext());
    const result = await caller.adjustPoints({
      branchId: text(form, 'branchId'),
      customerId: text(form, 'customerId'),
      points: direction === 'remove' ? -Number(amount) : Number(amount),
      reason: text(form, 'reason'),
      idempotencyKey: text(form, 'idempotencyKey'),
    });
    revalidatePath('/pharmacy/loyalty');
    return {
      status: 'saved',
      message:
        result.balanceAfter === null
          ? 'This adjustment was already recorded.'
          : `Adjustment recorded. New balance: ${result.balanceAfter} points.`,
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TRPCError) {
      if (['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code))
        return {
          status: 'error',
          message: 'Only an owner or a manager of this branch can adjust points.',
        };
      if (['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND'].includes(error.code))
        return {
          status: 'error',
          message:
            error.code === 'NOT_FOUND'
              ? 'This customer or branch is no longer available.'
              : error.cause && 'issues' in error.cause
                ? // Input validation: the schema's message is not written for people.
                  'Enter a whole number of points above 0 and a reason of at least 3 characters.'
                : error.message,
        };
    }
    return { status: 'error', message: 'The adjustment was not saved. Try again.' };
  }
}
