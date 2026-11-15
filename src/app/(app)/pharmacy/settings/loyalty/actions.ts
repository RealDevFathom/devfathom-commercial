'use server';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyLoyaltyRouter } from '../../loyalty/loyalty-router';

export async function saveLoyaltySettings(
  _previous: { message: string; saved: boolean },
  form: FormData
) {
  try {
    const caller = pharmacyLoyaltyRouter.createCaller(await createTRPCContext());
    await caller.configure({
      option: String(form.get('option')) as 'percent-1',
      percentage: String(form.get('percentage') || '') || undefined,
      pointsPerStep: form.get('pointsPerStep') ? Number(form.get('pointsPerStep')) : undefined,
      spendRupees: form.get('spendRupees') ? Number(form.get('spendRupees')) : undefined,
      khataEnabled: form.get('khataEnabled') === 'on',
      approveReconciliation: (form.get('approveReconciliation') === 'on') as true,
      reconciliationDigest: String(form.get('reconciliationDigest')),
    });
    revalidatePath('/pharmacy/settings/loyalty');
    revalidatePath('/pharmacy/loyalty');
    return { message: 'Earning settings saved. Existing points retain their value.', saved: true };
  } catch (error) {
    unstable_rethrow(error);
    return {
      message:
        'Settings were not saved. Check your rate and permission; reload to review current balances if they changed.',
      saved: false,
    };
  }
}
