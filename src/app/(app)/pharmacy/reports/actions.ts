'use server';

import { revalidatePath } from 'next/cache';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';

export async function updateOwnerDigest(formData: FormData) {
  const caller = pharmacyReportsRouter.createCaller(await createTRPCContext());
  await caller.updateDigest({
    enabled: formData.get('enabled') === 'on',
    localTime: String(formData.get('localTime') ?? ''),
    channel: 'CAPTURE',
  });
  revalidatePath('/pharmacy/reports');
}
