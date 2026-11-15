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
    const expiryDays = field(form, 'expiryDays');
    if (expiryDays !== undefined && whole(expiryDays) === undefined)
      return {
        status: 'error',
        message: 'Enter the expiry as a whole number of days, or leave it blank.',
      };
    await caller.setEarnRate({
      option,
      // DEV-764: every save states the full program, so the new version is exactly what is shown.
      pointValue: field(form, 'pointValue'),
      expiryDays: expiryDays === undefined ? null : whole(expiryDays),
      khataEarns: form.get('khataEarns') === 'on',
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
      message:
        'Loyalty settings saved as a new version. They apply from now on; points already earned keep the rate they were earned at.',
    };
  } catch (error) {
    unstable_rethrow(error);
    const denied = error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code);
    return {
      status: 'error',
      message: denied
        ? 'Only an authorized owner can change the earning rate.'
        : 'The rate was not saved. Enter a rate above 0% that pays back no more than 100% of spend at the point value, a point value from PKR 0.01 to PKR 1,000, and an expiry from 1 to 3,650 days or blank.',
    };
  }
}
