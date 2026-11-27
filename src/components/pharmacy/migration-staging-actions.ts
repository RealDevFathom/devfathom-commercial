'use server';

import { unstable_rethrow } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { createTRPCContext } from '@/server/trpc';
import { pharmacyStagedReviewRouter } from '@/server/routers/pharmacy-staged-review';
import type { StagingInput, StagingUploadInput } from '@/lib/pharmacy/migration/staging-input';

async function readable<T>(run: () => Promise<T>) {
  try {
    return { data: await run() };
  } catch (error) {
    unstable_rethrow(error);
    return {
      error:
        error instanceof TRPCError &&
        ['BAD_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)
          ? error.code === 'BAD_REQUEST'
            ? 'Check the file, column mapping, and quantity choice. ' + error.message
            : 'Only a workspace administrator with catalogue edit permission can upload or stage this file. Ask a catalogue editor to submit it for review.'
          : 'The file could not be staged. Try again.',
    };
  }
}

export async function readStagingUpload(input: StagingUploadInput) {
  return readable(async () =>
    pharmacyStagedReviewRouter
      .createCaller(await createTRPCContext())
      .pharmacyMedicine.stagingUpload(input)
  );
}
export async function stageMigrationBatch(input: StagingInput) {
  return readable(async () =>
    pharmacyStagedReviewRouter
      .createCaller(await createTRPCContext())
      .pharmacyMedicine.stageBatch(input)
  );
}
