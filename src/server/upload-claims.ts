import { TRPCError } from '@trpc/server';

import {
  claimUploadReference,
  UploadReferenceError,
  type UploadOwner,
} from '@/lib/uploads/registry';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-837: accept a client-supplied file reference for `owner` only when it is
 * the caller's own unattached upload (which this binds) or an upload already
 * bound to `owner`. Anything else is a 400 and nothing is written — run it in
 * the same transaction as the owner row so a refusal rolls that row back.
 */
export async function claimUploadOrThrow(
  db: Pick<ScopedDb, 'uploadedFile' | 'uploadedFileLegacyBinding'>,
  ref: string | null | undefined,
  userId: string,
  owner: UploadOwner
): Promise<void> {
  try {
    await claimUploadReference(db, { ref, userId, owner });
  } catch (error) {
    if (error instanceof UploadReferenceError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    }
    throw error;
  }
}
