import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const localRoot = join(process.cwd(), 'private-uploads');
let blobService: BlobServiceClient | undefined;

function container() {
  const account = process.env.AZURE_STORAGE_ACCOUNT_NAME?.trim();
  if (!account) return null;
  const name = process.env.AZURE_STORAGE_CONTAINER?.trim();
  if (!name) throw new Error('AZURE_STORAGE_CONTAINER is required when Azure storage is enabled.');
  blobService ??= new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    new DefaultAzureCredential()
  );
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
