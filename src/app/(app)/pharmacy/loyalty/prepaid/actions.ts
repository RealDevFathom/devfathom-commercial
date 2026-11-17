'use server';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyPrepaidRouter } from '../prepaid-router';
export type PrepaidFormState = {
  status: 'idle' | 'saved' | 'error';
  message: string;
  receipt?: {
    id: string;
    amountMinor: number;
    balanceMinor: number;
    refundable: boolean | null;
    tier: string | null;
    createdAt: string;
  };
};
export async function savePrepaid(
  _state: PrepaidFormState,
  form: FormData
): Promise<PrepaidFormState> {
  try {
    const caller = pharmacyPrepaidRouter.createCaller(await createTRPCContext());
    const tiers = JSON.parse(String(form.get('tiers') ?? '[]'));
    await caller.save({ refundable: form.get('refundable') === 'on', tiers });
    revalidatePath('/pharmacy/loyalty/prepaid');
    return {
      status: 'saved',
      message:
        'Dated tier settings saved. Future upfront payments use these settings; existing funds keep their receipt terms.',
    };
  } catch (error) {
    unstable_rethrow(error);
    return {
      status: 'error',
      message:
        error instanceof TRPCError && error.code === 'FORBIDDEN'
          ? 'Only an authorized owner can save tiers.'
          : 'Settings were not saved. Enter unique tier names and amounts, and discounts above 0% up to 99.99%.',
    };
  }
}
export async function recordPrepaid(
  _state: PrepaidFormState,
  form: FormData
): Promise<PrepaidFormState> {
  try {
    const caller = pharmacyPrepaidRouter.createCaller(await createTRPCContext());
    const amount = String(form.get('amount') ?? '');
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(amount))
      return { status: 'error', message: 'Enter a positive amount with up to two decimals.' };
    const [whole, fraction = ''] = amount.split('.');
    const entry = await caller.move({
      branchId: String(form.get('branchId')),
      customerId: String(form.get('customerId')),
      deviceId: String(form.get('deviceId')),
      amountMinor: Number(whole) * 100 + Number(fraction.padEnd(2, '0')),
      idempotencyKey: String(form.get('idempotencyKey')),
      kind: form.get('kind') === 'REFUND' ? 'REFUND' : 'PAYMENT',
      ...(form.get('pin') ? { pin: String(form.get('pin')) } : {}),
      ...(form.get('kind') !== 'REFUND' && form.get('customerPin')
        ? { customerPin: String(form.get('customerPin')) }
        : {}),
    });
    revalidatePath('/pharmacy/loyalty/prepaid');
    return {
      status: 'saved',
      message: 'Payment recorded. Print the receipt for the customer.',
      receipt: {
        id: entry.id,
        amountMinor: entry.amountMinor,
        balanceMinor: entry.balanceAfterMinor,
        refundable: entry.refundable,
        tier: entry.tierAfter,
        createdAt: entry.createdAt.toISOString(),
      },
    };
  } catch (error) {
    unstable_rethrow(error);
    return {
      status: 'error',
      message:
        error instanceof TRPCError && error.code === 'BAD_REQUEST'
          ? error.message
          : 'Payment was not confirmed. Check owner access, the open drawer and PIN for refunds. Retry with the same reference; do not collect money again.',
    };
  }
}
export async function setCustomerPrepaidPin(
  _state: PrepaidFormState,
  form: FormData
): Promise<PrepaidFormState> {
  try {
    const caller = pharmacyPrepaidRouter.createCaller(await createTRPCContext());
    await caller.setPin({
      customerId: String(form.get('customerId')),
      customerPin: String(form.get('customerPin') ?? ''),
    });
    return { status: 'saved', message: 'The customer’s new prepaid PIN is set.' };
  } catch (error) {
    unstable_rethrow(error);
    return {
      status: 'error',
      message:
        error instanceof TRPCError && error.code === 'FORBIDDEN'
          ? 'Only the owner can set a customer’s prepaid PIN.'
          : 'PIN not set. Ask the customer to enter 4 to 8 digits.',
    };
  }
}
