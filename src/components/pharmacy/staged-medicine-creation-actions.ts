'use server';

import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyMedicineRouter } from '@/server/routers/pharmacy-medicine';

/** DEV-912: plain-words result for the bulk creation controls; the server checks every step. */
async function readable<T>(run: () => Promise<T>) {
  try {
    return { data: await run() };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TRPCError) {
      if (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
        return { error: 'You need catalogue edit or review permission for this.' };
      if (['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND', 'PRECONDITION_FAILED'].includes(error.code))
        return { error: error.message };
    }
    return { error: 'Nothing was changed. Try again.' };
  }
}

async function caller() {
  return pharmacyMedicineRouter.createCaller(await createTRPCContext());
}

export async function readStagedMedicineCreation(batchId: string) {
  return readable(async () => (await caller()).stagedMedicineCreation({ batchId }));
}

export async function requestStagedMedicineCreation(batchId: string) {
  return readable(async () => {
    await (await caller()).createStagedMedicines({ batchId });
    return (await caller()).stagedMedicineCreation({ batchId });
  });
}

export async function runStagedMedicineCreationStep(batchId: string) {
  return readable(async () => (await caller()).runStagedMedicineCreation({ batchId }));
}
