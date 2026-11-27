'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import type { issuePharmacyWalletCardPreview } from '@/lib/pharmacy/loyalty-wallet-pass';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from './loyalty-router';

export type LoyaltyCardFormState = {
  status: 'idle' | 'issued' | 'revoked' | 'error';
  message: string;
  /** Only on `issued`: the code to print, shown once. Never stored by the browser. */
  code?: string;
  /** DEV-747: only on `issued`: the same card as Apple and Google Wallet test passes. */
  walletTestPasses?: Awaited<ReturnType<typeof issuePharmacyWalletCardPreview>>;
};

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

function refusal(error: unknown): LoyaltyCardFormState {
  unstable_rethrow(error);
  if (error instanceof TRPCError) {
    if (['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code))
      return {
        status: 'error',
        message: 'Only an owner or a manager of this branch can issue or revoke loyalty cards.',
      };
    if (error.code === 'NOT_FOUND')
      return { status: 'error', message: 'This customer or branch is no longer available.' };
    if (error.code === 'BAD_REQUEST')
      return {
        status: 'error',
        message:
          error.cause && 'issues' in error.cause
            ? 'Give a reason of 3 to 200 characters, such as "Card lost".'
            : error.message,
      };
  }
  return { status: 'error', message: 'The card was not changed. Try again.' };
}

/** DEV-748: issues a card, or replaces the working one with a reason; the server decides. */
export async function issueLoyaltyCard(
  _previous: LoyaltyCardFormState,
  form: FormData
): Promise<LoyaltyCardFormState> {
  try {
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext());
    const reason = text(form, 'reason');
    const issued = await caller.issueCard({
      branchId: text(form, 'branchId'),
      customerId: text(form, 'customerId'),
      ...(reason ? { reason } : {}),
    });
    revalidatePath('/pharmacy/loyalty');
    return {
      status: 'issued',
      message: issued.replaced
        ? 'New card issued. The old card no longer works; the points balance is unchanged.'
        : 'Card issued.',
      code: issued.code,
      walletTestPasses: issued.walletTestPasses,
    };
  } catch (error) {
    return refusal(error);
  }
}

/** DEV-748: stops the working card (lost, stolen) without issuing another. */
export async function revokeLoyaltyCard(
  _previous: LoyaltyCardFormState,
  form: FormData
): Promise<LoyaltyCardFormState> {
  try {
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext());
    await caller.revokeCard({
      branchId: text(form, 'branchId'),
      customerId: text(form, 'customerId'),
      reason: text(form, 'reason'),
    });
    revalidatePath('/pharmacy/loyalty');
    return {
      status: 'revoked',
      message: 'Card revoked. It no longer works at any branch; the points balance is unchanged.',
    };
  } catch (error) {
    return refusal(error);
  }
}
