'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from './loyalty-router';

export type MembershipFormState = { status: 'idle' | 'saved' | 'error'; message: string };

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

/**
 * DEV-764: an owner or manager enrols a loyalty member; DEV-909: only the owner deactivates one,
 * for the whole organisation. The server decides.
 */
export async function changeMembership(
  _previous: MembershipFormState,
  form: FormData
): Promise<MembershipFormState> {
  const change = text(form, 'change');
  if (!['enrol', 'deactivate'].includes(change))
    return { status: 'error', message: 'Choose to enrol or deactivate this member.' };
  const active = change === 'enrol';
  try {
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext());
    const result = await caller.setMembership({
      branchId: text(form, 'branchId'),
      customerId: text(form, 'customerId'),
      active,
      reason: text(form, 'reason'),
    });
    revalidatePath('/pharmacy/loyalty');
    return {
      status: 'saved',
      message: !result.changed
        ? active
          ? 'This customer is already an enrolled member.'
          : 'This member is already deactivated.'
        : active
          ? 'Member enrolled. They earn and redeem points again from their next purchase.'
          : 'Member deactivated. Their points are kept but cannot be earned or spent until they are re-enrolled.',
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TRPCError) {
      if (['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code))
        return {
          status: 'error',
          message: active
            ? 'Only an owner or a manager of this branch can enrol a member.'
            : 'Only the owner may deactivate a member for the whole organisation.',
        };
      if (['BAD_REQUEST', 'PRECONDITION_FAILED', 'NOT_FOUND'].includes(error.code))
        return {
          status: 'error',
          message:
            error.code === 'NOT_FOUND'
              ? 'This customer or branch is no longer available.'
              : error.cause && 'issues' in error.cause
                ? 'Give a reason of at least 3 characters.'
                : error.message,
        };
    }
    return { status: 'error', message: 'The membership was not changed. Try again.' };
  }
}
