import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const localRoot = join(process.cwd(), 'private-uploads');
let blobService: BlobServiceClient | undefined;

export type StorageUnavailableReason = 'disabled' | 'invalid_configuration';
export type StorageAvailability =
  | { available: true; adapter: 'local' }
  | { available: true; adapter: 'azure'; account: string; container: string }
  | { available: false; reason: StorageUnavailableReason };

export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';

  constructor(readonly reason: StorageUnavailableReason) {
    super('Storage is unavailable.');
    this.name = 'StorageUnavailableError';
  }
}

/** Pure preflight; availability does not certify provider connectivity. */
export function getStorageAvailability(
  env: Readonly<Record<string, string | undefined>> = process.env
): StorageAvailability {
  const adapter = env.STORAGE_ADAPTER?.trim();
  if (!adapter || adapter === 'disabled') return { available: false, reason: 'disabled' };
  if (adapter === 'local' && (env.NODE_ENV === 'test' || env.NODE_ENV === 'development')) {
    return { available: true, adapter: 'local' };
  }
  if (adapter === 'azure') {
    const account = env.AZURE_STORAGE_ACCOUNT_NAME?.trim();
    const container = env.AZURE_STORAGE_CONTAINER?.trim();
    if (account && container) return { available: true, adapter, account, container };
  }
  return { available: false, reason: 'invalid_configuration' };
}

export function assertStorageAvailable(
  env: Readonly<Record<string, string | undefined>> = process.env
): Extract<StorageAvailability, { available: true }> {
  const availability = getStorageAvailability(env);
  if (!availability.available) throw new StorageUnavailableError(availability.reason);
  return availability;
}

let blobAccount: string | undefined;

function container() {
  const availability = assertStorageAvailable();
  if (availability.adapter === 'local') return null;
  const { account, container: name } = availability;
  if (!blobService || blobAccount !== account) {
    blobService = new BlobServiceClient(
      `https://${account}.blob.core.windows.net`,
      new DefaultAzureCredential()
    );
    blobAccount = account;
  }
  return blobService.getContainerClient(name);
}

export async function putUpload(
  organizationId: string,
  filename: string,
  data: Buffer,
  contentType: string
) {
  const blobs = container();
  if (blobs) {
    await blobs.getBlockBlobClient(`${organizationId}/${filename}`).uploadData(data, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
    return;
  }

  const directory = join(localRoot, organizationId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), data);
}

export async function getUpload(organizationId: string, filename: string): Promise<Buffer> {
  const blobs = container();
  if (blobs) {
    return blobs.getBlockBlobClient(`${organizationId}/${filename}`).downloadToBuffer();
  }
  return readFile(join(localRoot, organizationId, filename));
}

/**
 * Remove an upload. Idempotent — deleting an object that is already gone is a
 * success, so a retried cleanup (a redelivered job, a re-run purge) does not
 * fail after the first pass. Callers that hold a retention obligation depend on
 * this: WHA-194 deletes a menu-import source on commit, on discard, and when a
 * stale draft is purged, and each of those paths can run twice.
 */
export async function deleteUpload(organizationId: string, filename: string): Promise<void> {
  const blobs = container();
  if (blobs) {
    await blobs.getBlockBlobClient(`${organizationId}/${filename}`).deleteIfExists();
    return;
  }
  await rm(join(localRoot, organizationId, filename), { force: true });
}
