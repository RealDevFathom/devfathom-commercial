'use server';

import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyMedicineRouter } from '@/server/routers/pharmacy-medicine';
import {
  STAGED_CREATION_BUSY,
  STAGED_CREATION_STOPPED,
  STAGED_CREATION_SYSTEMIC_PREFIX,
} from '@/lib/pharmacy/migration/staged-creation';
import { pharmacyStagedReviewRouter } from '@/server/routers/pharmacy-staged-review';
import { notCreatedList } from './staged-not-created';

/** The plain answers a creation step gives when it stops; any other text stays on the server. */
const STEP_MESSAGES: readonly string[] = [STAGED_CREATION_BUSY, STAGED_CREATION_STOPPED];

/**
 * DEV-912: plain-words result for the bulk creation controls; the server checks every step.
 * DEV-1002: a creation step never answers "Nothing was changed. Try again.": a refused row is
 * recorded and shown on its own, and any other stop says what is kept and what to do next.
 */
async function readable<T>(run: () => Promise<T>, fallback = 'Nothing was changed. Try again.') {
  try {
    return { data: await run() };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TRPCError) {
      if (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
        return { error: 'You need catalogue edit or review permission for this.' };
      if (['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND', 'PRECONDITION_FAILED'].includes(error.code))
        return { error: error.message };
      if (
        STEP_MESSAGES.includes(error.message) ||
        error.message.startsWith(STAGED_CREATION_SYSTEMIC_PREFIX)
      )
        return { error: error.message };
    }
    return { error: fallback };
  }
}

async function caller() {
  return pharmacyMedicineRouter.createCaller(await createTRPCContext());
}

export async function readStagedMedicineCreation(batchId: string) {
  return readable(async () => (await caller()).stagedMedicineCreation({ batchId }));
}

export async function requestStagedMedicineCreation(batchId: string, branchId?: string) {
  return readable(async () => {
    await (await caller()).createStagedMedicines(branchId ? { batchId, branchId } : { batchId });
    return (await caller()).stagedMedicineCreation({ batchId });
  });
}

export async function runStagedMedicineCreationStep(batchId: string) {
  return readable(
    async () => (await caller()).runStagedMedicineCreation({ batchId }),
    STAGED_CREATION_STOPPED
  );
}

/**
 * DEV-1002: the first rows of a staged file that could not be created, with their reasons. Read
 * through the staged review itself (`stagedRows`, filter "not created"), so exactly who may read
 * the review may read these rows.
 */
export async function readNotCreatedStagedRows(selection: {
  branchId: string;
  sourceId: string;
  batchId: string;
}) {
  return readable(async () => {
    const result = await pharmacyStagedReviewRouter
      .createCaller(await createTRPCContext())
      .pharmacyMedicine.stagedRows({ ...selection, filter: 'not-created', page: 1 });
    return notCreatedList(result);
  });
}
