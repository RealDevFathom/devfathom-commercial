import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

// Resolve existing ancestors too: a not-yet-created directory can have a
// symlinked parent. Fail closed on filesystem errors other than absence.
function canonicalLocalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalLocalPath(parent), relative(parent, path));
  }
}

function localUploadRoot(env: Readonly<Record<string, string | undefined>>): string | null {
  const configured = env.LOCAL_UPLOADS_DIR;
  const root = configured === undefined ? resolve('private-uploads') : configured.trim();
  if (
    !root ||
    !isAbsolute(root) ||
    Array.from(root).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    root.split(/[\\/]/).includes('public')
  )
    return null;
  try {
    const canonical = canonicalLocalPath(resolve(root));
    if (canonical === parse(canonical).root || canonical.split(sep).includes('public')) return null;
    for (const path of ['public', '.next/standalone/public']) {
      const fromPublic = relative(canonicalLocalPath(resolve(path)), canonical);
      if (
        !fromPublic ||
        (!fromPublic.startsWith(`..${sep}`) && fromPublic !== '..' && !isAbsolute(fromPublic))
      )
        return null;
    }
    return canonical;
  } catch {
    return null;
  }
}
let blobService: BlobServiceClient | undefined;
let s3Client: S3Client | undefined;

export type StorageUnavailableReason = 'disabled' | 'invalid_configuration';
export type StorageAvailability =
  | { available: true; adapter: 'local'; root: string }
  | { available: true; adapter: 'azure'; account: string; container: string }
  | { available: true; adapter: 's3'; bucket: string; region: string }
  | { available: false; reason: StorageUnavailableReason };

export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';

  constructor(readonly reason: StorageUnavailableReason) {
    super('Storage is unavailable.');
    this.name = 'StorageUnavailableError';
  }
}

/** Local roots are validated on disk; preflight does not certify provider connectivity. */
export function getStorageAvailability(
  env: Readonly<Record<string, string | undefined>> = process.env
): StorageAvailability {
  const adapter = env.STORAGE_ADAPTER?.trim();
  if (!adapter || adapter === 'disabled') return { available: false, reason: 'disabled' };
  if (adapter === 'local' && (env.NODE_ENV === 'test' || env.NODE_ENV === 'development')) {
    const root = localUploadRoot(env);
    return root
      ? { available: true, adapter: 'local', root }
      : { available: false, reason: 'invalid_configuration' };
  }
  if (adapter === 'azure') {
    const account = env.AZURE_STORAGE_ACCOUNT_NAME?.trim();
    const container = env.AZURE_STORAGE_CONTAINER?.trim();
    if (account && container) return { available: true, adapter, account, container };
  }
  if (adapter === 's3') {
    // Credentials come from the runtime (an ECS task role); only the bucket and
    // its region are configuration. Both are required, so a missing region is a
    // configuration error here rather than an SDK error on the first upload.
    const bucket = env.S3_UPLOADS_BUCKET?.trim();
    const region = env.AWS_REGION?.trim();
    if (bucket && region) return { available: true, adapter, bucket, region };
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

/** One object store behind every adapter except the local filesystem. */
type ObjectStore = {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** A missing object rejects with an error whose `statusCode` is 404, as readers expect. */
  get(key: string): Promise<Buffer>;
  /** Idempotent: removing an object that is already gone succeeds. */
  remove(key: string): Promise<void>;
};

/**
 * A missing S3 object, in the shape the readers of getUpload already test for:
 * the local adapter's `ENOENT`, Azure's `BlobNotFound`, or any `statusCode` of 404.
 * The S3 SDK's own error carries neither a `code` nor a `statusCode`, only its
 * `name` and `$metadata.httpStatusCode`, so without this a missing prescription
 * image would read as a server failure instead of "unavailable".
 */
export class StoredObjectMissingError extends Error {
  readonly code = 'NoSuchKey';
  readonly statusCode = 404;

  constructor(options?: { cause?: unknown }) {
    super('Stored object does not exist.', options);
    this.name = 'StoredObjectMissingError';
  }
}

/**
 * S3 reports a missing key as `NoSuchKey` (404) only to a caller allowed to list
 * the bucket; without s3:ListBucket it answers 403, which stays a failure here.
 */
function isMissingS3Object(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return name === 'NoSuchKey' || name === 'NotFound' || $metadata?.httpStatusCode === 404;
}

let blobAccount: string | undefined;
let s3Region: string | undefined;

function azureStore(account: string, name: string): ObjectStore {
  if (!blobService || blobAccount !== account) {
    blobService = new BlobServiceClient(
      `https://${account}.blob.core.windows.net`,
      new DefaultAzureCredential()
    );
    blobAccount = account;
  }
  const blobs = blobService.getContainerClient(name);
  return {
    async put(key, data, contentType) {
      await blobs.getBlockBlobClient(key).uploadData(data, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
    },
    get: (key) => blobs.getBlockBlobClient(key).downloadToBuffer(),
    async remove(key) {
      await blobs.getBlockBlobClient(key).deleteIfExists();
    },
  };
}

function s3Store(bucket: string, region: string): ObjectStore {
  if (!s3Client || s3Region !== region) {
    s3Client = new S3Client({ region });
    s3Region = region;
  }
  const client = s3Client;
  return {
    async put(key, data, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: contentType })
      );
    },
    async get(key) {
      let response;
      try {
        response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (isMissingS3Object(error)) throw new StoredObjectMissingError({ cause: error });
        throw error;
      }
      if (!response.Body) throw new Error('Stored object has no body.');
      return Buffer.from(await response.Body.transformToByteArray());
    },
    async remove(key) {
      // S3 answers a delete of a missing key with success, like deleteIfExists.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

function objectStore(): ObjectStore | string {
  const availability = assertStorageAvailable();
  if (availability.adapter === 'local') return availability.root;
  if (availability.adapter === 's3') return s3Store(availability.bucket, availability.region);
  return azureStore(availability.account, availability.container);
}

export async function putUpload(
  organizationId: string,
  filename: string,
  data: Buffer,
  contentType: string
) {
  const store = objectStore();
  if (typeof store !== 'string') {
    await store.put(`${organizationId}/${filename}`, data, contentType);
    return;
  }

  const directory = join(store, organizationId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), data);
}

export async function getUpload(organizationId: string, filename: string): Promise<Buffer> {
  const store = objectStore();
  if (typeof store !== 'string') return store.get(`${organizationId}/${filename}`);
  return readFile(join(store, organizationId, filename));
}

/**
 * Remove an upload. Idempotent — deleting an object that is already gone is a
 * success, so a retried cleanup (a redelivered job, a re-run purge) does not
 * fail after the first pass. Callers that hold a retention obligation depend on
 * this: WHA-194 deletes a menu-import source on commit, on discard, and when a
 * stale draft is purged, and each of those paths can run twice.
 */
export async function deleteUpload(organizationId: string, filename: string): Promise<void> {
  const store = objectStore();
  if (typeof store !== 'string') {
    await store.remove(`${organizationId}/${filename}`);
    return;
  }
  await rm(join(store, organizationId, filename), { force: true });
}
