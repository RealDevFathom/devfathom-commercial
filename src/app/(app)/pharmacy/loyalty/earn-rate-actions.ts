'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from './loyalty-router';

export type EarnRateFormState = { status: 'idle' | 'saved' | 'error'; message: string };

const field = (form: FormData, name: string) => {
  const value = String(form.get(name) ?? '').trim();
  return value === '' ? undefined : value;
};
const whole = (value: string | undefined) =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;

/** DEV-746: the owner saves a new earning rate; the server validates and versions it. */
export async function saveEarnRate(
  _previous: EarnRateFormState,
  form: FormData
): Promise<EarnRateFormState> {
  try {
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext());
    const option = field(form, 'option') ?? '';
    await caller.setEarnRate({
      option,
      ...(option === 'custom-percent' ? { percent: field(form, 'percent') } : {}),
      ...(option === 'custom-step'
        ? {
            stepPoints: whole(field(form, 'stepPoints')),
            stepRupees: whole(field(form, 'stepRupees')),
          }
        : {}),
    });
    revalidatePath('/pharmacy/loyalty');
    return {
      status: 'saved',
      message: 'Earning rate saved. It applies from now on; points already earned are unchanged.',
    };
  } catch (error) {
    unstable_rethrow(error);
    const denied = error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code);
    return {
      status: 'error',
      message: denied
        ? 'Only an authorized owner can change the earning rate.'
        : 'The rate was not saved. Enter a rate above 0% that pays back no more than 100% of spend.',
    };
  }
}
