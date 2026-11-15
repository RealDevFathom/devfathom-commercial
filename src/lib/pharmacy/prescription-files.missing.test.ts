// @vitest-environment node
/**
 * A prescription image that is gone from storage reads as NOT_FOUND ("upload it
 * again") whichever adapter held it, and any other storage failure stays an
 * internal error. The S3 adapter is the case that needed care: the SDK's error
 * has no `code` or `statusCode`, so storage.ts turns a missing key into
 * StoredObjectMissingError, which carries the 404 this reader tests for.
 */
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ getUpload: vi.fn(), putUpload: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  return { ...actual, getUpload: storage.getUpload, putUpload: storage.putUpload };
});

import { StoredObjectMissingError } from '@/lib/storage';
import { loadPrescriptionFile } from './prescription-files';

const reference = '/api/pharmacy/prescription-files?id=0b9d6c2e-1f4a-4c3b-9d2e-7a6b5c4d3e2f';

async function failureCode(error: unknown) {
  storage.getUpload.mockRejectedValueOnce(error);
  const caught = await loadPrescriptionFile('org_pharmacy', reference).catch((e: unknown) => e);
  expect(caught).toBeInstanceOf(TRPCError);
  return (caught as TRPCError).code;
}

describe('loadPrescriptionFile when the stored image is unavailable', () => {
  beforeEach(() => storage.getUpload.mockReset());

  it('reads a missing S3 object as NOT_FOUND', async () => {
    const sdkError = Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    expect(await failureCode(new StoredObjectMissingError({ cause: sdkError }))).toBe('NOT_FOUND');
    expect(storage.getUpload).toHaveBeenCalledWith(
      'org_pharmacy/pharmacy-prescriptions',
      '0b9d6c2e-1f4a-4c3b-9d2e-7a6b5c4d3e2f.json'
    );
  });

  it('reads a missing local object or any 404 as NOT_FOUND, as before', async () => {
    expect(await failureCode(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(
      'NOT_FOUND'
    );
    expect(await failureCode(Object.assign(new Error('gone'), { statusCode: 404 }))).toBe(
      'NOT_FOUND'
    );
  });

  it('keeps any other storage failure an internal error', async () => {
    const denied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    expect(await failureCode(denied)).toBe('INTERNAL_SERVER_ERROR');
  });
});
